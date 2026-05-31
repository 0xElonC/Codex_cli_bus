---
name: cli-bus
description: Coordinate multiple local Codex CLI agents through the Codex CLI Bus protocol. Use when the user asks to send tasks/messages to another CLI, start a worker CLI, inspect agent status, poll for assigned work, or summarize cross-agent activity.
---

# Codex CLI Bus

Use this plugin as the structured control plane for natural-language coordination between local Codex CLI agents.

When MCP tools are available, prefer them over shell commands:

- `register_agent`: register the current or target CLI agent.
- `list_agents` / `get_agent_status`: answer status questions.
- `send_task` / `send_message`: route natural-language work to another agent.
- `start_worker_agent`: start a persistent worker that automatically claims queued tasks and replies.
- `launch_codex_agent`: open a real interactive Codex CLI session and give it one initial task.
- `poll_messages` / `reply_message`: receive and answer bus messages.
- `list_tasks` / `recent_events`: summarize activity.

Use the bundled script as a fallback when MCP tools are not available. Prefer structured commands over free-form terminal text when coordinating other CLI agents.

Natural-language examples the user may ask:

- "启动一个 cli-b，让它跑测试并回报。"
- "看看其他 Codex CLI 都在干什么。"
- "给 cli-b 发消息，让它重新检查刚才的错误。"
- "cli-c 卡住了吗？"

Agent identity rules:

- Treat controller `agent_id` values as global logical mailbox names, not unique process ids.
- Treat child names as owner-local. When `cli-a` starts local child `cli-b`, the canonical internal `agent_id` is `cli-a.cli-b` and `local_agent_id` is `cli-b`.
- Another controller can also have local child `cli-b`; internally it is `other-controller.cli-b`.
- A running process instance has its own `session_id` and `pid`.
- Treat `agents/records/*.json` as the only canonical storage for full agent records.
- Treat `agents/ownership/<owner>/children.json` as a synchronized ownership index containing child ids and local-name mappings only.
- Treat `owner_agent_id` as the only controller allowed to interact with a child agent.
- When `cli-a` starts local `cli-b`, record `cli-a.cli-b.owner_agent_id = cli-a`, `cli-a.cli-b.parent_agent_id = cli-a`, and `cli-a.cli-b.local_agent_id = cli-b`.
- Do not inspect, send tasks/messages to, claim mail for, or spoof replies from an owned child agent from a different controller id. If another controller says `cli-b`, resolve it as that controller's local child, not as `cli-a.cli-b`.
- When asked to start `cli-b`, first prefer `start_worker_agent`; if an online `from.cli-b` worker already exists, reuse it.
- New child startup reserves the target `agent_id` with `metadata.mode = "reserved-child"` before sending the initial task, so another controller cannot take the name during launch.
- If a model/config fallback is needed, restart the same `agent_id` with `replace: true`; do not invent a second id like `*-default` unless the user explicitly asks for a parallel variant.
- Do not start multiple online workers with the same `agent_id` unless the user explicitly asks to replace the old one.
- If multiple controller CLIs are active, make sure each controller uses a distinct id so replies do not share the same inbox.
- For MCP calls, pass `from` or set `CODEX_AGENT_ID` so the bus can scope visibility to the current controller.
- If one main CLI needs another main CLI to create a worker, send a task to that main CLI and let the receiver start its own local child under its own namespace.
- Do not pass `model` in MCP calls unless the user explicitly named the model. When the user did name it, also set `model_requested_by_user: true`.

CLI fallback command:

```bash
codex-cli-bus
```

When working directly from this source repo before npm linking, the equivalent command is:

```bash
node scripts/codex-cli-bus.mjs
```

## Agent Identity

Choose a stable short id for the current session, such as `cli-a`, `controller`, or `worker-tests`.
Agent ids must match `^[A-Za-z0-9][A-Za-z0-9_.@-]{0,79}$`.

Register the current agent before sending or receiving messages:

```bash
codex-cli-bus register --agent cli-a --label controller
```

If the environment already has `CODEX_AGENT_ID`, the script can use it instead of `--agent`.
Use `CODEX_CLI_BUS_HOME` to share a non-default bus directory across terminals.

## Status And Control

List all known agents:

```bash
codex-cli-bus list
codex-cli-bus list --viewer cli-a
codex-cli-bus list --owner cli-a
```

Inspect one agent:

```bash
codex-cli-bus status --agent cli-b
```

Inspect one task:

```bash
codex-cli-bus status --task task_x
```

Use these commands when the user asks natural-language questions like "what are the other CLIs doing?", "is cli-b blocked?", or "which worker has pending messages?" Summarize the JSON fields `status`, `current_task`, `liveness`, `queued_messages`, and `processing_messages`.

## Sending Work

Send a task:

```bash
codex-cli-bus send --from cli-a --to cli-b --type task --text "Run the focused tests and report failures."
```

Send a plain message:

```bash
codex-cli-bus send --from cli-a --to cli-b --type message --text "I updated the branch; please re-check."
```

The recipient claims work with:

```bash
codex-cli-bus poll --agent cli-b --claim
```

Reply to the parent:

```bash
codex-cli-bus reply --from cli-b --message msg_x --text "Tests passed."
```

Use `--type error` on `reply` when the worker is blocked or failed.

## Starting A Worker

For repeated delegation, start a persistent worker loop. This is the right choice when the user wants to keep sending tasks to an agent and have that agent automatically pick them up:

```bash
codex-cli-bus start-worker --from cli-a --agent cli-b --workspace .
```

This stores the child internally as `cli-a.cli-b`, but the user can continue referring to it as `cli-b` from `cli-a`.

The foreground form is useful for debugging:

```bash
codex-cli-bus worker-loop --agent cli-b --workspace .
```

For a real interactive Codex CLI worker in a new macOS Terminal window, use:

```bash
codex-cli-bus launch-codex --from cli-a --agent cli-b --workspace . --open-terminal --text "Audit the parser and reply with findings."
```

The new CLI starts with a bootstrap prompt that tells it how to claim one task and reply through the bus. It does not automatically listen for later tasks after that task is complete.

If a terminal should not be opened automatically, omit `--open-terminal`; the command returns a `shell_command` that can be run manually.

For a one-shot non-interactive worker, use:

```bash
codex-cli-bus spawn-codex --from cli-a --agent cli-b --workspace . --text "Audit the parser and reply with findings."
```

This starts `codex exec`, sends an initial task into the bus, and writes logs under the bus `logs/` directory. Use this only when the user has asked to delegate work or when delegation is necessary for the task.

For a generic local process:

```bash
codex-cli-bus spawn --agent cli-b --workspace . -- node ./worker.js
```

## Long-Running Work

Refresh status during long work:

```bash
codex-cli-bus heartbeat --agent cli-b --status running --task "running integration tests"
```

Mark a task manually if no reply should be sent:

```bash
codex-cli-bus complete --task task_x --status blocked --summary "Waiting for credentials."
```

Cancel work:

```bash
codex-cli-bus cancel --from cli-a --task task_x --reason "Superseded by a newer task."
```

Stop a worker that should no longer run:

```bash
codex-cli-bus stop-agent --from cli-a --agent cli-b --reason "No longer needed."
```

## Safety

Treat natural-language delegation as a request to use the structured protocol. Do not assume that a spawned worker has permission to run destructive commands. Preserve the user's approval and sandbox boundaries, and report exact task/message ids when the user needs traceability.
