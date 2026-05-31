# Codex CLI Bus

Codex CLI Bus 是一个本地文件型消息总线，用来协调多个 Codex CLI agent。它可以让一个主 Codex CLI 注册自己、启动 worker、派发任务、发送消息、查看状态，并通过共享 mailbox 接收结果。

这个项目既可以作为普通 Node.js CLI 工具使用，也可以作为 Codex CLI 插件使用。作为插件安装后，Codex 可以把自然语言请求转换为结构化的 MCP 工具调用，例如“启动一个 cli-b 跑测试并回报结果”。

详细架构说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 功能特性

- 本地文件协议，无需数据库或远程服务。
- 支持注册、心跳、状态查询、任务派发、消息回复和事件日志。
- 支持启动持久 worker，自动领取后续任务。
- 支持启动交互式 Codex CLI 或一次性的 `codex exec` worker。
- 支持 owner-local agent 命名，多个 controller 可以各自拥有同名 worker。
- 提供 MCP Server，可作为 Codex CLI 插件被自然语言调用。

## 运行要求

- Node.js 18 或更高版本。
- 如果要启动真实 Codex worker，需要本机已安装并可执行 `codex` 命令。
- 如果要作为 Codex 插件使用，需要本机 Codex CLI 支持插件和 MCP Server。

本项目没有运行时 npm 依赖。发布成 npm 包后会提供两个命令：

```bash
codex-cli-bus
codex-cli-bus-mcp
```

源码开发时也可以用等价命令：

```bash
node scripts/codex-cli-bus.mjs
node scripts/mcp-server.mjs
```

## 目录结构

```text
codex-cli-bus/
  .codex-plugin/
    plugin.json              # Codex 插件元信息
  .mcp.json                  # MCP Server 配置
  docs/
    ARCHITECTURE.md          # 架构与协议说明
  scripts/
    codex-cli-bus.mjs        # 核心 CLI、文件协议、worker loop
    mcp-server.mjs           # MCP stdio server
    protocol.schema.json     # 协议 JSON schema
    codex-cli-bus.test.mjs   # 测试
  skills/
    cli-bus/
      SKILL.md               # Codex 使用该插件时加载的技能说明
  package.json
  README.md
```

运行时数据默认写入：

```bash
~/.codex-cli-bus
```

也可以为测试或演示指定独立目录：

```bash
export CODEX_CLI_BUS_HOME="$PWD/.bus"
```

## 一键安装

发布到 npm 后，用户只需要执行：

```bash
npm install -g codex-cli-bus
codex-cli-bus install-plugin
```

`install-plugin` 会自动完成这些事情：

- 在 `~/.codex-cli-bus/plugin-marketplace` 生成本地 Codex marketplace。
- 在 marketplace 中生成 `codex-cli-bus` 插件目录。
- 写入可用的 `.mcp.json`，让 MCP Server 指向当前 npm 包里的 `scripts/mcp-server.mjs`。
- 执行 `codex plugin marketplace add ...`。
- 执行 `codex plugin add codex-cli-bus@codex-cli-bus-local`。

安装完成后，重新打开一个 Codex CLI 会话，让插件、技能和 MCP Server 生效。

如果你正在本仓库里本地开发，可以先链接本地包：

```bash
npm link
codex-cli-bus install-plugin
```

只生成插件文件、不执行 `codex plugin` 命令：

```bash
codex-cli-bus install-plugin --no-codex
```

自定义 marketplace 名称或目录：

```bash
codex-cli-bus install-plugin \
  --marketplace-name my-bus \
  --marketplace-root "$HOME/.codex-cli-bus/my-marketplace"
```

## 快速开始

进入项目目录后，先检查脚本是否可用：

```bash
npm run check
npm test
```

注册两个本地 agent：

```bash
codex-cli-bus register --agent cli-a --label controller
codex-cli-bus register --agent cli-b --label worker
```

从 `cli-a` 给 `cli-b` 发送任务：

```bash
codex-cli-bus send \
  --from cli-a \
  --to cli-b \
  --type task \
  --text "Run the focused test suite and report the result."
```

让 `cli-b` 领取任务：

```bash
codex-cli-bus poll --agent cli-b --claim
```

领取后会返回一个 `message_id`，用它回复任务结果：

```bash
codex-cli-bus reply \
  --from cli-b \
  --message msg_x \
  --text "Focused tests passed."
```

最后让 `cli-a` 查看回复：

```bash
codex-cli-bus poll --agent cli-a --claim
```

其中 `msg_x` 需要替换成实际返回的消息 ID。

## 常用命令

查看帮助：

```bash
codex-cli-bus help
```

列出 agent：

```bash
codex-cli-bus list
codex-cli-bus list --viewer cli-a
codex-cli-bus list --owner cli-a
```

查看单个 agent 或任务：

```bash
codex-cli-bus status --agent cli-b
codex-cli-bus status --task task_x
```

发送普通消息：

```bash
codex-cli-bus send \
  --from cli-a \
  --to cli-b \
  --type message \
  --text "The branch is ready. Please re-check."
```

查看任务列表：

```bash
codex-cli-bus tasks --viewer cli-a --limit 20
```

查看事件日志：

```bash
codex-cli-bus events --viewer cli-a --limit 20
```

停止一个 worker：

```bash
codex-cli-bus stop-agent \
  --from cli-a \
  --agent cli-b \
  --reason "No longer needed."
```

## 启动 Worker

如果希望 `cli-b` 常驻运行，并自动领取后续任务，可以使用：

```bash
codex-cli-bus start-worker \
  --from cli-a \
  --agent cli-b \
  --workspace .
```

这个命令会把 worker 存为 owner-local agent。用户看到的是 `cli-b`，内部实际 ID 是：

```text
cli-a.cli-b
```

如果同一个 owner 下的 `cli-b` 已经在线，默认会复用已有 worker。需要明确替换时再加：

```bash
codex-cli-bus start-worker \
  --from cli-a \
  --agent cli-b \
  --workspace . \
  --replace
```

调试时可以在前台运行 worker loop：

```bash
codex-cli-bus worker-loop \
  --agent cli-b \
  --workspace .
```

启动一个交互式 Codex CLI worker：

```bash
codex-cli-bus launch-codex \
  --from cli-a \
  --agent cli-b \
  --workspace . \
  --open-terminal \
  --text "Run npm test and reply with the failure summary."
```

启动一个一次性的非交互式 `codex exec` worker：

```bash
codex-cli-bus spawn-codex \
  --from cli-a \
  --agent cli-b \
  --workspace . \
  --text "Run npm test and reply with the failure summary."
```

worker 日志会写入：

```bash
$CODEX_CLI_BUS_HOME/logs/
```

## 作为 Codex CLI 插件使用

仓库中已经包含插件配置：

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `skills/cli-bus/SKILL.md`
- `scripts/mcp-server.mjs`

### 安装步骤

推荐使用 npm 包的一键安装命令：

```bash
npm install -g codex-cli-bus
codex-cli-bus install-plugin
```

安装命令默认使用 `codex-cli-bus-local` 作为 marketplace 名称。更新 npm 包后，重新执行一次即可刷新本地插件：

```bash
npm install -g codex-cli-bus@latest
codex-cli-bus install-plugin
```

手动安装时，Codex 插件需要先通过 marketplace 暴露出来，再从 marketplace 安装插件。项目的开发目录通常长这样：

```text
Cli-demo/
  .agents/
    plugins/
      marketplace.json
  codex-cli-bus/
    .codex-plugin/
      plugin.json
```

`marketplace.json` 中需要包含 `codex-cli-bus` 这一项，例如：

```json
{
  "name": "cli-demo",
  "interface": {
    "displayName": "CLI Demo"
  },
  "plugins": [
    {
      "name": "codex-cli-bus",
      "source": {
        "source": "local",
        "path": "./codex-cli-bus"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

如果你保持上面的目录结构，在 `codex-cli-bus` 目录里可以手动执行：

```bash
codex plugin marketplace add ..
codex plugin list --marketplace cli-demo
codex plugin add codex-cli-bus@cli-demo
```

如果你是在别的位置维护 marketplace，把 `..` 换成包含 `.agents/plugins/marketplace.json` 的目录即可。

安装后重新打开一个 Codex CLI 会话，让插件、技能和 MCP Server 生效。之后可以直接用自然语言操作：

```text
启动一个叫 cli-b 的 Codex CLI，让它在当前目录跑 npm test，然后把结果回给我。
```

```text
启动 cli-b 常驻 worker，让它自动领取后续任务。
```

```text
看看所有 CLI agent 当前在做什么，谁有未处理消息。
```

```text
给 cli-b 发消息：我刚改了协议，让它重新检查状态。
```

如果从 GitHub 克隆后使用手动 marketplace 安装，请检查 `.mcp.json` 是否适合你的安装方式。npm 一键安装会生成独立的插件目录和 MCP 配置，不需要手动改路径。开发或演示时也可以设置：

```bash
export CODEX_CLI_BUS_HOME="$PWD/.bus"
```

手动 marketplace 安装的插件更新后可以重新执行：

```bash
codex plugin add codex-cli-bus@cli-demo
```

然后开启新的 Codex CLI 会话测试更新后的插件。

## Agent 命名规则

controller 的 ID 是全局的，例如：

```text
cli-a
controller
controller-laptop
```

child worker 的名字是 owner-local 的。例如 `cli-a` 启动本地 `cli-b` 后：

```text
用户可见名: cli-b
内部 agent_id: cli-a.cli-b
owner_agent_id: cli-a
local_agent_id: cli-b
```

另一个 controller 也可以启动自己的 `cli-b`，内部会变成：

```text
cli-c.cli-b
```

因此不同 controller 的 worker 不会共享 mailbox、任务和状态。多个主 CLI 同时使用时，建议给每个 controller 设置不同的 `CODEX_AGENT_ID`：

```bash
export CODEX_AGENT_ID=cli-a
```

## 文件协议

总线数据写在 `CODEX_CLI_BUS_HOME` 下：

```text
CODEX_CLI_BUS_HOME/
  agents/
    records/                 # agent 注册记录
    ownership/               # owner-child 映射
  mailboxes/
    <agent>/
      inbox/                 # 待领取消息
      processing/            # 已领取待处理消息
      archive/               # 已完成消息
  tasks/                     # task 生命周期记录
  events/
    events.jsonl             # 事件日志
  logs/                      # worker stdout/stderr 日志
  tmp/
```

协议字段定义见 [scripts/protocol.schema.json](scripts/protocol.schema.json)。

## 开发

语法检查：

```bash
npm run check
```

运行测试：

```bash
npm test
```

架构和协议细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## GitHub 上传建议

上传前建议确认以下内容：

- `.bus/`、`node_modules/`、`.DS_Store` 已在 `.gitignore` 中忽略。
- 不要提交运行时生成的 mailbox、task、event、log 文件。
- 发布 npm 前先确认包名可用；如果 `codex-cli-bus` 已被占用，可以改成 scoped 包名，例如 `@your-name/codex-cli-bus`。
- 公开发布 npm 包前，建议补充 `repository`、`license` 和作者信息。
- 先执行 `npm run check` 和 `npm test`，确保脚本和协议测试通过。

## License

当前仓库还没有声明 License。公开发布到 GitHub 前，建议根据你的使用目标添加一个 `LICENSE` 文件，例如 MIT、Apache-2.0 或其他许可证。
