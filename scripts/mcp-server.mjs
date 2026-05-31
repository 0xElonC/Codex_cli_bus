#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  getBusHome,
  launchCodex,
  listTasks,
  pollMessages,
  readAgents,
  readEvents,
  registerAgent,
  replyToMessage,
  sendMessage,
  startWorker
} from "./codex-cli-bus.mjs";

const SERVER_NAME = "codex-cli-bus";
const SERVER_VERSION = "0.1.0";

function currentAgent(args = {}) {
  return String(args.from || process.env.CODEX_AGENT_ID || "controller");
}

function busRoot(args = {}) {
  return getBusHome({
    "bus-home": args.bus_home || process.env.CODEX_CLI_BUS_HOME
  });
}

function jsonText(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function explicitModel(args = {}, toolName) {
  if (!args.model) {
    return undefined;
  }
  if (args.model_requested_by_user !== true) {
    throw new Error(`${toolName} received model=${JSON.stringify(String(args.model))}, but model_requested_by_user was not true. Omit model unless the user explicitly asked for that exact model.`);
  }
  return String(args.model);
}

const tools = [
  {
    name: "register_agent",
    description: "Register this Codex CLI or another local CLI agent in the shared bus registry.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Stable agent id. For a child, pass the owner's local name such as cli-b; the bus stores it as owner.cli-b internally." },
        label: { type: "string" },
        owner_agent_id: { type: "string", description: "Owner/controller agent id for child agents." },
        parent_agent_id: { type: "string", description: "Parent agent id that started this agent." },
        workspace: { type: "string" },
        status: { type: "string", enum: ["idle", "running", "waiting_for_user", "waiting_for_agent", "blocked", "completed", "failed", "exited", "unknown"] },
        bus_home: { type: "string" }
      },
      required: ["agent_id"]
    }
  },
  {
    name: "list_agents",
    description: "List all known Codex CLI agents, their liveness, current task, and pending message counts.",
    inputSchema: {
      type: "object",
      properties: {
        stale_ms: { type: "number" },
        from: { type: "string", description: "Controller/viewer agent id. Defaults to CODEX_AGENT_ID or controller." },
        owner_agent_id: { type: "string", description: "Only list direct children owned by this controller." },
        bus_home: { type: "string" }
      }
    }
  },
  {
    name: "get_agent_status",
    description: "Get the status of one Codex CLI agent by internal id or by the current controller's local child name.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Internal id such as cli-a.cli-b, or local child name such as cli-b when from is the owner." },
        from: { type: "string", description: "Controller/viewer agent id. Defaults to CODEX_AGENT_ID or controller." },
        stale_ms: { type: "number" },
        bus_home: { type: "string" }
      },
      required: ["agent_id"]
    }
  },
  {
    name: "send_task",
    description: "Send a natural-language task from one Codex CLI agent to another through the bus.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Sender agent id. Defaults to CODEX_AGENT_ID or controller." },
        to: { type: "string", description: "Recipient id. Local child names are resolved under from, so cli-b under cli-a is stored as cli-a.cli-b." },
        text: { type: "string", description: "Natural-language task." },
        timeout_ms: { type: "number" },
        bus_home: { type: "string" }
      },
      required: ["to", "text"]
    }
  },
  {
    name: "send_message",
    description: "Send a natural-language note, status request, or cancellation message to another Codex CLI agent.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        text: { type: "string" },
        type: { type: "string", enum: ["message", "status_request", "cancel"] },
        bus_home: { type: "string" }
      },
      required: ["to", "text"]
    }
  },
  {
    name: "launch_codex_agent",
    description: "Start a real interactive Codex CLI session with a bootstrap prompt and initial task. This is for human-visible one-shot interaction; use start_worker_agent for automatic task pickup.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Controller agent id. Defaults to CODEX_AGENT_ID or controller." },
        agent_id: { type: "string", description: "Worker local name to launch under from, for example cli-b. The internal id becomes from.cli-b." },
        text: { type: "string", description: "Natural-language task for the worker." },
        workspace: { type: "string", description: "Workspace directory for the worker." },
        open_terminal: { type: "boolean", description: "Open macOS Terminal immediately." },
        model: { type: "string", description: "Specific Codex model to use. Only pass when the user explicitly requested this exact model." },
        model_requested_by_user: { type: "boolean", description: "Must be true when passing model; set it only when the user explicitly requested the exact model." },
        profile: { type: "string" },
        sandbox: { type: "string", enum: ["read-only", "workspace-write", "danger-full-access"] },
        approval: { type: "string", enum: ["untrusted", "on-request", "never"] },
        replace: { type: "boolean", description: "Replace an existing online agent with the same id. Defaults to false." },
        bus_home: { type: "string" }
      },
      required: ["agent_id", "text"]
    }
  },
  {
    name: "start_worker_agent",
    description: "Start a persistent Codex CLI worker loop that automatically claims queued tasks, runs codex exec for each task, and replies through the bus.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Controller agent id. Defaults to CODEX_AGENT_ID or controller." },
        agent_id: { type: "string", description: "Worker local name to start under from, for example cli-b. The internal id becomes from.cli-b." },
        label: { type: "string" },
        workspace: { type: "string", description: "Workspace directory for the worker." },
        interval_ms: { type: "number", description: "Polling interval in milliseconds." },
        open_terminal: { type: "boolean", description: "Open the worker loop in macOS Terminal instead of a detached daemon." },
        model: { type: "string", description: "Specific Codex model to use. Only pass when the user explicitly requested this exact model." },
        model_requested_by_user: { type: "boolean", description: "Must be true when passing model; set it only when the user explicitly requested the exact model." },
        profile: { type: "string" },
        sandbox: { type: "string", enum: ["read-only", "workspace-write", "danger-full-access"] },
        approval: { type: "string", enum: ["untrusted", "on-request", "never"] },
        replace: { type: "boolean", description: "Stop and replace an existing online agent with the same id. Defaults to false; online workers are reused." },
        allow_variant: { type: "boolean", description: "Allow a fallback/default variant such as worker-default even when the base worker is already online. Defaults to false." },
        bus_home: { type: "string" }
      },
      required: ["agent_id"]
    }
  },
  {
    name: "poll_messages",
    description: "Poll or claim messages assigned to a Codex CLI agent.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        from: { type: "string", description: "Requester agent id. Only the agent itself can claim; the owner may inspect without claiming." },
        claim: { type: "boolean" },
        limit: { type: "number" },
        type: { type: "string" },
        bus_home: { type: "string" }
      },
      required: ["agent_id"]
    }
  },
  {
    name: "reply_message",
    description: "Reply to a claimed bus message with a natural-language result or error.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        message_id: { type: "string" },
        text: { type: "string" },
        type: { type: "string", enum: ["result", "error", "message"] },
        bus_home: { type: "string" }
      },
      required: ["message_id", "text"]
    }
  },
  {
    name: "list_tasks",
    description: "List recent cross-agent tasks.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        from: { type: "string", description: "Controller/viewer agent id. Defaults to CODEX_AGENT_ID or controller." },
        status: { type: "string" },
        limit: { type: "number" },
        bus_home: { type: "string" }
      }
    }
  },
  {
    name: "recent_events",
    description: "Show recent Codex CLI Bus events for debugging or summarizing cross-agent activity.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        from: { type: "string", description: "Controller/viewer agent id. Defaults to CODEX_AGENT_ID or controller." },
        conversation_id: { type: "string" },
        limit: { type: "number" },
        bus_home: { type: "string" }
      }
    }
  }
];

async function callTool(name, args = {}) {
  const root = busRoot(args);
  switch (name) {
    case "register_agent":
      return registerAgent(root, {
        agent_id: String(args.agent_id),
        label: args.label ? String(args.label) : undefined,
        owner_agent_id: args.owner_agent_id ? String(args.owner_agent_id) : undefined,
        parent_agent_id: args.parent_agent_id ? String(args.parent_agent_id) : undefined,
        workspace: args.workspace ? path.resolve(String(args.workspace)) : process.cwd(),
        status: args.status ? String(args.status) : "idle",
        metadata: { source: "mcp" }
      });

    case "list_agents":
      return {
        bus_home: root,
        agents: readAgents(root, Number(args.stale_ms || 120_000), {
          visible_to: currentAgent(args),
          owner_agent_id: args.owner_agent_id ? String(args.owner_agent_id) : null
        })
      };

    case "get_agent_status": {
      const viewer = currentAgent(args);
      const requestedAgentId = String(args.agent_id);
      const agent = readAgents(root, Number(args.stale_ms || 120_000), {
        visible_to: viewer
      }).find((candidate) => candidate.agent_id === requestedAgentId || (candidate.owner_agent_id === viewer && candidate.local_agent_id === requestedAgentId));
      return {
        bus_home: root,
        agent: agent || null
      };
    }

    case "send_task":
      return sendMessage(root, {
        from: currentAgent(args),
        to: String(args.to),
        type: "task",
        payload: {
          text: String(args.text),
          objective: String(args.text)
        },
        timeout_ms: args.timeout_ms ? Number(args.timeout_ms) : null
      });

    case "send_message":
      return sendMessage(root, {
        from: currentAgent(args),
        to: String(args.to),
        type: String(args.type || "message"),
        payload: {
          text: String(args.text)
        }
      });

    case "launch_codex_agent":
      return launchCodex(root, {
        from: currentAgent(args),
        agent_id: String(args.agent_id),
        task_text: String(args.text),
        workspace: args.workspace ? path.resolve(String(args.workspace)) : process.cwd(),
        open_terminal: Boolean(args.open_terminal),
        model: explicitModel(args, "launch_codex_agent"),
        profile: args.profile ? String(args.profile) : undefined,
        sandbox: args.sandbox ? String(args.sandbox) : undefined,
        approval: args.approval ? String(args.approval) : undefined,
        allow_variant: Boolean(args.allow_variant),
        replace: Boolean(args.replace)
      });

    case "start_worker_agent":
      return startWorker(root, {
        from: currentAgent(args),
        agent_id: String(args.agent_id),
        label: args.label ? String(args.label) : undefined,
        workspace: args.workspace ? path.resolve(String(args.workspace)) : process.cwd(),
        interval_ms: args.interval_ms ? Number(args.interval_ms) : 2000,
        open_terminal: Boolean(args.open_terminal),
        model: explicitModel(args, "start_worker_agent"),
        profile: args.profile ? String(args.profile) : undefined,
        sandbox: args.sandbox ? String(args.sandbox) : undefined,
        approval: args.approval ? String(args.approval) : undefined,
        allow_variant: Boolean(args.allow_variant),
        replace: Boolean(args.replace)
      });

    case "poll_messages":
      return {
        bus_home: root,
        messages: pollMessages(root, {
          agent_id: String(args.agent_id),
          requester_agent_id: currentAgent(args),
          claim: Boolean(args.claim),
          limit: Number(args.limit || 10),
          type: args.type ? String(args.type) : null
        })
      };

    case "reply_message":
      return replyToMessage(root, {
        from: currentAgent(args),
        message_id: String(args.message_id),
        type: String(args.type || "result"),
        payload: {
          text: String(args.text),
          summary: String(args.text)
        }
      });

    case "list_tasks":
      return {
        bus_home: root,
        tasks: listTasks(root, {
          agent_id: args.agent_id ? String(args.agent_id) : null,
          visible_to: currentAgent(args),
          status: args.status ? String(args.status) : null,
          limit: args.limit ? Number(args.limit) : null
        })
      };

    case "recent_events":
      return {
        bus_home: root,
        events: readEvents(root, {
          agent_id: args.agent_id ? String(args.agent_id) : null,
          visible_to: currentAgent(args),
          conversation_id: args.conversation_id ? String(args.conversation_id) : null,
          limit: Number(args.limit || 50)
        })
      };

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({
    jsonrpc: "2.0",
    id,
    result
  });
}

function respondError(id, error) {
  send({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: error instanceof Error ? error.message : String(error)
    }
  });
}

async function handle(message) {
  if (!message || typeof message !== "object") {
    return;
  }
  if (!Object.hasOwn(message, "id")) {
    return;
  }
  try {
    switch (message.method) {
      case "initialize":
        respond(message.id, {
          protocolVersion: message.params?.protocolVersion || "2024-11-05",
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION
          },
          instructions: "Use these tools to coordinate local Codex CLI agents by natural language. Launch agents, send tasks, inspect state, and route replies through the shared local bus."
        });
        break;

      case "ping":
        respond(message.id, {});
        break;

      case "tools/list":
        respond(message.id, { tools });
        break;

      case "tools/call": {
        const result = await callTool(message.params?.name, message.params?.arguments || {});
        respond(message.id, jsonText(result));
        break;
      }

      default:
        respondError(message.id, new Error(`unsupported MCP method: ${message.method}`));
    }
  } catch (error) {
    respondError(message.id, error);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) {
      break;
    }
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) {
      continue;
    }
    try {
      void handle(JSON.parse(line));
    } catch (error) {
      respondError(null, error);
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
