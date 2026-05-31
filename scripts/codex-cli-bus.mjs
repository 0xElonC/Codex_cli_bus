#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = "1.0";
const PLUGIN_NAME = "codex-cli-bus";
const DEFAULT_MARKETPLACE_NAME = "codex-cli-bus-local";
const DEFAULT_STALE_MS = 120_000;
const VALID_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,79}$/;
const VALID_AGENT_STATUS = new Set([
  "idle",
  "running",
  "waiting_for_user",
  "waiting_for_agent",
  "blocked",
  "completed",
  "failed",
  "exited",
  "unknown"
]);
const VALID_TASK_STATUS = new Set([
  "queued",
  "running",
  "waiting_for_user",
  "waiting_for_agent",
  "blocked",
  "completed",
  "failed",
  "cancelled"
]);
const VALID_MESSAGE_TYPES = new Set([
  "task",
  "message",
  "result",
  "error",
  "cancel",
  "status_request",
  "status_response",
  "heartbeat",
  "ack"
]);
const VARIANT_AGENT_SUFFIXES = ["default", "fallback", "retry"];

function nowIso() {
  return new Date().toISOString();
}

function compactTimestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "");
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

function scriptPath() {
  return fileURLToPath(import.meta.url);
}

function realPathOrResolve(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function isCliEntrypoint() {
  return Boolean(process.argv[1]) && realPathOrResolve(process.argv[1]) === realPathOrResolve(scriptPath());
}

function packageRoot() {
  return path.resolve(path.dirname(scriptPath()), "..");
}

function defaultBusHome() {
  return path.join(os.homedir(), ".codex-cli-bus");
}

function getBusHome(opts = {}) {
  return path.resolve(String(option(opts, "bus-home", "bus_home") || process.env.CODEX_CLI_BUS_HOME || defaultBusHome()));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function ensureBus(root) {
  for (const dir of ["agents", "agents/records", "agents/ownership", "mailboxes", "tasks", "events", "logs", "tmp"]) {
    ensureDir(path.join(root, dir));
  }
  migrateAgentLayout(root);
}

function assertAgentId(agentId, label = "agent id") {
  if (!agentId || !VALID_AGENT_ID.test(agentId)) {
    throw new Error(`${label} must match ${VALID_AGENT_ID.source}`);
  }
  return agentId;
}

function isQualifiedAgentId(agentId) {
  return String(agentId).includes(".");
}

function namespaceAgentId(ownerId, localAgentId) {
  const owner = assertAgentId(String(ownerId), "owner id");
  const local = assertAgentId(String(localAgentId), "local agent id");
  if (isQualifiedAgentId(local) || local === owner) {
    return local;
  }
  return assertAgentId(`${owner}.${local}`, "namespaced agent id");
}

function localAgentIdFor(agentId, ownerId = null) {
  const id = assertAgentId(String(agentId));
  if (ownerId) {
    const prefix = `${ownerId}.`;
    if (id.startsWith(prefix)) {
      return id.slice(prefix.length);
    }
  }
  return id.includes(".") ? id.slice(id.lastIndexOf(".") + 1) : id;
}

function normalizeLocalAgentId(agentId, ownerId = null, explicitLocalAgentId = null) {
  return assertAgentId(String(explicitLocalAgentId || localAgentIdFor(agentId, ownerId)), "local_agent_id");
}

function assertStatus(status, validSet, label) {
  if (!validSet.has(status)) {
    throw new Error(`${label} must be one of: ${Array.from(validSet).join(", ")}`);
  }
  return status;
}

function jsonFile(file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`failed to read JSON ${file}: ${error.message}`);
  }
}

function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tempFile = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tempFile, file);
}

function copyDirSync(source, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });
}

function appendJsonLine(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function agentFile(root, agentId) {
  return path.join(root, "agents", "records", `${assertAgentId(agentId)}.json`);
}

function legacyAgentFile(root, agentId) {
  return path.join(root, "agents", `${assertAgentId(agentId)}.json`);
}

function ownerIndexRoot(root) {
  return path.join(root, "agents", "ownership");
}

function ownerChildrenFile(root, ownerId) {
  return path.join(ownerIndexRoot(root), assertAgentId(ownerId, "owner id"), "children.json");
}

function readOwnerChildrenIndex(root, ownerId) {
  return jsonFile(ownerChildrenFile(root, ownerId));
}

function taskFile(root, taskId) {
  return path.join(root, "tasks", `${taskId}.json`);
}

function mailboxDir(root, agentId, box) {
  return path.join(root, "mailboxes", assertAgentId(agentId), box);
}

function messageFile(root, agentId, box, message) {
  return path.join(mailboxDir(root, agentId, box), `${compactTimestamp()}-${message.id}.json`);
}

function eventFile(root) {
  return path.join(root, "events", "events.jsonl");
}

function option(opts, ...names) {
  for (const name of names) {
    if (Object.hasOwn(opts, name)) {
      return opts[name];
    }
  }
  return undefined;
}

function boolOption(opts, ...names) {
  const value = option(opts, ...names);
  if (value === undefined) {
    return false;
  }
  if (value === true) {
    return true;
  }
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function numberOption(opts, fallback, ...names) {
  const raw = option(opts, ...names);
  if (raw === undefined || raw === true || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${names[0]} must be a number`);
  }
  return value;
}

function parseJsonOption(opts, ...names) {
  const raw = option(opts, ...names);
  if (raw === undefined || raw === true || raw === "") {
    return undefined;
  }
  try {
    return JSON.parse(String(raw));
  } catch (error) {
    throw new Error(`${names[0]} must be valid JSON: ${error.message}`);
  }
}

function approvalOption(opts) {
  const value = option(opts, "approval", "ask-for-approval");
  if (value === undefined || value === true || value === "") {
    return undefined;
  }
  return String(value);
}

function readText(opts, positionals, label = "text") {
  if (boolOption(opts, "stdin")) {
    return fs.readFileSync(0, "utf8").trim();
  }
  const explicit = option(opts, "text", "message", "task");
  if (explicit !== undefined && explicit !== true) {
    return String(explicit);
  }
  if (positionals.length > 0) {
    return positionals.join(" ");
  }
  throw new Error(`missing ${label}; pass --text, --stdin, or positional text`);
}

function currentAgent(opts, field = "agent") {
  const value = option(opts, field) || process.env.CODEX_AGENT_ID;
  return value ? assertAgentId(String(value), field) : null;
}

function requiredAgent(opts, field = "agent") {
  const agentId = currentAgent(opts, field);
  if (!agentId) {
    throw new Error(`missing --${field} or CODEX_AGENT_ID`);
  }
  return agentId;
}

function parseArgv(argv) {
  let command = null;
  const opts = {};
  const positionals = [];
  let commandArgs = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      commandArgs = argv.slice(index + 1);
      break;
    }
    if (arg.startsWith("--")) {
      const equalIndex = arg.indexOf("=");
      let key;
      let value;
      if (equalIndex > 2) {
        key = arg.slice(2, equalIndex);
        value = arg.slice(equalIndex + 1);
      } else {
        key = arg.slice(2);
        if (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
          value = argv[index + 1];
          index += 1;
        } else {
          value = true;
        }
      }
      if (Object.hasOwn(opts, key)) {
        opts[key] = Array.isArray(opts[key]) ? [...opts[key], value] : [opts[key], value];
      } else {
        opts[key] = value;
      }
    } else {
      if (!command) {
        command = arg;
      } else {
        positionals.push(arg);
      }
    }
  }

  return { command: command || "help", opts, positionals, commandArgs };
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellJoin(args) {
  return args.map(shellQuote).join(" ");
}

function appendCodexOptions(command, input) {
  if (input.model) {
    command.push("--model", input.model);
  }
  if (input.profile) {
    command.push("--profile", input.profile);
  }
  if (input.sandbox) {
    command.push("--sandbox", input.sandbox);
  }
  return command;
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return "unknown";
  }
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return error.code === "EPERM" ? "alive" : "exited";
  }
}

function agentPid(agent) {
  return Number(agent?.process?.pid || agent?.pid);
}

function sameProcess(agent, pid) {
  return Number.isInteger(pid) && pid > 0 && agentPid(agent) === pid;
}

function isOnlineAgent(agent) {
  return agent?.liveness === "online";
}

function isWorkerLoopAgent(agent) {
  return agent?.metadata?.mode === "worker-loop" || (agent?.process?.command || []).includes("worker-loop");
}

function isReservedAgent(agent) {
  return agent?.metadata?.mode === "reserved-child";
}

function agentRecordMtime(root, agentId, legacy = false) {
  const file = legacy ? legacyAgentFile(root, agentId) : agentFile(root, agentId);
  if (!fs.existsSync(file)) {
    return 0;
  }
  return fs.statSync(file).mtimeMs;
}

function newerAgentRecord(root, agentId, left, right) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  const leftSeen = Date.parse(left.last_seen_at || left.created_at || "");
  const rightSeen = Date.parse(right.last_seen_at || right.created_at || "");
  if (Number.isFinite(leftSeen) && Number.isFinite(rightSeen) && leftSeen !== rightSeen) {
    return leftSeen > rightSeen ? left : right;
  }
  return agentRecordMtime(root, agentId, false) >= agentRecordMtime(root, agentId, true) ? left : right;
}

function mergeAgentRecords(root, agentId, current, legacy) {
  const selected = newerAgentRecord(root, agentId, current, legacy);
  const fallback = selected === current ? legacy : current;
  if (!selected || !fallback) {
    return selected;
  }
  const merged = {
    ...selected,
    owner_agent_id: selected.owner_agent_id || fallback.owner_agent_id || null,
    parent_agent_id: selected.parent_agent_id || fallback.parent_agent_id || selected.owner_agent_id || fallback.owner_agent_id || null,
    label: selected.label || fallback.label || selected.agent_id,
    process: {
      ...(fallback.process || {}),
      ...(selected.process || {})
    },
    metadata: {
      ...(fallback.metadata || {}),
      ...(selected.metadata || {})
    }
  };
  if (!merged.process.command && fallback.process?.command) {
    merged.process.command = fallback.process.command;
  }
  if (!merged.process.started_at && fallback.process?.started_at) {
    merged.process.started_at = fallback.process.started_at;
  }
  return merged;
}

function readAllAgentRecords(root) {
  const dir = path.join(root, "agents", "records");
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => jsonFile(path.join(dir, file)))
    .filter(Boolean);
}

function writeOwnerChildrenIndex(root, ownerId, childIds) {
  const children = childIds.map((child) => typeof child === "string"
    ? { agent_id: child, local_agent_id: localAgentIdFor(child, ownerId) }
    : {
        agent_id: assertAgentId(String(child.agent_id), "child agent id"),
        local_agent_id: normalizeLocalAgentId(child.agent_id, ownerId, child.local_agent_id)
      }).sort((left, right) => left.local_agent_id.localeCompare(right.local_agent_id) || left.agent_id.localeCompare(right.agent_id));
  writeJsonAtomic(ownerChildrenFile(root, ownerId), {
    protocol_version: PROTOCOL_VERSION,
    owner_agent_id: ownerId,
    child_agent_ids: children.map((child) => child.agent_id),
    child_local_agent_ids: children.map((child) => child.local_agent_id),
    children,
    updated_at: nowIso()
  });
}

function normalizeAgentRecords(root) {
  for (const agent of readAllAgentRecords(root)) {
    const ownerAgentId = agent.owner_agent_id || null;
    const localAgentId = normalizeLocalAgentId(agent.agent_id, ownerAgentId, agent.local_agent_id);
    if (agent.local_agent_id === localAgentId) {
      continue;
    }
    writeJsonAtomic(agentFile(root, agent.agent_id), {
      ...agent,
      local_agent_id: localAgentId
    });
  }
}

function syncOwnershipIndexes(root) {
  const indexRoot = ownerIndexRoot(root);
  ensureDir(indexRoot);
  const byOwner = new Map();
  for (const agent of readAllAgentRecords(root)) {
    if (!agent.owner_agent_id) {
      continue;
    }
    const children = byOwner.get(agent.owner_agent_id) || new Map();
    children.set(agent.agent_id, {
      agent_id: agent.agent_id,
      local_agent_id: agent.local_agent_id || localAgentIdFor(agent.agent_id, agent.owner_agent_id)
    });
    byOwner.set(agent.owner_agent_id, children);
  }

  for (const entry of fs.readdirSync(indexRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !byOwner.has(entry.name)) {
      fs.rmSync(path.join(indexRoot, entry.name), { recursive: true, force: true });
    }
  }
  for (const [ownerId, children] of byOwner) {
    writeOwnerChildrenIndex(root, ownerId, Array.from(children.values()));
  }
}

function removeLegacyOwnerCopies(root) {
  const oldRoot = path.join(root, "agents", "by-owner");
  if (fs.existsSync(oldRoot)) {
    fs.rmSync(oldRoot, { recursive: true, force: true });
  }
}

function migrateAgentLayout(root) {
  const agentsRoot = path.join(root, "agents");
  const recordsRoot = path.join(agentsRoot, "records");
  if (!fs.existsSync(agentsRoot)) {
    return;
  }
  ensureDir(recordsRoot);
  for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const legacyFile = path.join(agentsRoot, entry.name);
    const legacy = jsonFile(legacyFile);
    if (!legacy?.agent_id) {
      continue;
    }
    const agentId = assertAgentId(legacy.agent_id);
    const current = jsonFile(agentFile(root, agentId));
    writeJsonAtomic(agentFile(root, agentId), mergeAgentRecords(root, agentId, current, legacy));
    fs.unlinkSync(legacyFile);
  }
  removeLegacyOwnerCopies(root);
  normalizeAgentRecords(root);
  syncOwnershipIndexes(root);
}

function baseAgentIdForVariant(agentId) {
  const id = assertAgentId(agentId);
  for (const suffix of VARIANT_AGENT_SUFFIXES) {
    const marker = `-${suffix}`;
    if (id.endsWith(marker) && id.length > marker.length) {
      const baseId = id.slice(0, -marker.length);
      if (VALID_AGENT_ID.test(baseId)) {
        return baseId;
      }
    }
  }
  return null;
}

function ensureNoImplicitVariant(root, input) {
  if (input.allow_variant) {
    return;
  }
  const ownerId = input.from ? assertAgentId(String(input.from), "from") : null;
  if (!ownerId) {
    return;
  }
  const baseAgentIds = [];
  const directBaseAgentId = baseAgentIdForVariant(input.agent_id);
  if (directBaseAgentId) {
    baseAgentIds.push(directBaseAgentId);
  }
  const localBaseAgentId = baseAgentIdForVariant(localAgentIdFor(input.agent_id, ownerId));
  if (localBaseAgentId) {
    baseAgentIds.push(resolveAgentReference(root, localBaseAgentId, ownerId));
  }
  if (baseAgentIds.length === 0) {
    return;
  }
  for (const baseAgentId of [...new Set(baseAgentIds)]) {
    const baseAgent = jsonFile(agentFile(root, baseAgentId));
    if (!baseAgent || baseAgent.owner_agent_id !== ownerId || !isWorkerLoopAgent(baseAgent)) {
      continue;
    }
    const decorated = decorateAgent(root, baseAgent);
    if (isOnlineAgent(decorated)) {
      throw new Error(`agent ${input.agent_id} looks like a fallback variant of online ${baseAgentId}; reuse ${baseAgentId} or start it with --replace instead of creating a second CLI. Pass --allow-variant only if you intentionally want two workers.`);
    }
  }
}

function syncAgentOwnerIndex(root, record) {
  syncOwnershipIndexes(root);
}

function resolveAgentReference(root, agentId, ownerId = null, input = {}) {
  const id = assertAgentId(String(agentId));
  if (!ownerId || isQualifiedAgentId(id) || id === ownerId) {
    return id;
  }
  const owner = assertAgentId(String(ownerId), "owner id");
  const index = readOwnerChildrenIndex(root, owner);
  const indexed = (index?.children || [])
    .find((child) => child.local_agent_id === id || child.agent_id === id);
  if (indexed?.agent_id && jsonFile(agentFile(root, indexed.agent_id))) {
    return assertAgentId(String(indexed.agent_id), "indexed agent id");
  }
  const scoped = namespaceAgentId(owner, id);
  const scopedAgent = jsonFile(agentFile(root, scoped));
  if (scopedAgent) {
    return scoped;
  }
  const legacyAgent = jsonFile(agentFile(root, id));
  if (legacyAgent) {
    if (legacyAgent.owner_agent_id === owner || legacyAgent.parent_agent_id === owner) {
      return id;
    }
    if (!legacyAgent.owner_agent_id && input.prefer_existing_unowned) {
      return id;
    }
    if (!legacyAgent.owner_agent_id && input.adopt_legacy) {
      return id;
    }
  }
  return input.create_scoped ? scoped : id;
}

function ensureAgentController(root, agent, controllerId, action, options = {}) {
  if (!agent || !controllerId) {
    return agent;
  }
  const controller = assertAgentId(String(controllerId), "controller");
  if (agent.agent_id === controller) {
    return agent;
  }
  const owner = agent.owner_agent_id || null;
  if (owner && owner !== controller) {
    throw new Error(`agent ${agent.agent_id} is owned by ${owner}; ${controller} cannot ${action}`);
  }
  if (!owner && options.adopt) {
    const updated = {
      ...agent,
      owner_agent_id: controller,
      parent_agent_id: agent.parent_agent_id || controller,
      local_agent_id: normalizeLocalAgentId(agent.agent_id, controller, agent.local_agent_id),
      metadata: {
        ...(agent.metadata || {}),
        owner_adopted_at: nowIso()
      }
    };
    writeJsonAtomic(agentFile(root, agent.agent_id), updated);
    syncAgentOwnerIndex(root, updated);
    appendEvent(root, {
      type: "agent_owner_adopted",
      agent_id: agent.agent_id,
      detail: {
        owner_agent_id: controller,
        action
      }
    });
    return updated;
  }
  return agent;
}

function agentIsControlledBy(root, agentId, controllerId) {
  if (!agentId || !controllerId) {
    return false;
  }
  if (typeof agentId === "string" && agentId === controllerId) {
    return true;
  }
  const agent = typeof agentId === "object" ? agentId : jsonFile(agentFile(root, agentId));
  if (!agent) {
    return false;
  }
  return agent.agent_id === controllerId || agent.owner_agent_id === controllerId || agent.parent_agent_id === controllerId;
}

function canViewAgent(root, agent, viewerId) {
  if (!viewerId || !agent) {
    return true;
  }
  if (agent.agent_id === viewerId) {
    return true;
  }
  if (!agent.owner_agent_id) {
    return true;
  }
  return agentIsControlledBy(root, agent, viewerId);
}

function ensureAgentVisible(root, agent, viewerId, action) {
  if (!viewerId || !agent || canViewAgent(root, agent, viewerId)) {
    return agent;
  }
  throw new Error(`agent ${agent.agent_id} is owned by ${agent.owner_agent_id}; ${viewerId} cannot ${action}`);
}

function childAgentIds(root, agentId, viewerId = null) {
  return childAgents(root, agentId, viewerId).map((agent) => agent.agent_id);
}

function childAgents(root, agentId, viewerId = null) {
  const dir = path.join(root, "agents", "records");
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => jsonFile(path.join(dir, file)))
    .filter((agent) => agent && (agent.owner_agent_id === agentId || agent.parent_agent_id === agentId))
    .filter((agent) => canViewAgent(root, agent, viewerId))
    .sort((left, right) => left.agent_id.localeCompare(right.agent_id));
}

function taskVisibleToController(root, task, viewerId) {
  if (!viewerId || !task) {
    return true;
  }
  return [task.originator, task.assignee].some((agentId) => agentIsControlledBy(root, agentId, viewerId));
}

function ensureTaskVisible(root, task, viewerId, action) {
  if (!viewerId || taskVisibleToController(root, task, viewerId)) {
    return task;
  }
  throw new Error(`task ${task.task_id} is not owned by ${viewerId}; ${viewerId} cannot ${action}`);
}

function eventVisibleToController(root, event, viewerId) {
  if (!viewerId) {
    return true;
  }
  const agentIds = [event.agent_id, event.from, event.to].filter(Boolean);
  return agentIds.some((agentId) => agentIsControlledBy(root, agentId, viewerId));
}

function terminateAgentProcess(root, agent, reason) {
  const pid = agentPid(agent);
  if (!Number.isInteger(pid) || pid <= 0 || processAlive(pid) !== "alive") {
    return false;
  }
  process.kill(pid, "SIGTERM");
  appendEvent(root, {
    type: "agent_terminated",
    agent_id: agent.agent_id,
    detail: { pid, reason }
  });
  return true;
}

function stopAgent(root, input) {
  ensureBus(root);
  const controllerId = input.from ? assertAgentId(String(input.from), "from") : null;
  const agentId = resolveAgentReference(root, input.agent_id, controllerId, {
    prefer_existing_unowned: true
  });
  const agent = jsonFile(agentFile(root, agentId));
  if (!agent) {
    throw new Error(`agent not found: ${agentId}`);
  }
  if (controllerId) {
    ensureAgentController(root, agent, controllerId, `stop ${agentId}`);
  }
  const now = nowIso();
  const terminated = terminateAgentProcess(root, decorateAgent(root, agent), input.reason || "stop requested");
  const stopped = {
    ...agent,
    status: "exited",
    current_task: null,
    last_seen_at: now,
    process: {
      ...(agent.process || {}),
      exit_code: agent.process?.exit_code ?? null
    },
    metadata: {
      ...(agent.metadata || {}),
      stopped_at: now,
      stopped_by: input.from || null,
      stop_reason: input.reason || "stop requested"
    }
  };
  writeJsonAtomic(agentFile(root, agentId), stopped);
  syncAgentOwnerIndex(root, stopped);
  appendEvent(root, {
    type: "agent_stopped",
    agent_id: agentId,
    from: input.from || undefined,
    detail: { terminated, reason: input.reason || "stop requested" }
  });
  return { agent: stopped, terminated };
}

function appendEvent(root, event) {
  const record = {
    protocol_version: PROTOCOL_VERSION,
    event_id: makeId("evt"),
    type: event.type,
    created_at: nowIso(),
    ...event
  };
  appendJsonLine(eventFile(root), record);
  return record;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function registerAgent(root, input) {
  ensureBus(root);
  const now = nowIso();
  const rawAgentId = assertAgentId(input.agent_id);
  const requestedOwnerId = input.owner_agent_id ? assertAgentId(String(input.owner_agent_id), "owner_agent_id") : null;
  const agentId = requestedOwnerId
    ? resolveAgentReference(root, rawAgentId, requestedOwnerId, { create_scoped: true })
    : rawAgentId;
  const existing = jsonFile(agentFile(root, agentId));
  const status = assertStatus(input.status || existing?.status || "idle", VALID_AGENT_STATUS, "agent status");
  const workspace = path.resolve(input.workspace || existing?.workspace || process.cwd());
  const pid = input.pid === undefined ? process.pid : Number(input.pid);
  const ownerAgentId = requestedOwnerId || existing?.owner_agent_id || null;
  const parentAgentId = input.parent_agent_id ? assertAgentId(String(input.parent_agent_id), "parent_agent_id") : existing?.parent_agent_id || ownerAgentId || null;
  const existingDecorated = existing ? decorateAgent(root, existing) : null;
  if (existing && ownerAgentId) {
    ensureAgentController(root, existing, ownerAgentId, "register replacement", { adopt: !existing.owner_agent_id });
  }
  const duplicatePolicy = input.duplicate_policy || "replace-stale";
  const isSameProcess = sameProcess(existing, pid);
  const replacingReservation = existingDecorated && isReservedAgent(existingDecorated) && ownerAgentId && existingDecorated.owner_agent_id === ownerAgentId;
  if (existingDecorated && isOnlineAgent(existingDecorated) && !isSameProcess && !replacingReservation && duplicatePolicy !== "replace" && duplicatePolicy !== "reuse") {
    throw new Error(`agent ${agentId} is already online as pid ${agentPid(existingDecorated)}; use a different agent id or pass --replace`);
  }
  if (existingDecorated && isOnlineAgent(existingDecorated) && !isSameProcess && !replacingReservation && duplicatePolicy === "reuse") {
    appendEvent(root, {
      type: "agent_reused",
      agent_id: agentId,
      detail: {
        existing_pid: agentPid(existingDecorated),
        requested_pid: pid,
        status: existingDecorated.status
      }
    });
    return existingDecorated;
  }
  const replacingExisting = Boolean(existing && !isSameProcess);
  const record = {
    protocol_version: PROTOCOL_VERSION,
    agent_id: agentId,
    local_agent_id: normalizeLocalAgentId(agentId, ownerAgentId, input.local_agent_id || existing?.local_agent_id),
    session_id: input.session_id || (replacingExisting ? makeId("sess") : existing?.session_id) || makeId("sess"),
    owner_agent_id: ownerAgentId,
    parent_agent_id: parentAgentId,
    label: input.label || existing?.label || agentId,
    pid,
    process: {
      pid,
      command: input.command || existing?.process?.command || null,
      started_at: input.started_at || (replacingExisting ? now : existing?.process?.started_at) || now,
      exit_code: null
    },
    workspace,
    cwd: path.resolve(input.cwd || process.cwd()),
    status,
    current_task: input.current_task === undefined ? existing?.current_task || null : input.current_task,
    created_at: existing?.created_at || now,
    last_seen_at: now,
    metadata: input.metadata || existing?.metadata || {}
  };

  ensureDir(mailboxDir(root, agentId, "inbox"));
  ensureDir(mailboxDir(root, agentId, "processing"));
  ensureDir(mailboxDir(root, agentId, "archive"));
  writeJsonAtomic(agentFile(root, agentId), record);
  syncAgentOwnerIndex(root, record);
  appendEvent(root, {
    type: existing ? (replacingExisting ? "agent_replaced" : "agent_updated") : "agent_registered",
    agent_id: agentId,
    detail: {
      status,
      pid,
      previous_pid: existing ? agentPid(existing) : null,
      session_id: record.session_id,
      owner_agent_id: record.owner_agent_id,
      parent_agent_id: record.parent_agent_id
    }
  });
  return record;
}

function reserveChildAgent(root, input) {
  ensureBus(root);
  const rawAgentId = assertAgentId(input.agent_id);
  const ownerAgentId = input.from ? assertAgentId(String(input.from), "from") : null;
  if (!ownerAgentId) {
    return null;
  }
  const agentId = resolveAgentReference(root, rawAgentId, ownerAgentId, { create_scoped: true });
  const localAgentId = normalizeLocalAgentId(agentId, ownerAgentId, input.local_agent_id || localAgentIdFor(rawAgentId, ownerAgentId));
  const existing = jsonFile(agentFile(root, agentId));
  if (existing) {
    return ensureAgentController(root, existing, ownerAgentId, `reserve ${agentId}`, {
      adopt: isWorkerLoopAgent(existing)
    });
  }
  return registerAgent(root, {
    agent_id: agentId,
    local_agent_id: localAgentId,
    label: input.label || agentId,
    workspace: input.workspace || process.cwd(),
    status: "waiting_for_agent",
    pid: 0,
    command: null,
    owner_agent_id: ownerAgentId,
    parent_agent_id: input.parent_agent_id || ownerAgentId,
    metadata: {
      mode: "reserved-child",
      reserved_by: ownerAgentId,
      reserved_for: input.reserved_for || "worker",
      reserved_at: nowIso()
    },
    duplicate_policy: "replace"
  });
}

function heartbeatAgent(root, input) {
  ensureBus(root);
  const ownerAgentId = input.owner_agent_id ? assertAgentId(String(input.owner_agent_id), "owner_agent_id") : null;
  const agentId = ownerAgentId
    ? resolveAgentReference(root, input.agent_id, ownerAgentId, { prefer_existing_unowned: true })
    : assertAgentId(input.agent_id);
  const existing = jsonFile(agentFile(root, agentId));
  if (!existing) {
    return registerAgent(root, {
      ...input,
      agent_id: agentId,
      owner_agent_id: ownerAgentId || input.owner_agent_id
    });
  }
  const status = assertStatus(input.status || existing.status || "idle", VALID_AGENT_STATUS, "agent status");
  const record = {
    ...existing,
    status,
    pid: input.pid === undefined ? existing.pid : Number(input.pid),
    last_seen_at: nowIso(),
    current_task: input.current_task === undefined ? existing.current_task || null : input.current_task,
    metadata: input.metadata ? { ...(existing.metadata || {}), ...input.metadata } : existing.metadata || {}
  };
  writeJsonAtomic(agentFile(root, agentId), record);
  syncAgentOwnerIndex(root, record);
  appendEvent(root, { type: "agent_heartbeat", agent_id: agentId, detail: { status } });
  return record;
}

function readAgents(root, staleMs = DEFAULT_STALE_MS, input = {}) {
  ensureBus(root);
  const viewerId = input.visible_to ? assertAgentId(String(input.visible_to), "visible_to") : null;
  const ownerId = input.owner_agent_id ? assertAgentId(String(input.owner_agent_id), "owner_agent_id") : null;
  const records = readAllAgentRecords(root)
    .filter((agent) => !ownerId || agent.owner_agent_id === ownerId || agent.parent_agent_id === ownerId)
    .filter((agent) => canViewAgent(root, agent, viewerId))
    .map((agent) => decorateAgent(root, agent, staleMs, { visible_to: viewerId }));
  return records.sort((left, right) => left.agent_id.localeCompare(right.agent_id));
}

function agentLiveness(agent, staleMs = DEFAULT_STALE_MS) {
  const lastSeen = Date.parse(agent.last_seen_at || "");
  const lastSeenAgeMs = Number.isFinite(lastSeen) ? Date.now() - lastSeen : null;
  const heartbeatFresh = lastSeenAgeMs !== null && lastSeenAgeMs <= staleMs;
  const pid = Number(agent.process?.pid || agent.pid);
  const processState = processAlive(pid);
  const liveness = agent.status === "exited"
    ? "exited"
    : isReservedAgent(agent)
    ? "reserved"
    : heartbeatFresh || processState === "alive" ? "online" : processState === "exited" ? "exited" : "stale";
  return { liveness, processState, lastSeenAgeMs };
}

function decorateAgent(root, agent, staleMs = DEFAULT_STALE_MS, input = {}) {
  const viewerId = input.visible_to ? assertAgentId(String(input.visible_to), "visible_to") : null;
  const { liveness, processState, lastSeenAgeMs } = agentLiveness(agent, staleMs);
  const children = childAgents(root, agent.agent_id, viewerId);

  return {
    ...agent,
    liveness,
    process_state: processState,
    last_seen_age_ms: lastSeenAgeMs,
    children_agent_ids: children.map((child) => child.agent_id),
    children_local_agent_ids: children.map((child) => child.local_agent_id || localAgentIdFor(child.agent_id, agent.agent_id)),
    children: children.map((child) => ({
      agent_id: child.agent_id,
      local_agent_id: child.local_agent_id || localAgentIdFor(child.agent_id, agent.agent_id),
      status: child.status,
      liveness: agentLiveness(child, staleMs).liveness
    })),
    queued_messages: countMailbox(root, agent.agent_id, "inbox"),
    processing_messages: countMailbox(root, agent.agent_id, "processing")
  };
}

function countMailbox(root, agentId, box) {
  const dir = mailboxDir(root, agentId, box);
  if (!fs.existsSync(dir)) {
    return 0;
  }
  return fs.readdirSync(dir).filter((file) => file.endsWith(".json")).length;
}

function readMailbox(root, agentId, box) {
  const dir = mailboxDir(root, agentId, box);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const fullPath = path.join(dir, file);
      return {
        file: fullPath,
        message: jsonFile(fullPath)
      };
    })
    .filter((entry) => entry.message);
}

function sendMessage(root, input) {
  ensureBus(root);
  const from = assertAgentId(input.from, "from");
  const fromAgent = jsonFile(agentFile(root, from));
  const scopeOwnerId = fromAgent?.owner_agent_id || from;
  const to = resolveAgentReference(root, input.to, scopeOwnerId, {
    create_scoped: true,
    prefer_existing_unowned: true
  });
  const type = input.type || "message";
  if (!VALID_MESSAGE_TYPES.has(type)) {
    throw new Error(`message type must be one of: ${Array.from(VALID_MESSAGE_TYPES).join(", ")}`);
  }
  const targetAgent = jsonFile(agentFile(root, to));
  ensureAgentController(root, targetAgent, from, `send ${type} to ${to}`, {
    adopt: targetAgent ? isWorkerLoopAgent(targetAgent) : false
  });
  const now = nowIso();
  const conversationId = input.conversation_id || makeId("conv");
  const taskId = input.task_id || (type === "task" ? makeId("task") : null);
  const payload = input.payload || {};
  const message = {
    protocol_version: PROTOCOL_VERSION,
    id: makeId("msg"),
    conversation_id: conversationId,
    parent_id: input.parent_id || null,
    task_id: taskId,
    from,
    to,
    type,
    payload,
    created_at: now,
    timeout_ms: input.timeout_ms || null,
    status: "queued",
    delivery: {
      state: "queued"
    }
  };

  writeJsonAtomic(messageFile(root, to, "inbox", message), message);
  appendEvent(root, {
    type: "message_sent",
    from,
    to,
    message_id: message.id,
    task_id: taskId || undefined,
    conversation_id: conversationId,
    detail: { message_type: type }
  });

  if (type === "task" && taskId) {
    const task = {
      protocol_version: PROTOCOL_VERSION,
      task_id: taskId,
      conversation_id: conversationId,
      originator: from,
      assignee: to,
      status: "queued",
      objective: String(payload.objective || payload.text || ""),
      message_id: message.id,
      created_at: now,
      updated_at: now
    };
    writeJsonAtomic(taskFile(root, taskId), task);
    appendEvent(root, {
      type: "task_created",
      from,
      to,
      message_id: message.id,
      task_id: taskId,
      conversation_id: conversationId,
      detail: { objective: task.objective }
    });
  }

  return message;
}

function claimMessages(root, agentId, limit, typeFilter) {
  const now = nowIso();
  const inbox = readMailbox(root, agentId, "inbox")
    .filter(({ message }) => !typeFilter || message.type === typeFilter)
    .slice(0, limit);
  const claimed = [];

  for (const entry of inbox) {
    const message = {
      ...entry.message,
      status: "delivered",
      delivery: {
        ...(entry.message.delivery || {}),
        state: "claimed",
        claimed_by: agentId,
        claimed_at: now
      }
    };
    const destination = messageFile(root, agentId, "processing", message);
    writeJsonAtomic(destination, message);
    fs.unlinkSync(entry.file);
    claimed.push(message);
    appendEvent(root, {
      type: "message_claimed",
      agent_id: agentId,
      from: message.from,
      to: message.to,
      message_id: message.id,
      task_id: message.task_id || undefined,
      conversation_id: message.conversation_id
    });
    if (message.task_id && message.type === "task") {
      updateTask(root, message.task_id, {
        status: "running",
        updated_at: now
      });
      heartbeatAgent(root, {
        agent_id: agentId,
        status: "running",
        current_task: {
          task_id: message.task_id,
          summary: String(message.payload?.objective || message.payload?.text || ""),
          started_at: now
        }
      });
    }
  }

  return claimed;
}

function pollMessages(root, input) {
  ensureBus(root);
  const requesterId = input.requester_agent_id ? assertAgentId(String(input.requester_agent_id), "requester_agent_id") : null;
  const agentId = resolveAgentReference(root, input.agent_id, requesterId, {
    prefer_existing_unowned: true
  });
  const limit = input.limit || 10;
  const typeFilter = input.type || null;
  if (requesterId && requesterId !== agentId) {
    const agent = jsonFile(agentFile(root, agentId));
    ensureAgentVisible(root, agent, requesterId, `inspect mailbox for ${agentId}`);
    if (input.claim) {
      throw new Error(`only ${agentId} can claim messages for ${agentId}; ${requesterId} can inspect status but not claim its mailbox`);
    }
  }
  if (input.claim) {
    return claimMessages(root, agentId, limit, typeFilter);
  }
  return readMailbox(root, agentId, "inbox")
    .filter(({ message }) => !typeFilter || message.type === typeFilter)
    .slice(0, limit)
    .map(({ message }) => message);
}

function findMessageById(root, messageId) {
  ensureBus(root);
  const mailboxesRoot = path.join(root, "mailboxes");
  if (!fs.existsSync(mailboxesRoot)) {
    return null;
  }
  for (const agentId of fs.readdirSync(mailboxesRoot)) {
    if (!VALID_AGENT_ID.test(agentId)) {
      continue;
    }
    for (const box of ["inbox", "processing", "archive"]) {
      const entries = readMailbox(root, agentId, box);
      for (const entry of entries) {
        if (entry.message.id === messageId) {
          return {
            agent_id: agentId,
            box,
            file: entry.file,
            message: entry.message
          };
        }
      }
    }
  }
  return null;
}

function archiveMessage(root, location, status) {
  if (!location) {
    return null;
  }
  const message = {
    ...location.message,
    status,
    delivery: {
      ...(location.message.delivery || {}),
      archived_at: nowIso()
    }
  };
  const destination = path.join(mailboxDir(root, location.agent_id, "archive"), `${message.id}.json`);
  writeJsonAtomic(destination, message);
  if (location.file !== destination && fs.existsSync(location.file)) {
    fs.unlinkSync(location.file);
  }
  return message;
}

function updateTask(root, taskId, patch) {
  const file = taskFile(root, taskId);
  const existing = jsonFile(file);
  if (!existing) {
    return null;
  }
  const status = patch.status || existing.status;
  assertStatus(status, VALID_TASK_STATUS, "task status");
  const task = {
    ...existing,
    ...patch,
    status,
    updated_at: patch.updated_at || nowIso()
  };
  writeJsonAtomic(file, task);
  appendEvent(root, {
    type: "task_updated",
    from: task.originator,
    to: task.assignee,
    task_id: task.task_id,
    conversation_id: task.conversation_id,
    detail: { status: task.status }
  });
  return task;
}

function replyToMessage(root, input) {
  ensureBus(root);
  const from = assertAgentId(input.from, "from");
  const location = findMessageById(root, input.message_id);
  if (!location) {
    throw new Error(`message not found: ${input.message_id}`);
  }
  const original = location.message;
  if (from !== location.agent_id || from !== original.to) {
    throw new Error(`message ${original.id} belongs to ${original.to}; ${from} cannot reply to it`);
  }
  const type = input.type || "result";
  const message = sendMessage(root, {
    from,
    to: input.to || original.from,
    type,
    conversation_id: original.conversation_id,
    parent_id: original.id,
    task_id: original.task_id,
    payload: input.payload
  });

  if (original.task_id && (type === "result" || type === "error")) {
    const status = type === "result" ? "completed" : "failed";
    updateTask(root, original.task_id, {
      status,
      completed_at: nowIso(),
      summary: String(input.payload?.summary || input.payload?.text || ""),
      result_message_id: type === "result" ? message.id : undefined,
      error_message_id: type === "error" ? message.id : undefined
    });
    heartbeatAgent(root, {
      agent_id: from,
      status,
      current_task: null
    });
    archiveMessage(root, location, status);
  }

  appendEvent(root, {
    type: "message_replied",
    from,
    to: message.to,
    message_id: message.id,
    task_id: message.task_id || undefined,
    conversation_id: message.conversation_id,
    detail: { parent_id: original.id, message_type: type }
  });
  return message;
}

function listTasks(root, input = {}) {
  ensureBus(root);
  const dir = path.join(root, "tasks");
  if (!fs.existsSync(dir)) {
    return [];
  }
  const visibleTo = input.visible_to ? assertAgentId(String(input.visible_to), "visible_to") : null;
  const agentId = input.agent_id ? resolveAgentReference(root, input.agent_id, visibleTo, {
    prefer_existing_unowned: true
  }) : null;
  const tasks = fs.readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => jsonFile(path.join(dir, file)))
    .filter(Boolean)
    .filter((task) => !agentId || task.originator === agentId || task.assignee === agentId)
    .filter((task) => taskVisibleToController(root, task, visibleTo))
    .filter((task) => !input.status || task.status === input.status)
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
  return input.limit ? tasks.slice(0, input.limit) : tasks;
}

function readEvents(root, input = {}) {
  ensureBus(root);
  const file = eventFile(root);
  if (!fs.existsSync(file)) {
    return [];
  }
  const visibleTo = input.visible_to ? assertAgentId(String(input.visible_to), "visible_to") : null;
  const agentId = input.agent_id ? resolveAgentReference(root, input.agent_id, visibleTo, {
    prefer_existing_unowned: true
  }) : null;
  const conversationId = input.conversation_id || null;
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const events = lines.map((line) => JSON.parse(line)).filter((event) => {
    if (agentId && ![event.agent_id, event.from, event.to].includes(agentId)) {
      return false;
    }
    if (conversationId && event.conversation_id !== conversationId) {
      return false;
    }
    if (!eventVisibleToController(root, event, visibleTo)) {
      return false;
    }
    return true;
  });
  const limit = input.limit || 50;
  return events.slice(Math.max(0, events.length - limit));
}

function buildCodexBootstrapPrompt(input) {
  const busScript = scriptPath();
  const pollCommand = `node ${JSON.stringify(busScript)} poll --agent ${input.agent_id} --claim`;
  const replyCommand = `node ${JSON.stringify(busScript)} reply --from ${input.agent_id} --message ${input.message_id} --text "<summary>"`;
  return [
    `You are Codex CLI Bus agent "${input.agent_id}".`,
    "",
    "Use the local Codex CLI Bus to coordinate with the parent agent.",
    `Bus home: ${input.bus_home}`,
    `Incoming task message id: ${input.message_id}`,
    "",
    "First, inspect the task message if needed:",
    pollCommand,
    "",
    "Work on this objective:",
    input.task_text,
    "",
    "When finished, send the result back with:",
    replyCommand,
    "",
    "If blocked, reply with --type error and describe the blocker. Keep status current with heartbeat if the work is long-running."
  ].join("\n");
}

function spawnProcess(root, input) {
  ensureBus(root);
  if (!input.command || input.command.length === 0) {
    throw new Error("spawn requires a command after --");
  }
  const rawAgentId = assertAgentId(input.agent_id);
  const ownerAgentId = input.owner_agent_id || input.from || null;
  const agentId = ownerAgentId
    ? resolveAgentReference(root, rawAgentId, ownerAgentId, { create_scoped: true })
    : rawAgentId;
  const localAgentId = normalizeLocalAgentId(agentId, ownerAgentId, input.local_agent_id || localAgentIdFor(rawAgentId, ownerAgentId));
  const workspace = path.resolve(input.workspace || process.cwd());
  ensureDir(path.join(root, "logs"));
  const stdoutPath = path.join(root, "logs", `${agentId}.out.log`);
  const stderrPath = path.join(root, "logs", `${agentId}.err.log`);
  const stdout = fs.openSync(stdoutPath, "a");
  const stderr = fs.openSync(stderrPath, "a");
  const child = spawn(input.command[0], input.command.slice(1), {
    cwd: workspace,
    detached: true,
    stdio: ["ignore", stdout, stderr],
    env: {
      ...process.env,
      CODEX_AGENT_ID: agentId,
      CODEX_CLI_BUS_HOME: root
    }
  });
  child.unref();

  const agent = registerAgent(root, {
    agent_id: agentId,
    local_agent_id: localAgentId,
    label: input.label || agentId,
    workspace,
    status: "running",
    pid: child.pid,
    command: input.command,
    owner_agent_id: ownerAgentId,
    parent_agent_id: input.parent_agent_id || ownerAgentId,
    duplicate_policy: input.duplicate_policy,
    metadata: {
      spawned_by: input.from || process.env.CODEX_AGENT_ID || "user",
      stdout: stdoutPath,
      stderr: stderrPath
    }
  });

  return {
    agent,
    pid: child.pid,
    stdout: stdoutPath,
    stderr: stderrPath,
    command: input.command
  };
}

function spawnCodex(root, input) {
  const reserved = reserveChildAgent(root, {
    agent_id: input.agent_id,
    from: input.from,
    label: input.label || input.agent_id,
    workspace: input.workspace || process.cwd(),
    reserved_for: "spawn-codex"
  });
  const agentId = reserved?.agent_id || resolveAgentReference(root, input.agent_id, input.from, { create_scoped: true });
  const taskMessage = sendMessage(root, {
    from: input.from,
    to: agentId,
    type: "task",
    payload: {
      text: input.task_text,
      objective: input.task_text
    },
    timeout_ms: input.timeout_ms
  });
  const prompt = buildCodexBootstrapPrompt({
    agent_id: agentId,
    message_id: taskMessage.id,
    task_text: input.task_text,
    bus_home: root
  });
  const command = ["codex", "exec", "--skip-git-repo-check", "--cd", path.resolve(input.workspace || process.cwd())];
  appendCodexOptions(command, input);
  command.push(prompt);
  const spawned = spawnProcess(root, {
    agent_id: agentId,
    local_agent_id: reserved?.local_agent_id || normalizeLocalAgentId(agentId, input.from, input.local_agent_id || localAgentIdFor(input.agent_id, input.from)),
    from: input.from,
    label: input.label || input.agent_id,
    workspace: input.workspace || process.cwd(),
    command
  });
  return {
    ...spawned,
    initial_message: taskMessage,
    bootstrap_prompt: prompt
  };
}

function codexInteractiveCommand(input) {
  const command = ["codex", "--cd", path.resolve(input.workspace || process.cwd())];
  appendCodexOptions(command, input);
  command.push("$(cat \"$PROMPT_FILE\")");
  return command;
}

function writeLaunchScript(root, input) {
  const agentId = assertAgentId(input.agent_id);
  const workspace = path.resolve(input.workspace || process.cwd());
  const tmpDir = path.join(root, "tmp");
  ensureDir(tmpDir);
  const promptPath = path.join(tmpDir, `${agentId}-${compactTimestamp()}-prompt.txt`);
  const scriptFile = path.join(tmpDir, `${agentId}-${compactTimestamp()}-launch.sh`);
  const metadata = {
    launched_by: input.from,
    mode: "interactive-codex",
    prompt_file: promptPath
  };

  fs.writeFileSync(promptPath, input.prompt);
  const command = codexInteractiveCommand(input);
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `export CODEX_CLI_BUS_HOME=${shellQuote(root)}`,
    `export CODEX_AGENT_ID=${shellQuote(agentId)}`,
    `PROMPT_FILE=${shellQuote(promptPath)}`,
    `cd ${shellQuote(workspace)}`,
    shellJoin([
      process.execPath,
      scriptPath(),
      "register",
      "--agent",
      agentId,
      "--label",
      input.label || agentId,
      "--workspace",
      workspace,
      "--status",
      "running",
      "--pid",
      "$$",
      "--owner",
      input.from || "",
      "--parent",
      input.from || "",
      "--metadata",
      JSON.stringify(metadata)
    ]).replace("'$$'", "$$"),
    `exec ${command.slice(0, -1).map(shellQuote).join(" ")} "$(cat "$PROMPT_FILE")"`
  ].join("\n");

  fs.writeFileSync(scriptFile, `${script}\n`);
  fs.chmodSync(scriptFile, 0o755);
  return {
    prompt_file: promptPath,
    launch_script: scriptFile,
    shell_command: `/bin/bash ${shellQuote(scriptFile)}`
  };
}

function openTerminal(command) {
  const appleScript = [
    "tell application \"Terminal\"",
    `  do script ${appleScriptString(command)}`,
    "  activate",
    "end tell"
  ].join("\n");
  const child = spawn("osascript", ["-e", appleScript], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return child.pid;
}

function launchCodex(root, input) {
  ensureBus(root);
  const rawAgentId = assertAgentId(input.agent_id);
  const ownerAgentId = input.from ? assertAgentId(String(input.from), "from") : null;
  const agentId = ownerAgentId
    ? resolveAgentReference(root, rawAgentId, ownerAgentId, { create_scoped: true })
    : rawAgentId;
  const localAgentId = normalizeLocalAgentId(agentId, ownerAgentId, input.local_agent_id || localAgentIdFor(rawAgentId, ownerAgentId));
  const workspace = path.resolve(input.workspace || process.cwd());
  const existing = jsonFile(agentFile(root, agentId));
  const controlledExisting = existing && ownerAgentId
    ? ensureAgentController(root, existing, ownerAgentId, `start worker ${agentId}`, { adopt: isWorkerLoopAgent(existing) })
    : existing;
  const existingDecorated = controlledExisting ? decorateAgent(root, controlledExisting) : null;
  if (existingDecorated && isOnlineAgent(existingDecorated)) {
    if (isWorkerLoopAgent(existingDecorated) && !input.replace) {
      const taskMessage = sendMessage(root, {
        from: ownerAgentId,
        to: agentId,
        type: "task",
        payload: {
          text: input.task_text,
          objective: input.task_text
        },
        timeout_ms: input.timeout_ms
      });
      appendEvent(root, {
        type: "codex_launch_reused_worker",
        from: ownerAgentId,
        to: agentId,
        message_id: taskMessage.id,
        task_id: taskMessage.task_id,
        conversation_id: taskMessage.conversation_id,
        detail: { pid: agentPid(existingDecorated) }
      });
      return {
        reused: true,
        mode: "reused-worker",
        agent: existingDecorated,
        initial_message: taskMessage,
        reason: `agent ${agentId} already has an online worker-loop`
      };
    }
    if (!input.replace) {
      throw new Error(`agent ${agentId} is already online as pid ${agentPid(existingDecorated)}; use a different agent id or pass --replace`);
    }
    terminateAgentProcess(root, existingDecorated, "replace requested for launch-codex");
  }
  reserveChildAgent(root, {
    agent_id: agentId,
    from: ownerAgentId,
    local_agent_id: localAgentId,
    label: input.label || rawAgentId,
    workspace,
    reserved_for: "launch-codex"
  });
  const taskMessage = sendMessage(root, {
    from: ownerAgentId,
    to: agentId,
    type: "task",
    payload: {
      text: input.task_text,
      objective: input.task_text
    },
    timeout_ms: input.timeout_ms
  });
  const prompt = buildCodexBootstrapPrompt({
    agent_id: agentId,
    message_id: taskMessage.id,
    task_text: input.task_text,
    bus_home: root
  });
  const launch = writeLaunchScript(root, {
    ...input,
    agent_id: agentId,
    local_agent_id: localAgentId,
    prompt
  });
  let terminalPid = null;
  if (input.open_terminal) {
    terminalPid = openTerminal(launch.shell_command);
    appendEvent(root, {
      type: "codex_terminal_launched",
      from: ownerAgentId,
      to: agentId,
      message_id: taskMessage.id,
      task_id: taskMessage.task_id,
      conversation_id: taskMessage.conversation_id,
      detail: {
        launch_script: launch.launch_script,
        terminal_pid: terminalPid
      }
    });
  }
  return {
    initial_message: taskMessage,
    bootstrap_prompt: prompt,
    ...launch,
    open_terminal: Boolean(input.open_terminal),
    terminal_pid: terminalPid
  };
}

function buildWorkerTaskPrompt(input) {
  const text = String(input.message.payload?.objective || input.message.payload?.text || "");
  return [
    `You are Codex CLI Bus worker "${input.agent_id}".`,
    "",
    "You are executing a delegated task from another local Codex CLI agent.",
    "Work autonomously and return a concise final result. Do not call codex-cli-bus reply tools yourself; the worker wrapper will send your final response back to the parent agent.",
    "",
    `Bus home: ${input.bus_home}`,
    `Message id: ${input.message.id}`,
    `Task id: ${input.message.task_id || "none"}`,
    `From: ${input.message.from}`,
    "",
    "Task:",
    text,
    "",
    "If you cannot complete the task, clearly state the blocker and what input or permission is missing."
  ].join("\n");
}

function workerCommand(input, prompt, outputFile) {
  if (input.executor_command?.length) {
    return [...input.executor_command, prompt];
  }

  const command = [
    "codex",
    "exec",
    "--skip-git-repo-check",
    "--cd",
    input.workspace,
    "--output-last-message",
    outputFile
  ];
  appendCodexOptions(command, input);
  command.push(prompt);
  return command;
}

function executeWorkerTask(root, input) {
  const agentId = assertAgentId(input.agent_id);
  const message = input.message;
  const workspace = path.resolve(input.workspace || process.cwd());
  const timestamp = compactTimestamp();
  const runId = `${agentId}-${message.id}-${timestamp}`;
  const logDir = path.join(root, "logs");
  const tmpDir = path.join(root, "tmp");
  ensureDir(logDir);
  ensureDir(tmpDir);

  const outputFile = path.join(tmpDir, `${runId}-last-message.txt`);
  const prompt = buildWorkerTaskPrompt({
    agent_id: agentId,
    bus_home: root,
    message
  });
  const command = workerCommand({
    ...input,
    workspace
  }, prompt, outputFile);

  appendEvent(root, {
    type: "worker_task_started",
    agent_id: agentId,
    from: message.from,
    to: message.to,
    message_id: message.id,
    task_id: message.task_id || undefined,
    conversation_id: message.conversation_id,
    detail: { command: command[0], workspace }
  });
  heartbeatAgent(root, {
    agent_id: agentId,
    status: "running",
    current_task: {
      task_id: message.task_id || null,
      summary: String(message.payload?.objective || message.payload?.text || ""),
      started_at: nowIso()
    },
    metadata: { mode: "worker-loop", workspace }
  });

  const result = spawnSync(command[0], command.slice(1), {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_AGENT_ID: agentId,
      CODEX_CLI_BUS_HOME: root
    },
    encoding: "utf8",
    maxBuffer: input.max_buffer || 20 * 1024 * 1024
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  fs.appendFileSync(path.join(logDir, `${agentId}.worker.out.log`), stdout);
  fs.appendFileSync(path.join(logDir, `${agentId}.worker.err.log`), stderr);

  const finalText = fs.existsSync(outputFile)
    ? fs.readFileSync(outputFile, "utf8").trim()
    : stdout.trim();
  const exitCode = result.status ?? 1;
  const signal = result.signal || null;
  const success = exitCode === 0 && finalText.length > 0;
  const replyText = success
    ? finalText
    : [
        finalText || "Worker failed before producing a final response.",
        stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
        signal ? `signal: ${signal}` : "",
        `exit_code: ${exitCode}`
      ].filter(Boolean).join("\n\n");

  const reply = replyToMessage(root, {
    from: agentId,
    message_id: message.id,
    type: success ? "result" : "error",
    payload: {
      text: replyText,
      summary: replyText,
      exit_code: exitCode,
      signal
    }
  });

  heartbeatAgent(root, {
    agent_id: agentId,
    status: "idle",
    current_task: null,
    metadata: { mode: "worker-loop", workspace }
  });
  appendEvent(root, {
    type: "worker_task_finished",
    agent_id: agentId,
    from: message.from,
    to: message.to,
    message_id: reply.id,
    task_id: message.task_id || undefined,
    conversation_id: message.conversation_id,
    detail: { success, exit_code: exitCode, signal }
  });

  return {
    message_id: message.id,
    task_id: message.task_id,
    success,
    exit_code: exitCode,
    signal,
    reply
  };
}

async function runWorkerLoop(root, input) {
  ensureBus(root);
  const rawAgentId = assertAgentId(input.agent_id);
  const ownerAgentId = input.owner_agent_id || input.from || null;
  const workspace = path.resolve(input.workspace || process.cwd());
  const intervalMs = input.interval_ms || 2000;
  const maxTasks = input.max_tasks || (input.once ? 1 : Infinity);
  let handled = 0;

  const agent = registerAgent(root, {
    agent_id: rawAgentId,
    local_agent_id: input.local_agent_id || localAgentIdFor(rawAgentId, ownerAgentId),
    label: input.label || rawAgentId,
    workspace,
    status: "idle",
    pid: process.pid,
    command: [process.execPath, scriptPath(), "worker-loop"],
    metadata: { mode: "worker-loop", workspace },
    owner_agent_id: ownerAgentId,
    parent_agent_id: input.parent_agent_id || ownerAgentId,
    duplicate_policy: input.replace ? "replace" : "replace-stale"
  });
  const agentId = agent.agent_id;
  appendEvent(root, {
    type: "worker_loop_started",
    agent_id: agentId,
    detail: { workspace, interval_ms: intervalMs, once: Boolean(input.once) }
  });

  while (handled < maxTasks) {
    heartbeatAgent(root, {
      agent_id: agentId,
      status: "idle",
      current_task: null,
      metadata: { mode: "worker-loop", workspace }
    });
    const [message] = claimMessages(root, agentId, 1, "task");
    if (!message) {
      if (input.once) {
        break;
      }
      await sleep(intervalMs);
      continue;
    }

    handled += 1;
    executeWorkerTask(root, {
      ...input,
      agent_id: agentId,
      workspace,
      message
    });
  }

  heartbeatAgent(root, {
    agent_id: agentId,
    status: input.once ? "completed" : "idle",
    current_task: null,
    metadata: { mode: "worker-loop", workspace }
  });
  appendEvent(root, {
    type: "worker_loop_stopped",
    agent_id: agentId,
    detail: { handled }
  });
  return { agent, handled };
}

function startWorker(root, input) {
  ensureBus(root);
  const rawAgentId = assertAgentId(input.agent_id);
  const ownerAgentId = input.from ? assertAgentId(String(input.from), "from") : input.owner_agent_id ? assertAgentId(String(input.owner_agent_id), "owner_agent_id") : null;
  const agentId = ownerAgentId
    ? resolveAgentReference(root, rawAgentId, ownerAgentId, { create_scoped: true })
    : rawAgentId;
  const localAgentId = normalizeLocalAgentId(agentId, ownerAgentId, input.local_agent_id || localAgentIdFor(rawAgentId, ownerAgentId));
  const workspace = path.resolve(input.workspace || process.cwd());
  ensureNoImplicitVariant(root, { ...input, from: ownerAgentId, agent_id: agentId });
  const existing = jsonFile(agentFile(root, agentId));
  const controlledExisting = existing && ownerAgentId
    ? ensureAgentController(root, existing, ownerAgentId, `launch ${agentId}`, { adopt: isWorkerLoopAgent(existing) })
    : existing;
  const existingDecorated = controlledExisting ? decorateAgent(root, controlledExisting) : null;
  const duplicatePolicy = input.duplicate_policy || (input.replace ? "replace" : "reuse-online");
  if (existingDecorated && isOnlineAgent(existingDecorated)) {
    if (isWorkerLoopAgent(existingDecorated) && duplicatePolicy !== "replace") {
      appendEvent(root, {
        type: "worker_reused",
        agent_id: agentId,
        detail: {
          pid: agentPid(existingDecorated),
          workspace: existingDecorated.workspace,
          requested_workspace: workspace
        }
      });
      return {
        mode: "reused",
        reused: true,
        agent: existingDecorated,
        reason: `agent ${agentId} already has an online worker-loop`
      };
    }
    if (duplicatePolicy === "replace") {
      terminateAgentProcess(root, existingDecorated, "replace requested for start-worker");
    } else {
      throw new Error(`agent ${agentId} is already online as pid ${agentPid(existingDecorated)}; stop it first, pass --replace, or choose a different agent id`);
    }
  }
  reserveChildAgent(root, {
    agent_id: agentId,
    from: ownerAgentId,
    local_agent_id: localAgentId,
    label: input.label || rawAgentId,
    workspace,
    reserved_for: "start-worker"
  });

  const command = [
    process.execPath,
    scriptPath(),
    "worker-loop",
    "--agent",
    agentId,
    "--label",
    input.label || rawAgentId,
    "--workspace",
    workspace,
    "--interval-ms",
    String(input.interval_ms || 2000)
  ];
  if (ownerAgentId) {
    command.push("--owner", ownerAgentId, "--parent", ownerAgentId);
  }
  if (input.model) {
    command.push("--model", input.model);
  }
  if (input.profile) {
    command.push("--profile", input.profile);
  }
  if (input.sandbox) {
    command.push("--sandbox", input.sandbox);
  }
  if (input.approval) {
    command.push("--approval", input.approval);
  }
  if (input.replace) {
    command.push("--replace");
  }

  if (input.open_terminal) {
    const shellCommand = [
      `export CODEX_CLI_BUS_HOME=${shellQuote(root)}`,
      `export CODEX_AGENT_ID=${shellQuote(agentId)}`,
      `cd ${shellQuote(workspace)}`,
      shellJoin(command)
    ].join("; ");
    const terminalPid = openTerminal(shellCommand);
    appendEvent(root, {
      type: "worker_terminal_launched",
      agent_id: agentId,
      detail: { terminal_pid: terminalPid, workspace }
    });
    return {
      mode: "terminal",
      terminal_pid: terminalPid,
      shell_command: shellCommand,
      command
    };
  }

  const spawned = spawnProcess(root, {
    agent_id: agentId,
    from: ownerAgentId,
    local_agent_id: localAgentId,
    label: input.label || rawAgentId,
    workspace,
    owner_agent_id: ownerAgentId,
    parent_agent_id: ownerAgentId,
    duplicate_policy: input.replace ? "replace" : undefined,
    command
  });
  appendEvent(root, {
    type: "worker_daemon_started",
    agent_id: agentId,
    detail: { pid: spawned.pid, workspace }
  });
  return {
    mode: "daemon",
    ...spawned
  };
}

function pluginManifestForInstall() {
  const root = packageRoot();
  const packageJson = jsonFile(path.join(root, "package.json")) || {};
  const sourceManifest = jsonFile(path.join(root, ".codex-plugin", "plugin.json")) || {};
  return {
    ...sourceManifest,
    name: PLUGIN_NAME,
    version: String(packageJson.version || sourceManifest.version || "0.1.0"),
    description: String(packageJson.description || sourceManifest.description || "Local message bus and control plane for coordinating multiple Codex CLI agents."),
    skills: "./skills/",
    mcpServers: "./.mcp.json"
  };
}

function marketplaceEntry() {
  return {
    name: PLUGIN_NAME,
    source: {
      source: "local",
      path: `./plugins/${PLUGIN_NAME}`
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL"
    },
    category: "Productivity"
  };
}

function writeMarketplace(root, input) {
  const marketplaceFile = path.join(root, ".agents", "plugins", "marketplace.json");
  const existing = jsonFile(marketplaceFile);
  if (existing?.name && input.marketplace_name && existing.name !== input.marketplace_name) {
    throw new Error(`marketplace root already uses name ${existing.name}; pass --marketplace-name ${existing.name} or choose another --marketplace-root`);
  }
  const name = existing?.name || input.marketplace_name || DEFAULT_MARKETPLACE_NAME;
  const entry = marketplaceEntry();
  const plugins = [
    ...(existing?.plugins || []).filter((plugin) => plugin?.name !== PLUGIN_NAME),
    entry
  ];
  const marketplace = {
    ...(existing || {}),
    name,
    interface: {
      displayName: "Codex CLI Bus",
      ...(existing?.interface || {})
    },
    plugins
  };
  writeJsonAtomic(marketplaceFile, marketplace);
  return { marketplace, marketplace_file: marketplaceFile };
}

function writePluginInstallFiles(input) {
  const root = packageRoot();
  const marketplaceRoot = path.resolve(input.marketplace_root);
  const pluginDir = path.join(marketplaceRoot, "plugins", PLUGIN_NAME);
  const sourceSkillDir = path.join(root, "skills");
  const sourcePluginMetaDir = path.join(root, ".codex-plugin");
  const mcpServerPath = path.join(root, "scripts", "mcp-server.mjs");
  if (!fs.existsSync(mcpServerPath)) {
    throw new Error(`missing MCP server: ${mcpServerPath}`);
  }
  if (!fs.existsSync(sourceSkillDir)) {
    throw new Error(`missing skills directory: ${sourceSkillDir}`);
  }
  if (!fs.existsSync(sourcePluginMetaDir)) {
    throw new Error(`missing plugin metadata directory: ${sourcePluginMetaDir}`);
  }

  fs.rmSync(pluginDir, { recursive: true, force: true });
  ensureDir(pluginDir);
  copyDirSync(sourceSkillDir, path.join(pluginDir, "skills"));
  ensureDir(path.join(pluginDir, ".codex-plugin"));
  writeJsonAtomic(path.join(pluginDir, ".codex-plugin", "plugin.json"), pluginManifestForInstall());
  writeJsonAtomic(path.join(pluginDir, ".mcp.json"), {
    mcpServers: {
      [PLUGIN_NAME]: {
        command: process.execPath,
        args: [mcpServerPath],
        env: {
          CODEX_CLI_BUS_HOME: input.bus_home
        }
      }
    }
  });
  const marketplace = writeMarketplace(marketplaceRoot, input);
  return {
    plugin_dir: pluginDir,
    mcp_server: mcpServerPath,
    ...marketplace
  };
}

function parseMarketplaceList(stdout) {
  return String(stdout || "")
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\S+)\s+(.+)$/);
      return match ? { name: match[1], root: match[2] } : { name: line, root: "" };
    })
    .filter((entry) => entry.name);
}

function runCodex(args) {
  const result = spawnSync("codex", args, {
    encoding: "utf8",
    env: process.env
  });
  return {
    command: ["codex", ...args],
    ok: result.status === 0,
    status: result.status,
    signal: result.signal || null,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? result.error.message : null
  };
}

function installCodexPlugin(busHome, input = {}) {
  const marketplaceRoot = path.resolve(input.marketplace_root || path.join(busHome, "plugin-marketplace"));
  const marketplaceName = input.marketplace_name || DEFAULT_MARKETPLACE_NAME;
  const plan = {
    marketplace_root: marketplaceRoot,
    marketplace_name: marketplaceName,
    bus_home: busHome,
    package_root: packageRoot(),
    plugin_selector: `${PLUGIN_NAME}@${marketplaceName}`,
    commands: [
      ["codex", "plugin", "marketplace", "add", marketplaceRoot],
      ["codex", "plugin", "add", `${PLUGIN_NAME}@${marketplaceName}`]
    ]
  };

  if (input.dry_run) {
    return {
      dry_run: true,
      installed: false,
      ...plan
    };
  }

  const files = writePluginInstallFiles({
    marketplace_root: marketplaceRoot,
    marketplace_name: marketplaceName,
    bus_home: busHome
  });
  const marketplaceNameFromFile = files.marketplace.name;
  const pluginSelector = `${PLUGIN_NAME}@${marketplaceNameFromFile}`;
  const commands = [];
  if (!input.no_codex) {
    const listed = runCodex(["plugin", "marketplace", "list"]);
    commands.push({ step: "marketplace-list", ...listed });
    if (!listed.ok) {
      throw new Error(`failed to list Codex marketplaces: ${listed.error || listed.stderr || listed.stdout}`);
    }
    const configured = parseMarketplaceList(listed.stdout).find((entry) => entry.name === marketplaceNameFromFile);
    if (configured && path.resolve(configured.root) !== marketplaceRoot) {
      throw new Error(`Codex marketplace ${marketplaceNameFromFile} is already configured at ${configured.root}; pass --marketplace-name to use a different name`);
    }
    if (!configured) {
      const addedMarketplace = runCodex(["plugin", "marketplace", "add", marketplaceRoot]);
      commands.push({ step: "marketplace-add", ...addedMarketplace });
      if (!addedMarketplace.ok) {
        throw new Error(`failed to add Codex marketplace: ${addedMarketplace.error || addedMarketplace.stderr || addedMarketplace.stdout}`);
      }
    } else {
      commands.push({
        step: "marketplace-add",
        command: ["codex", "plugin", "marketplace", "add", marketplaceRoot],
        ok: true,
        skipped: true,
        reason: `marketplace ${marketplaceNameFromFile} is already configured`
      });
    }
    const addedPlugin = runCodex(["plugin", "add", pluginSelector]);
    commands.push({ step: "plugin-add", ...addedPlugin });
    if (!addedPlugin.ok) {
      throw new Error(`failed to install Codex plugin: ${addedPlugin.error || addedPlugin.stderr || addedPlugin.stdout}`);
    }
  }

  return {
    installed: !input.no_codex,
    codex_skipped: Boolean(input.no_codex),
    marketplace_root: marketplaceRoot,
    marketplace_name: marketplaceNameFromFile,
    plugin_selector: pluginSelector,
    bus_home: busHome,
    package_root: packageRoot(),
    ...files,
    commands,
    next_steps: [
      "Start a new Codex CLI session so the plugin skill and MCP tools are loaded.",
      "Ask: 查看所有 Codex CLI agent 的状态。"
    ]
  };
}

function helpText() {
  return `Codex CLI Bus

Usage:
  codex-cli-bus <command> [options]

Commands:
  install-plugin Register and install the Codex CLI plugin locally
  register       Register or update an agent in the local registry
  heartbeat      Refresh agent state and current task
  list           List known agents and mailbox counts
  status         Show one agent or one task
  send           Send a message or task to another agent
  poll           Read or claim messages for an agent
  reply          Reply to a claimed message
  tasks          List task records
  complete       Mark a task complete/failed/blocked without sending a reply
  cancel         Cancel a task and notify its assignee
  events         Show recent bus events
  stop-agent     Stop one agent process and mark it exited
  spawn          Start any local process and register it as an agent
  spawn-codex    Start a non-interactive codex exec worker and send it a task
  launch-codex   Create or open an interactive Codex CLI worker terminal
  start-worker   Start a persistent worker that auto-claims tasks
  worker-loop    Run the persistent worker loop in the foreground
  bootstrap      Print the prompt used by spawn-codex

Common options:
  --bus-home DIR        Override bus root; default CODEX_CLI_BUS_HOME or ~/.codex-cli-bus
  --agent ID           Agent id; also read from CODEX_AGENT_ID
  --from ID / --to ID  Sender and recipient ids
  --owner ID           Register/list an agent as a child owned by this controller
  --viewer ID          Filter status/list/tasks/events to what one controller can see
  --text TEXT          Message or task text
  --stdin              Read text from stdin
  --replace            Replace an existing online agent with the same id
  --allow-variant      Intentionally start a fallback/default variant agent
  --marketplace-root   install-plugin output root; default ~/.codex-cli-bus/plugin-marketplace
  --marketplace-name   install-plugin marketplace name; default codex-cli-bus-local
  --no-codex           Write plugin files without running codex plugin commands

Examples:
  codex-cli-bus install-plugin
  codex-cli-bus register --agent cli-a --label controller
  codex-cli-bus list --viewer cli-a
  codex-cli-bus list --owner cli-a
  codex-cli-bus send --from cli-a --to cli-b --type task --text "Run tests"
  codex-cli-bus poll --agent cli-b --claim
  codex-cli-bus reply --from cli-b --message msg_x --text "Tests passed"
  codex-cli-bus launch-codex --from cli-a --agent cli-b --open-terminal --text "Run tests"
  codex-cli-bus start-worker --from cli-a --agent cli-b --workspace .
`;
}

async function runCommand(argv) {
  const { command, opts, positionals, commandArgs } = parseArgv(argv);
  const root = getBusHome(opts);

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(helpText());
      return null;

    case "install-plugin": {
      const installed = installCodexPlugin(root, {
        marketplace_root: option(opts, "marketplace-root", "marketplace_root"),
        marketplace_name: option(opts, "marketplace-name", "marketplace_name"),
        dry_run: boolOption(opts, "dry-run", "dry_run"),
        no_codex: boolOption(opts, "no-codex", "no_codex")
      });
      output({ ok: true, ...installed });
      return installed;
    }

    case "register": {
      const agent = registerAgent(root, {
        agent_id: requiredAgent(opts),
        label: option(opts, "label"),
        workspace: option(opts, "workspace", "cwd"),
        status: option(opts, "status") || "idle",
        session_id: option(opts, "session"),
        pid: option(opts, "pid") === undefined ? process.pid : Number(option(opts, "pid")),
        owner_agent_id: option(opts, "owner", "owner-agent", "owner-agent-id"),
        parent_agent_id: option(opts, "parent", "parent-agent", "parent-agent-id"),
        metadata: parseJsonOption(opts, "metadata") || {},
        duplicate_policy: boolOption(opts, "replace") ? "replace" : boolOption(opts, "reuse") ? "reuse" : "replace-stale"
      });
      output({ ok: true, bus_home: root, agent });
      return agent;
    }

    case "heartbeat": {
      const taskSummary = option(opts, "task", "current-task");
      const taskId = option(opts, "task-id");
      const agent = heartbeatAgent(root, {
        agent_id: requiredAgent(opts),
        status: option(opts, "status") || "idle",
        current_task: taskSummary || taskId ? {
          task_id: taskId || null,
          summary: String(taskSummary || ""),
          started_at: nowIso()
        } : undefined,
        metadata: parseJsonOption(opts, "metadata"),
        owner_agent_id: option(opts, "owner", "owner-agent", "owner-agent-id")
      });
      output({ ok: true, bus_home: root, agent });
      return agent;
    }

    case "list": {
      const staleMs = numberOption(opts, DEFAULT_STALE_MS, "stale-ms", "stale_ms");
      const agents = readAgents(root, staleMs, {
        visible_to: option(opts, "from", "viewer", "visible-to", "visible_to"),
        owner_agent_id: option(opts, "owner", "owner-agent", "owner-agent-id")
      });
      output({ ok: true, bus_home: root, count: agents.length, agents });
      return agents;
    }

    case "status": {
      const taskId = option(opts, "task", "task-id");
      const viewer = option(opts, "from", "viewer", "visible-to", "visible_to");
      if (taskId) {
        const task = jsonFile(taskFile(root, String(taskId)));
        if (task) {
          ensureTaskVisible(root, task, viewer ? assertAgentId(String(viewer), "viewer") : null, `inspect task ${task.task_id}`);
        }
        output({ ok: Boolean(task), bus_home: root, task });
        return task;
      }
      const rawAgentId = requiredAgent(opts);
      const agentId = resolveAgentReference(root, rawAgentId, viewer ? assertAgentId(String(viewer), "viewer") : null, {
        prefer_existing_unowned: true
      });
      const agent = jsonFile(agentFile(root, agentId));
      if (agent) {
        ensureAgentVisible(root, agent, viewer ? assertAgentId(String(viewer), "viewer") : null, `inspect ${agentId}`);
      }
      const decorated = agent ? decorateAgent(root, agent, numberOption(opts, DEFAULT_STALE_MS, "stale-ms", "stale_ms"), {
        visible_to: viewer
      }) : null;
      output({ ok: Boolean(decorated), bus_home: root, agent: decorated });
      return decorated;
    }

    case "send": {
      const type = String(option(opts, "type") || "message");
      const text = readText(opts, positionals);
      const payload = {
        ...(parseJsonOption(opts, "payload") || {}),
        text
      };
      if (type === "task") {
        payload.objective = payload.objective || text;
      }
      const message = sendMessage(root, {
        from: requiredAgent(opts, "from"),
        to: requiredAgent(opts, "to"),
        type,
        payload,
        conversation_id: option(opts, "conversation", "conversation-id"),
        parent_id: option(opts, "parent", "parent-id"),
        task_id: option(opts, "task-id"),
        timeout_ms: numberOption(opts, null, "timeout-ms", "timeout_ms")
      });
      output({ ok: true, bus_home: root, message });
      return message;
    }

    case "poll": {
      const messages = pollMessages(root, {
        agent_id: requiredAgent(opts),
        requester_agent_id: option(opts, "from", "viewer", "requester", "requester-agent-id"),
        limit: numberOption(opts, 10, "limit"),
        claim: boolOption(opts, "claim", "ack"),
        type: option(opts, "type")
      });
      output({ ok: true, bus_home: root, count: messages.length, messages });
      return messages;
    }

    case "reply": {
      const text = readText(opts, positionals);
      const payload = {
        ...(parseJsonOption(opts, "payload") || {}),
        text,
        summary: option(opts, "summary") || text
      };
      const message = replyToMessage(root, {
        from: requiredAgent(opts, "from"),
        to: option(opts, "to"),
        message_id: String(option(opts, "message", "message-id") || ""),
        type: String(option(opts, "type") || "result"),
        payload
      });
      output({ ok: true, bus_home: root, message });
      return message;
    }

    case "tasks": {
      const agentId = option(opts, "agent") ? assertAgentId(String(option(opts, "agent"))) : null;
      const tasks = listTasks(root, {
        agent_id: agentId,
        visible_to: option(opts, "from", "viewer", "visible-to", "visible_to"),
        status: option(opts, "status"),
        limit: numberOption(opts, null, "limit")
      });
      output({ ok: true, bus_home: root, count: tasks.length, tasks });
      return tasks;
    }

    case "complete": {
      const taskId = String(option(opts, "task", "task-id") || "");
      if (!taskId) {
        throw new Error("missing --task");
      }
      const viewer = option(opts, "from", "viewer");
      const existingTask = jsonFile(taskFile(root, taskId));
      if (existingTask) {
        ensureTaskVisible(root, existingTask, viewer ? assertAgentId(String(viewer), "viewer") : null, `complete task ${taskId}`);
      }
      const status = String(option(opts, "status") || "completed");
      const task = updateTask(root, taskId, {
        status,
        completed_at: ["completed", "failed", "cancelled"].includes(status) ? nowIso() : undefined,
        summary: option(opts, "summary") || readText({ ...opts, text: option(opts, "text") || option(opts, "summary") || "" }, positionals, "summary")
      });
      output({ ok: Boolean(task), bus_home: root, task });
      return task;
    }

    case "cancel": {
      const from = requiredAgent(opts, "from");
      const taskId = String(option(opts, "task", "task-id") || "");
      if (!taskId) {
        throw new Error("missing --task");
      }
      const existingTask = jsonFile(taskFile(root, taskId));
      if (!existingTask) {
        throw new Error(`task not found: ${taskId}`);
      }
      ensureTaskVisible(root, existingTask, from, `cancel task ${taskId}`);
      const task = updateTask(root, taskId, {
        status: "cancelled",
        completed_at: nowIso(),
        summary: option(opts, "reason") || "cancelled"
      });
      const message = sendMessage(root, {
        from,
        to: task.assignee,
        type: "cancel",
        conversation_id: task.conversation_id,
        task_id: task.task_id,
        payload: {
          text: option(opts, "reason") || "cancelled",
          reason: option(opts, "reason") || "cancelled"
        }
      });
      output({ ok: true, bus_home: root, task, message });
      return { task, message };
    }

    case "events": {
      const events = readEvents(root, {
        agent_id: option(opts, "agent") ? assertAgentId(String(option(opts, "agent"))) : null,
        visible_to: option(opts, "from", "viewer", "visible-to", "visible_to"),
        conversation_id: option(opts, "conversation", "conversation-id"),
        limit: numberOption(opts, 50, "limit")
      });
      output({ ok: true, bus_home: root, count: events.length, events });
      return events;
    }

    case "stop-agent": {
      const stopped = stopAgent(root, {
        agent_id: requiredAgent(opts),
        from: option(opts, "from"),
        reason: option(opts, "reason") || readText({ ...opts, text: option(opts, "reason") || "stop requested" }, positionals, "reason")
      });
      output({ ok: true, bus_home: root, stopped });
      return stopped;
    }

    case "spawn": {
      const spawned = spawnProcess(root, {
        agent_id: requiredAgent(opts),
        from: option(opts, "from"),
        label: option(opts, "label"),
        workspace: option(opts, "workspace", "cwd"),
        owner_agent_id: option(opts, "owner", "owner-agent", "owner-agent-id"),
        parent_agent_id: option(opts, "parent", "parent-agent", "parent-agent-id"),
        command: commandArgs
      });
      output({ ok: true, bus_home: root, spawned });
      return spawned;
    }

    case "spawn-codex": {
      const taskText = readText(opts, positionals, "task");
      const spawned = spawnCodex(root, {
        agent_id: requiredAgent(opts),
        from: requiredAgent(opts, "from"),
        label: option(opts, "label"),
        workspace: option(opts, "workspace", "cwd"),
        task_text: taskText,
        timeout_ms: numberOption(opts, null, "timeout-ms", "timeout_ms"),
        model: option(opts, "model"),
        profile: option(opts, "profile"),
        sandbox: option(opts, "sandbox"),
        approval: approvalOption(opts)
      });
      output({ ok: true, bus_home: root, spawned });
      return spawned;
    }

    case "launch-codex": {
      const taskText = readText(opts, positionals, "task");
      const launched = launchCodex(root, {
        agent_id: requiredAgent(opts),
        from: requiredAgent(opts, "from"),
        label: option(opts, "label"),
        workspace: option(opts, "workspace", "cwd"),
        task_text: taskText,
        timeout_ms: numberOption(opts, null, "timeout-ms", "timeout_ms"),
        model: option(opts, "model"),
        profile: option(opts, "profile"),
        sandbox: option(opts, "sandbox"),
        approval: approvalOption(opts),
        open_terminal: boolOption(opts, "open-terminal", "open_terminal"),
        allow_variant: boolOption(opts, "allow-variant", "allow_variant"),
        replace: boolOption(opts, "replace")
      });
      output({ ok: true, bus_home: root, launched });
      return launched;
    }

    case "start-worker": {
      const started = startWorker(root, {
        agent_id: requiredAgent(opts),
        from: option(opts, "from"),
        label: option(opts, "label"),
        workspace: option(opts, "workspace", "cwd"),
        interval_ms: numberOption(opts, 2000, "interval-ms", "interval_ms"),
        owner_agent_id: option(opts, "owner", "owner-agent", "owner-agent-id"),
        parent_agent_id: option(opts, "parent", "parent-agent", "parent-agent-id"),
        model: option(opts, "model"),
        profile: option(opts, "profile"),
        sandbox: option(opts, "sandbox"),
        approval: approvalOption(opts),
        open_terminal: boolOption(opts, "open-terminal", "open_terminal"),
        allow_variant: boolOption(opts, "allow-variant", "allow_variant"),
        replace: boolOption(opts, "replace")
      });
      output({ ok: true, bus_home: root, started });
      return started;
    }

    case "worker-loop": {
      const result = await runWorkerLoop(root, {
        agent_id: requiredAgent(opts),
        label: option(opts, "label"),
        workspace: option(opts, "workspace", "cwd"),
        interval_ms: numberOption(opts, 2000, "interval-ms", "interval_ms"),
        max_tasks: numberOption(opts, null, "max-tasks", "max_tasks"),
        once: boolOption(opts, "once"),
        owner_agent_id: option(opts, "owner", "owner-agent", "owner-agent-id"),
        parent_agent_id: option(opts, "parent", "parent-agent", "parent-agent-id"),
        model: option(opts, "model"),
        profile: option(opts, "profile"),
        sandbox: option(opts, "sandbox"),
        approval: approvalOption(opts),
        replace: boolOption(opts, "replace"),
        executor_command: commandArgs
      });
      output({ ok: true, bus_home: root, result });
      return result;
    }

    case "bootstrap": {
      const prompt = buildCodexBootstrapPrompt({
        agent_id: requiredAgent(opts),
        message_id: String(option(opts, "message", "message-id") || "msg_placeholder"),
        task_text: readText(opts, positionals, "task"),
        bus_home: root
      });
      process.stdout.write(`${prompt}\n`);
      return prompt;
    }

    default:
      throw new Error(`unknown command: ${command}. Run help for usage.`);
  }
}

if (isCliEntrypoint()) {
  runCommand(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export {
  PROTOCOL_VERSION,
  buildCodexBootstrapPrompt,
  claimMessages,
  decorateAgent,
  getBusHome,
  heartbeatAgent,
  launchCodex,
  installCodexPlugin,
  listTasks,
  packageRoot,
  pollMessages,
  readAgents,
  readEvents,
  registerAgent,
  replyToMessage,
  runCommand,
  sendMessage,
  spawnCodex,
  spawnProcess,
  startWorker,
  updateTask
};
