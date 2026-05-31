import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";

const pluginRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const script = path.join(pluginRoot, "scripts", "codex-cli-bus.mjs");
const mcpServer = path.join(pluginRoot, "scripts", "mcp-server.mjs");

function tempBus() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-bus-"));
}

function run(busHome, args, input = null) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      CODEX_CLI_BUS_HOME: busHome
    },
    input,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function runFail(busHome, args, input = null) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      CODEX_CLI_BUS_HOME: busHome
    },
    input,
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  return JSON.parse(result.stderr.trim());
}

test("register, list, send, claim, and reply", () => {
  const bus = tempBus();
  try {
    const cliA = run(bus, ["register", "--agent", "cli-a", "--label", "controller"]);
    const cliB = run(bus, ["register", "--agent", "cli-b", "--label", "worker"]);
    assert.equal(cliA.agent.agent_id, "cli-a");
    assert.equal(cliB.agent.agent_id, "cli-b");

    const listed = run(bus, ["list"]);
    assert.equal(listed.count, 2);

    const sent = run(bus, ["send", "--from", "cli-a", "--to", "cli-b", "--type", "task", "--text", "Run the focused test suite"]);
    assert.equal(sent.message.type, "task");
    assert.match(sent.message.task_id, /^task_/);

    const peeked = run(bus, ["poll", "--agent", "cli-b"]);
    assert.equal(peeked.count, 1);
    assert.equal(peeked.messages[0].status, "queued");

    const claimed = run(bus, ["poll", "--agent", "cli-b", "--claim"]);
    assert.equal(claimed.count, 1);
    assert.equal(claimed.messages[0].status, "delivered");

    const taskRunning = run(bus, ["status", "--task", sent.message.task_id]);
    assert.equal(taskRunning.task.status, "running");

    const reply = run(bus, ["reply", "--from", "cli-b", "--message", sent.message.id, "--text", "Focused tests passed"]);
    assert.equal(reply.message.to, "cli-a");
    assert.equal(reply.message.parent_id, sent.message.id);

    const taskDone = run(bus, ["status", "--task", sent.message.task_id]);
    assert.equal(taskDone.task.status, "completed");

    const parentInbox = run(bus, ["poll", "--agent", "cli-a", "--claim"]);
    assert.equal(parentInbox.count, 1);
    assert.equal(parentInbox.messages[0].type, "result");
  } finally {
    fs.rmSync(bus, { recursive: true, force: true });
  }
});

test("stdin messages and event filtering work", () => {
  const bus = tempBus();
  try {
    run(bus, ["register", "--agent", "cli-a"]);
    run(bus, ["register", "--agent", "cli-b"]);
    const sent = run(bus, ["send", "--from", "cli-a", "--to", "cli-b", "--type", "message", "--stdin"], "hello from stdin\n");
    assert.equal(sent.message.payload.text, "hello from stdin");

    const events = run(bus, ["events", "--agent", "cli-b", "--limit", "10"]);
    assert.ok(events.count >= 1);
    assert.ok(events.events.some((event) => event.message_id === sent.message.id));
  } finally {
    fs.rmSync(bus, { recursive: true, force: true });
  }
});

test("launch-codex creates an interactive launch script without opening terminal", () => {
  const bus = tempBus();
  try {
    run(bus, ["register", "--agent", "cli-a"]);
    const launched = run(bus, [
      "launch-codex",
      "--from",
      "cli-a",
      "--agent",
      "cli-ui",
      "--workspace",
      pluginRoot,
      "--text",
      "Run npm test and reply"
    ]);
    assert.equal(launched.launched.initial_message.to, "cli-a.cli-ui");
    assert.equal(launched.launched.open_terminal, false);
    assert.ok(fs.existsSync(launched.launched.launch_script));
    assert.ok(fs.existsSync(launched.launched.prompt_file));
    const scriptText = fs.readFileSync(launched.launched.launch_script, "utf8");
    assert.match(scriptText, /exec 'codex' '--cd'/);
    assert.match(scriptText, /CODEX_AGENT_ID='cli-a.cli-ui'/);

    const reserved = run(bus, ["status", "--agent", "cli-ui", "--viewer", "cli-a"]);
    assert.equal(reserved.agent.owner_agent_id, "cli-a");
    assert.equal(reserved.agent.parent_agent_id, "cli-a");
    assert.equal(reserved.agent.local_agent_id, "cli-ui");
    assert.equal(reserved.agent.liveness, "reserved");
    const reservedIndexFile = path.join(bus, "agents", "ownership", "cli-a", "children.json");
    assert.ok(fs.existsSync(reservedIndexFile));
    assert.deepEqual(JSON.parse(fs.readFileSync(reservedIndexFile, "utf8")).child_agent_ids, ["cli-a.cli-ui"]);

    const denied = runFail(bus, ["send", "--from", "cli-a2", "--to", "cli-a.cli-ui", "--type", "task", "--text", "steal"]);
    assert.match(denied.error, /owned by cli-a/);
  } finally {
    fs.rmSync(bus, { recursive: true, force: true });
  }
});

test("worker-loop claims a queued task and replies automatically", () => {
  const bus = tempBus();
  try {
    run(bus, ["register", "--agent", "cli-a"]);
    run(bus, ["send", "--from", "cli-a", "--to", "cli-b", "--type", "task", "--text", "Say hello"]);

    const worker = run(bus, [
      "worker-loop",
      "--agent",
      "cli-b",
      "--owner",
      "cli-a",
      "--workspace",
      pluginRoot,
      "--once",
      "--",
      "/bin/echo",
      "worker-completed"
    ]);
    assert.equal(worker.result.handled, 1);

    const tasks = run(bus, ["tasks", "--agent", "cli-b", "--viewer", "cli-a"]);
    assert.equal(tasks.tasks[0].status, "completed");

    const parentInbox = run(bus, ["poll", "--agent", "cli-a", "--claim"]);
    assert.equal(parentInbox.count, 1);
    assert.equal(parentInbox.messages[0].type, "result");
    assert.match(parentInbox.messages[0].payload.text, /worker-completed/);
  } finally {
    fs.rmSync(bus, { recursive: true, force: true });
  }
});

test("start-worker reuses an online worker with the same agent id", () => {
  const bus = tempBus();
  try {
    run(bus, [
      "register",
      "--agent",
      "cli-b",
      "--owner",
      "cli-a",
      "--parent",
      "cli-a",
      "--pid",
      String(process.pid),
      "--metadata",
      "{\"mode\":\"worker-loop\"}"
    ]);

    const started = run(bus, [
      "start-worker",
      "--from",
      "cli-a",
      "--agent",
      "cli-b",
      "--workspace",
      pluginRoot
    ]);
    assert.equal(started.started.mode, "reused");
    assert.equal(started.started.reused, true);
    assert.equal(started.started.agent.agent_id, "cli-a.cli-b");
    assert.equal(started.started.agent.local_agent_id, "cli-b");
    assert.ok(fs.existsSync(path.join(bus, "agents", "ownership", "cli-a", "children.json")));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bus, "agents", "ownership", "cli-a", "children.json"), "utf8")).child_agent_ids, ["cli-a.cli-b"]);
  } finally {
    fs.rmSync(bus, { recursive: true, force: true });
  }
});

test("start-worker rejects implicit fallback variants for the same owner", () => {
  const bus = tempBus();
  try {
    run(bus, [
      "register",
      "--agent",
      "eth-price-cli",
      "--owner",
      "controller",
      "--parent",
      "controller",
      "--pid",
      String(process.pid),
      "--metadata",
      "{\"mode\":\"worker-loop\"}"
    ]);

    const denied = runFail(bus, [
      "start-worker",
      "--from",
      "controller",
      "--agent",
      "eth-price-cli-default",
      "--workspace",
      pluginRoot
    ]);
    assert.match(denied.error, /fallback variant/);
    assert.match(denied.error, /--replace/);

    const allowed = run(bus, [
      "start-worker",
      "--from",
      "controller",
      "--agent",
      "eth-price-cli-default",
      "--workspace",
      pluginRoot,
      "--allow-variant"
    ]);
    assert.equal(allowed.started.mode, "daemon");
    const stopped = run(bus, ["stop-agent", "--from", "controller", "--agent", "eth-price-cli-default", "--reason", "test cleanup"]);
    assert.equal(stopped.stopped.terminated, true);
  } finally {
    fs.rmSync(bus, { recursive: true, force: true });
  }
});

test("owned child agents only accept tasks from their owner", () => {
  const bus = tempBus();
  try {
    run(bus, [
      "register",
      "--agent",
      "cli-b",
      "--owner",
      "cli-a",
      "--parent",
      "cli-a",
      "--pid",
      String(process.pid),
      "--metadata",
      "{\"mode\":\"worker-loop\"}"
    ]);

    const allowed = run(bus, ["send", "--from", "cli-a", "--to", "cli-b", "--type", "task", "--text", "owner task"]);
    assert.equal(allowed.message.to, "cli-a.cli-b");

    const separateLocal = run(bus, ["send", "--from", "cli-a2", "--to", "cli-b", "--type", "task", "--text", "other owner local task"]);
    assert.equal(separateLocal.message.to, "cli-a2.cli-b");

    const denied = runFail(bus, ["send", "--from", "cli-a2", "--to", "cli-a.cli-b", "--type", "task", "--text", "wrong owner"]);
    assert.equal(denied.ok, false);
    assert.match(denied.error, /owned by cli-a/);
  } finally {
    fs.rmSync(bus, { recursive: true, force: true });
  }
});

test("owned child agents are scoped for status, tasks, events, polling, and replies", () => {
  const bus = tempBus();
  try {
    run(bus, ["register", "--agent", "cli-a"]);
    run(bus, ["register", "--agent", "cli-a2"]);
    run(bus, [
      "register",
      "--agent",
      "cli-b",
      "--owner",
      "cli-a",
      "--parent",
      "cli-a",
      "--pid",
      String(process.pid),
      "--metadata",
      "{\"mode\":\"worker-loop\"}"
    ]);

    const ownerList = run(bus, ["list", "--viewer", "cli-a"]);
    assert.ok(ownerList.agents.some((agent) => agent.agent_id === "cli-a.cli-b" && agent.local_agent_id === "cli-b"));
    assert.ok(ownerList.agents.find((agent) => agent.agent_id === "cli-a").children_agent_ids.includes("cli-a.cli-b"));
    assert.ok(ownerList.agents.find((agent) => agent.agent_id === "cli-a").children_local_agent_ids.includes("cli-b"));

    const childList = run(bus, ["list", "--owner", "cli-a", "--viewer", "cli-a"]);
    assert.deepEqual(childList.agents.map((agent) => agent.agent_id), ["cli-a.cli-b"]);
    assert.deepEqual(childList.agents.map((agent) => agent.local_agent_id), ["cli-b"]);

    const otherList = run(bus, ["list", "--viewer", "cli-a2"]);
    assert.ok(!otherList.agents.some((agent) => agent.agent_id === "cli-a.cli-b"));
    assert.ok(!otherList.agents.find((agent) => agent.agent_id === "cli-a").children_agent_ids.includes("cli-a.cli-b"));

    const otherLocalStatus = run(bus, ["status", "--agent", "cli-b", "--viewer", "cli-a2"]);
    assert.equal(otherLocalStatus.ok, false);
    const explicitStatusDenied = runFail(bus, ["status", "--agent", "cli-a.cli-b", "--viewer", "cli-a2"]);
    assert.match(explicitStatusDenied.error, /owned by cli-a/);

    const sent = run(bus, ["send", "--from", "cli-a", "--to", "cli-b", "--type", "task", "--text", "owner-only work"]);
    assert.equal(sent.message.to, "cli-a.cli-b");
    const ownerTasks = run(bus, ["tasks", "--viewer", "cli-a"]);
    assert.ok(ownerTasks.tasks.some((task) => task.task_id === sent.message.task_id));
    const otherTasks = run(bus, ["tasks", "--viewer", "cli-a2"]);
    assert.ok(!otherTasks.tasks.some((task) => task.task_id === sent.message.task_id));

    const ownerPeek = run(bus, ["poll", "--agent", "cli-b", "--from", "cli-a"]);
    assert.equal(ownerPeek.count, 1);
    const ownerClaimDenied = runFail(bus, ["poll", "--agent", "cli-b", "--from", "cli-a", "--claim"]);
    assert.match(ownerClaimDenied.error, /only cli-a\.cli-b can claim/);

    run(bus, ["poll", "--agent", "cli-a.cli-b", "--claim"]);
    const spoofedReply = runFail(bus, ["reply", "--from", "cli-a2", "--message", sent.message.id, "--text", "fake"]);
    assert.match(spoofedReply.error, /belongs to cli-a\.cli-b/);

    run(bus, ["reply", "--from", "cli-a.cli-b", "--message", sent.message.id, "--text", "done"]);
    const ownerEvents = run(bus, ["events", "--viewer", "cli-a", "--limit", "20"]);
    assert.ok(ownerEvents.events.some((event) => event.message_id === sent.message.id));
    const otherEvents = run(bus, ["events", "--viewer", "cli-a2", "--limit", "20"]);
    assert.ok(!otherEvents.events.some((event) => event.message_id === sent.message.id));
  } finally {
    fs.rmSync(bus, { recursive: true, force: true });
  }
});

test("different controllers can each own a local child with the same name", () => {
  const bus = tempBus();
  try {
    run(bus, ["register", "--agent", "cli-a"]);
    run(bus, ["register", "--agent", "cli-c"]);
    const childA = run(bus, [
      "register",
      "--agent",
      "cli-b",
      "--owner",
      "cli-a",
      "--parent",
      "cli-a",
      "--pid",
      String(process.pid),
      "--metadata",
      "{\"mode\":\"worker-loop\"}"
    ]);
    const childC = run(bus, [
      "register",
      "--agent",
      "cli-b",
      "--owner",
      "cli-c",
      "--parent",
      "cli-c",
      "--pid",
      String(process.pid),
      "--metadata",
      "{\"mode\":\"worker-loop\"}"
    ]);

    assert.equal(childA.agent.agent_id, "cli-a.cli-b");
    assert.equal(childA.agent.local_agent_id, "cli-b");
    assert.equal(childC.agent.agent_id, "cli-c.cli-b");
    assert.equal(childC.agent.local_agent_id, "cli-b");

    const sentA = run(bus, ["send", "--from", "cli-a", "--to", "cli-b", "--type", "task", "--text", "task for a child"]);
    const sentC = run(bus, ["send", "--from", "cli-c", "--to", "cli-b", "--type", "task", "--text", "task for c child"]);
    assert.equal(sentA.message.to, "cli-a.cli-b");
    assert.equal(sentC.message.to, "cli-c.cli-b");

    const peekA = run(bus, ["poll", "--agent", "cli-b", "--from", "cli-a"]);
    const peekC = run(bus, ["poll", "--agent", "cli-b", "--from", "cli-c"]);
    assert.equal(peekA.count, 1);
    assert.equal(peekA.messages[0].id, sentA.message.id);
    assert.equal(peekC.count, 1);
    assert.equal(peekC.messages[0].id, sentC.message.id);

    const denied = runFail(bus, ["send", "--from", "cli-c", "--to", "cli-a.cli-b", "--type", "task", "--text", "cross-owner"]);
    assert.match(denied.error, /owned by cli-a/);

    const indexA = JSON.parse(fs.readFileSync(path.join(bus, "agents", "ownership", "cli-a", "children.json"), "utf8"));
    const indexC = JSON.parse(fs.readFileSync(path.join(bus, "agents", "ownership", "cli-c", "children.json"), "utf8"));
    assert.deepEqual(indexA.children, [{ agent_id: "cli-a.cli-b", local_agent_id: "cli-b" }]);
    assert.deepEqual(indexC.children, [{ agent_id: "cli-c.cli-b", local_agent_id: "cli-b" }]);
  } finally {
    fs.rmSync(bus, { recursive: true, force: true });
  }
});

test("install-plugin writes a local marketplace-backed plugin", () => {
  const bus = tempBus();
  const marketplaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-bus-marketplace-"));
  try {
    const installed = run(bus, [
      "install-plugin",
      "--marketplace-root",
      marketplaceRoot,
      "--marketplace-name",
      "bus-test",
      "--no-codex"
    ]);
    assert.equal(installed.codex_skipped, true);
    assert.equal(installed.marketplace_name, "bus-test");
    assert.equal(installed.plugin_selector, "codex-cli-bus@bus-test");

    const marketplace = JSON.parse(fs.readFileSync(path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), "utf8"));
    assert.equal(marketplace.name, "bus-test");
    assert.equal(marketplace.plugins[0].name, "codex-cli-bus");
    assert.equal(marketplace.plugins[0].source.path, "./plugins/codex-cli-bus");

    const pluginDir = path.join(marketplaceRoot, "plugins", "codex-cli-bus");
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, ".codex-plugin", "plugin.json"), "utf8"));
    const mcp = JSON.parse(fs.readFileSync(path.join(pluginDir, ".mcp.json"), "utf8"));
    assert.equal(manifest.name, "codex-cli-bus");
    assert.equal(manifest.mcpServers, "./.mcp.json");
    assert.equal(mcp.mcpServers["codex-cli-bus"].command, process.execPath);
    assert.match(mcp.mcpServers["codex-cli-bus"].args[0], /scripts\/mcp-server\.mjs$/);
    assert.equal(mcp.mcpServers["codex-cli-bus"].env.CODEX_CLI_BUS_HOME, bus);
    assert.ok(fs.existsSync(path.join(pluginDir, "skills", "cli-bus", "SKILL.md")));
  } finally {
    fs.rmSync(bus, { recursive: true, force: true });
    fs.rmSync(marketplaceRoot, { recursive: true, force: true });
  }
});

test("mcp server exposes natural-language agent tools", () => {
  const bus = tempBus();
  try {
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "register_agent",
          arguments: { agent_id: "cli-a", bus_home: bus }
        }
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "send_task",
          arguments: { from: "cli-a", to: "cli-b", text: "Check status", bus_home: bus }
        }
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "start_worker_agent",
          arguments: { from: "cli-a", agent_id: "model-worker", model: "gpt-5", bus_home: bus }
        }
      }
    ].map((message) => JSON.stringify(message)).join("\n");

    const result = spawnSync(process.execPath, [mcpServer], {
      cwd: pluginRoot,
      env: process.env,
      input: `${input}\n`,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    const responses = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(responses[0].result.serverInfo.name, "codex-cli-bus");
    assert.ok(responses[1].result.tools.some((tool) => tool.name === "launch_codex_agent"));
    assert.ok(responses[1].result.tools.some((tool) => tool.name === "start_worker_agent"));
    assert.match(responses[3].result.content[0].text, /"type": "task"/);
    assert.match(responses[4].error.message, /model_requested_by_user/);
    assert.equal(fs.existsSync(path.join(bus, "agents", "records", "model-worker.json")), false);
  } finally {
    fs.rmSync(bus, { recursive: true, force: true });
  }
});
