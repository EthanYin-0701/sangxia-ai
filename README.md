# 珍特 · 基于 Node.js 的 ACP Coding AI Agent

一个用 TypeScript 写的编程 AI agent：

- **兼容 ACP 协议**（[Agent Client Protocol](https://agentclientprotocol.com)）——通过 stdio 上的 JSON-RPC，可作为「外部 agent」接入 Zed 等 ACP 客户端。
- **自带 harness**——完整的 agent 主循环：流式输出 → 工具调用 → 权限确认 → 执行 → 回喂结果 → 收敛，支持取消。
- **JSON 配置 LLM**——把 API 链接（baseURL）、API key、模型名写在配置文件里；兼容任何 OpenAI 风格的 `/chat/completions` 端点。
- **可扩展能力**——除内置工具外，可连接 ACP 传入的 **MCP servers**（stdio/http/sse）动态获取工具，并支持本地 **技能（Skills）** 的渐进式加载。

## 快速开始

```bash
npm install
npm run build

# 复制并填写配置
cp zhente.config.example.json zhente.config.json
export OPENAI_API_KEY=sk-...        # 配置里用 ${OPENAI_API_KEY} 引用

# 冒烟测试（离线，无需 key）
npm run smoke          # 完整 ACP 握手 + 工具 + 权限流（mock provider）
npm run smoke:openai   # 真实 OpenAI 兼容流式路径（本地假服务器）

# 两种用法：接入 Zed 等 ACP 客户端（见「接入 Zed」），或直接在终端里用 TUI
node dist/index.js tui  # 终端界面（见「终端界面（TUI）」）
```

> 下文的 `zhente` 是 `package.json` 里声明的 bin 名；本地仓库直接用 `node dist/index.js …`，或先 `npm link` 让 `zhente` 进 PATH。

## 配置

解析顺序：`--config <path>` → `$ZHENTE_CONFIG` → `./zhente.config.json` → `~/.config/zhente/config.json`。
字符串值支持 `${ENV_VAR}` 环境变量插值，密钥不必落盘。

```jsonc
{
  "provider": {
    "type": "openai",                     // "openai" | "mock"
    "baseURL": "https://api.openai.com/v1",
    "apiKey": "${OPENAI_API_KEY}",
    "model": "gpt-4o",
    "models": [                           // 可选：在支持 ACP model selector 的 IDE 中显示
      { "modelId": "gpt-4o", "name": "GPT-4o", "description": "默认模型" }
    ],
    "temperature": 0,
    "maxTokens": 8192,
    "requestTimeoutMs": 120000,           // SDK 请求超时（毫秒）
    "streamIdleTimeoutMs": 60000,         // 等待首个/后续 chunk 的空闲上限
    "streamTotalTimeoutMs": 120000,       // 整次请求含 SSE 消费的总时长上限
    "streamRetries": 2,                   // 仅在“首个 delta 之前”失败时重试（网络抖动/429/5xx）
    "streamRetryBaseDelayMs": 500,        // 重试退避基数（指数增长，上限 8s；尊重 Retry-After）
    "streamIncludeUsage": false,          // 兼容端点可开启 stream_options.include_usage
    "extraHeaders": {}                     // 可选附加请求头
  },
  "agent": {
    "maxIterations": 40,                   // 单轮最多迭代次数
    "historyWarningMessages": 400,         // 历史消息数告警阈值（不自动裁剪）
    "toolTimeoutMs": 300000,               // 单次工具执行的默认 deadline（工具自身 timeoutMs / timeout 参数优先）
    "permissionMode": "confirm",           // "confirm" 每次确认（默认）| "auto" 跳过全部权限确认（危险）
    "systemPrompt": null                   // null 使用内置默认提示词
  },
  "mcp": {
    "enabled": true,                       // 是否连接 session/new 传入的 MCP servers
    "connectTimeoutMs": 15000              // 单个 server 连接 / 列举工具的超时
  },
  "skills": {
    "enabled": true,                       // 是否启用技能层
    "dirs": []                             // 额外技能目录；空=默认 <cwd>/skills 与 ~/.config/zhente/skills
  }
}
```

> **权限模式覆盖**：`permissionMode` 也可用 CLI 参数 `--permission-mode auto|confirm` 或环境变量 `ZHENTE_PERMISSION_MODE=auto|confirm` 覆盖（优先级：CLI > 环境变量 > 配置文件），方便在 IDE 的 ACP agent 配置（args/env）里按 agent 各自选择。旧字段 `autoApprove: true` 等价于 `permissionMode: "auto"`。

> **会话模型选择**：配置 `provider.models` 后，ZhenTe 会在 `session/new` / `session/load` 返回 ACP model 列表，并处理 `session/set_model`。`provider.model` 是新会话默认值，且必须出现在 `models` 中；未配置 `models` 时只暴露默认模型。

支持 ACP Session Modes 的客户端会在会话输入框下方显示权限下拉菜单：`Standard Access` 对应 `confirm`，`Full Access` 对应 `auto`。配置文件、CLI 或环境变量决定新会话的默认选项；在下拉菜单中的切换仅作用于当前会话，并随会话持久化。

> **切换模式会清空权限记忆**：`session/set_mode` 会同时清空该会话里已记住的「总是允许 / 总是拒绝」决策。ACP 没有单独的「重置授权」消息，因此这也是误按「总是拒绝」后唯一的恢复途径（Zed 里切一次模式、TUI 里 `/access standard` 或 `/permissions reset` 均可）。

### 兼容的端点

流式请求同时受空闲和总时长上限约束；`provider.models` 中的每个模型可用同名 `streamIdleTimeoutMs` / `streamTotalTimeoutMs`（以及 `streamRetries` / `streamRetryBaseDelayMs`）覆盖全局值。SDK 自动重试已关闭，避免隐藏重试扩大等待时间。超时会中止请求并显示空闲/总时长原因，ACP 返回 `refusal`；用户取消返回 `cancelled`。

**首 token 前有界重试**：网络抖动、429、5xx 这类失败若发生在**首个流式 delta 之前**（此时没有已展示内容、也没有副作用），ZhenTe 会按 `streamRetries`（默认 2 次）指数退避重试，并尊重响应里的 `Retry-After`。一旦已经流出内容就不再重试（否则会重复输出），自己的空闲/总时长 watchdog 也不重试（否则等待时间翻倍），中途失败仍按现状终止为 `refusal`。运行期取消（`session/cancel`、Ctrl+C）会立即打断退避等待。

模型返回 `length` 时显示“输出被截断”并返回 `max_tokens`，本次工具调用全部拒绝执行；服务端过滤、未知或缺失结束原因返回 `refusal`。仅正常 `stop` 且有正文时结束为 `end_turn`；空正文且无工具调用的 `stop` 最多补偿一次，补偿计入 `maxIterations`，不回传 reasoning。正文里的 JSON / function 标签只作诊断。

所有工具（含 MCP）在权限确认前验证 JSON object 和声明的 JSON Schema（支持 draft-07、2019-09、2020-12）；失败返回配对的工具错误，交给模型修正。不会补默认参数或强制转换类型。日志只记录流式字符计数、时序和 token usage 等指标，不记录完整 reasoning 或工具参数。历史达到阈值时告警，保留消息及工具调用配对。

**工具超时（deadline）**：单次工具调用受 `agent.toolTimeoutMs`（默认 300s）约束，工具可以用 `tool.timeoutMs`、单次调用可以用参数（如 `bash` 的 `timeout`，其自己的缺省是 120s）覆盖；超时后返回 `Error: 工具执行超时（Xms）已终止…`，该回合继续（模型可自行缩小范围或重试），只有用户取消才会中止整轮。超时 / 取消同时可能触发时以「取消」为准。deadline 只保证 harness 不再等待：非可中断的工具（纯读文件等）底层操作可能仍在后台跑完，harness 不会假装杀掉了它。

`bash` 本地回退路径用独立进程组启动 shell，超时或取消时 `SIGKILL` **整个进程组**，避免 `npm run …` 之类的孙进程继续存活（POSIX 语义；Windows 上回退为只杀直接子进程）。客户端终端路径同样受 `timeout` 约束，超时会调用 `terminal.kill()`，但其尾部输出的保真度取决于客户端实现。

工具输出超过上限时**头尾各保留**（中间用 `…(输出过长，已省略中间 N 字符，共 M 字符…)` 标记），因为构建/测试的报错几乎总在尾部。

任何暴露 OpenAI `/chat/completions`（含流式 + function calling）的服务都能用，只需改 `baseURL` / `model`：

| 服务 | baseURL | 示例 model |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-3.5-sonnet` |
| Ollama（本地） | `http://localhost:11434/v1` | `qwen2.5-coder` |
| LM Studio（本地） | `http://localhost:1234/v1` | 任意已加载模型 |
| vLLM | `http://<host>:8000/v1` | 部署的模型名 |

> 本地服务（Ollama/LM Studio）通常不校验 key，`apiKey` 随便填一个即可。

## 接入 Zed

在 Zed 的 `settings.json` 里加一个外部 agent（用编译产物的绝对路径）：

```jsonc
{
  "agent_servers": {
    "ZhenTe": {
      "command": "node",
      "args": ["/绝对路径/eye-zhen-te/dist/index.js"],
      "env": { "OPENAI_API_KEY": "sk-..." }
    }
  }
}
```

然后在 Zed 的 Agent 面板里选择 “ZhenTe”。Agent 会在你打开的项目目录下工作，读写文件走 Zed 的文件系统能力，命令走 Zed 的终端能力。

> 若不通过 Zed 提供的能力（`fs`/`terminal`），agent 会自动回退到本地 Node 的 `fs` 与 `child_process`。

## 能力总览

| 能力 | 内容 | 备注 |
|---|---|---|
| 文件操作 | `read_file` / `list_dir` / `glob` / `grep` / `write_file` / `edit_file` | 读类免权限；写/改需权限 |
| 命令执行 | `bash` | 需权限 |
| 任务计划 | `update_plan`（ACP `plan`） | 免权限 |
| 技能 (Skills) | `use_skill` 按需加载 `SKILL.md`；启动时扫描项目/全局技能目录并注入清单 | 免权限 |
| MCP 工具 | 接入 `session/new` 传入的 MCP servers（stdio/http/sse），命名 `mcp__<server>__<tool>` | 默认需权限 |
| 流式输出 | 正文 + 思考(reasoning) 增量流（`agent_message_chunk` / `agent_thought_chunk`） | — |
| 权限控制 | 变更类工具执行前 `session/request_permission`（可"总是允许/拒绝"并记忆） | — |
| LLM 后端 | 任意 OpenAI 兼容 `/chat/completions`（`openai` / `mock` provider），JSON 配置 | 可换 baseURL/model |
| 取消 | `session/cancel` 中断进行中的 turn | — |
| 终端界面 | `zhente tui`：同进程 ACP 配对的聊天式 TUI（流式/工具行/权限弹窗/斜杠命令） | 见「终端界面（TUI）」 |

## 内置工具

| 工具 | 作用 | 需要权限 |
|---|---|---|
| `read_file` | 读文件（可按行截取） | 否 |
| `list_dir` | 列目录 | 否 |
| `glob` | 按 glob 找文件 | 否 |
| `grep` | 按正则搜内容 | 否 |
| `write_file` | 写/建文件 | ✅ |
| `edit_file` | 精确字符串替换 | ✅ |
| `bash` | 执行 shell 命令 | ✅ |
| `update_plan` | 发布/更新任务计划（ACP `plan`） | 否 |
| `use_skill` | 按名加载某个技能的 `SKILL.md` 正文（见「技能」） | 否 |

需要权限的工具在执行前会通过 ACP `session/request_permission` 征求用户同意（可选“总是允许/拒绝”）。此外，每个会话还会动态加入下述 **MCP 工具** 与 **技能**。

## MCP 工具

ACP 客户端在 `session/new` 时传入的 `mcpServers` 会被逐个连接（`src/mcp/client.ts`），其远端工具动态并入该会话的工具集：

- **传输**：stdio（`command`/`args`/`env`，必选支持）、Streamable HTTP、SSE（`url`/`headers`）；`initialize` 已声明 `mcpCapabilities: { http, sse }`。
- **命名**：远端工具以 `mcp__<server>__<tool>` 暴露给模型，避免与内置工具/彼此重名。
- **权限**：MCP 工具默认 `needsPermission=true`（外部副作用未知），首次调用走 `session/request_permission`。
- **隔离**：单个 server 连接失败只告警并跳过，不影响其余工具与会话。
- **开关**：`config.mcp.enabled` / `config.mcp.connectTimeoutMs`。

> ACP 0.4.5 无「会话结束」事件，故 MCP 连接在 agent 进程退出时统一关闭。

## 技能 (Skills)

一个轻量的「渐进式披露」技能层（`src/skills/index.ts`）：启动时扫描技能目录，只把**名称 + 描述**清单注入 system prompt；模型按需用 `use_skill` 拉取某技能的完整正文进上下文。

每个技能一个子目录，内含 `SKILL.md`（frontmatter + 正文）：

```markdown
---
name: my-skill
description: 一句话说明何时用它（会进 system prompt 清单）
---
详细操作步骤……（仅在 use_skill 调用时才加载进上下文）
```

- **发现目录**：默认 `<cwd>/skills` 与 `~/.config/zhente/skills`（同名时项目优先）；可用 `config.skills.dirs` 覆盖/追加（相对路径按会话 cwd 解析）。
- **开关**：`config.skills.enabled`。

## 架构

```
入口 A  stdio (JSON-RPC / ACP)     ← Zed 等 ACP 客户端驱动
入口 B  zhente tui (src/tui/)      ← 界面自带 ClientSideConnection，
        │                            经内存流 PassThrough 与下方 agent 配对；
        │                            两个入口走完全相同的协议路径
        ▼
   AgentSideConnection            ← @zed-industries/agent-client-protocol
        │
   ZhenTeAgent (src/agent.ts)     ← initialize / newSession / prompt / cancel
        │                            newSession: 连接 MCP + 发现技能 → 组装本会话工具集
   harness/loop.ts  ──►  LLMProvider (llm/*)      OpenAI 兼容 / mock
        │            └─►  ToolRegistry(每会话)     内置(tools/*) + MCP(mcp/*) + use_skill(skills/*)
        │            └─►  permissions.ts           session/request_permission
   Session (src/session.ts)       ← 每会话历史 / cwd / 权限记忆 / 取消 / MCP 连接 / 技能
```

- **stdout 是协议通道**，所有日志走 stderr（`ZHENTE_LOG_FILE` 可另存为单个文件；`ZHENTE_LOG_DIR` 可按 session 分文件，见下；`ZHENTE_LOG_LEVEL` 调级别）。日志默认使用运行进程的本地时区，并在时间戳中包含 UTC 偏移量；如 ACP 宿主时区不正确，可设置 `ZHENTE_LOG_TIMEZONE=Asia/Shanghai`。TUI 模式下 stdout 是渲染目标而非协议通道，因此启动时会 `logger.configure({ stderr: false, … })` 把日志只写进文件。
- **按 session 分日志**：设置 `ZHENTE_LOG_DIR=<目录>` 后，每个 session 的日志写入 `<目录>/<sessionId>.log`（启动、`initialize` 等无 session 的日志写入 `<目录>/global.log`）。session 归属基于 Node `AsyncLocalStorage`（`logger.withSession`），多 session 并发执行时日志也不会串文件；行内带 `[session=<id>]` 标记；同时设置时 `ZHENTE_LOG_DIR` 优先于 `ZHENTE_LOG_FILE`。
- Provider 是接口，新增后端（如 Anthropic 原生）只需实现 `LLMProvider` 再在 `llm/factory.ts` 注册。
- 会话工具集在 `newSession`/`loadSession` 组装：内置工具 + `use_skill`（若发现技能）+ 已连接的 MCP 工具（`src/agent.ts`）。
- 会话历史默认持久化到 `~/.config/zhente/sessions/<sessionId>.json`，可用 `ZHENTE_SESSION_DIR` 修改目录；支持 ACP `session/load` 恢复历史。
- 新会话会自动加载项目根目录的 `AGENTS.md` 和 `.zhente/memory.md`，用于保存跨 session 的项目约定与进度。
- 如果上述任一文件缺失，第一次正式 prompt 前会请求用户确认；确认后 agent 会先扫描项目并只补齐缺失的记忆文件，再执行原始任务。
- 一次 prompt 的完整时序见 [`doc/uml/prompt-turn.md`](doc/uml/prompt-turn.md)。

## 终端界面（TUI）

`zhente tui` 在真实终端里启动一个聊天式 TUI，与 Zed 走**同一套 ACP 协议**：内部把同一个 `ZhenTeAgent` 通过内存流配对到客户端侧，stdio 只归界面（渲染 + 键盘）。

```bash
zhente tui                          # 需要 stdin 与 stdout 均为 TTY；非 TTY 会友好报错
zhente tui --crt                    # 可选 CRT 黑底模式（默认不强制黑底）
zhente tui --config ./other.json    # 与 ACP 模式共用同一套配置解析
zhente tui --permission-mode auto   # 直接以 FULL ACCESS 启动（首帧即有红色 badge + 横幅）
```

- **布局**：状态栏（agent · 当前模型 · cwd + 权限 badge）→ 对话区（流式回答/工具行/TODO 计划）→ 权限弹窗（confirm 模式）→ 输入行。配色红/绿/白三色（安全=绿、危险/错误=红、正文=白，**颜色永不作唯一通道**）；设置 `NO_COLOR` 可去色。
- **斜杠命令**（纯客户端本地命令）：
  - `/model [modelId]` 查看/切换模型（配置 `provider.models`；无参数弹选择器；模型**下一轮生效**，状态栏带 `*` 待生效标记）。
  - `/access` 只显示当前权限模式；`/access full` 进入 FULL ACCESS（需二次确认，变更不再请求确认，红横幅+badge）；`/access standard` 切回每次确认。切换会清空本会话"总是允许/总是拒绝"记忆。
  - `/permissions reset` 清空记住的授权决策（等价于重发一次 `set_mode`）；`/help`、`/clear`（只清屏，不动会话历史）、`/new`（重开会话，仅空闲时可用）、`/quit`。
- **快捷键**：Enter 发送（上一轮未结束时禁用，Ctrl+C 可取消该轮）、↑/↓ 输入历史、Tab 补全命令/modelId、Ctrl+C 清空输入行（turn 中 = 取消）、Ctrl+U 删到行首、Ctrl+W 删词、Ctrl+A/Ctrl+E 行首/行尾、Ctrl+D 删字符（空行 = 退出）、PgUp/PgDn 与 Shift+↑/↓ 滚动对话区、Esc 关弹窗。权限弹窗支持数字键直选或 ↑/↓ + Enter；模型选择器用 ↑/↓ + Enter，Esc 取消。
- **粘贴**：启用了终端 bracketed paste，粘贴多行文本不会被当成多次回车——换行会归一成空格并入单行输入（v1 是单行编辑器）。
- **日志**：TUI 模式下日志不打印到屏幕，只写入 `ZHENTE_LOG_DIR`（未设置时为系统临时目录 `zhente-tui-logs/`），级别默认降到 `warn`。
- **已知差异**：TUI 不向 agent 声明 `fs` / `terminal` 能力，文件读写与 `bash` 都走本地 Node 回退——`bash` 输出在命令结束时一次性返回（工具行的 spinner + 计时是"仍在运行"的唯一信号）；Zed 里则走编辑器的终端、输出实时可见。

## 开发

```bash
npm run dev         # tsx 直跑 src/index.ts
npm run typecheck   # 仅类型检查
npm run build       # 编译到 dist/
npm run smoke        # ACP 握手 + 工具 + 权限流冒烟（mock provider）
npm run smoke:openai # 真实 OpenAIProvider 流式路径（本地假服务器）
npm run smoke:mcp    # MCP 工具 + 技能冒烟
npm run smoke:tui    # TUI 层 headless 冒烟（命令/输入/通知映射/内存配对/取消）
npm run smoke:reliability # 截断/空响应/Schema/超时/取消与断连回归
```

## 目前未覆盖（预留扩展点）

- Anthropic 原生 provider（接口已就绪）。
- 图片/音频输入（`initialize` 里 `promptCapabilities.image/audio` 均为 false）。
- MCP 连接的按会话回收（当前在进程退出时统一关闭；ACP 0.4.5 无会话结束事件）。
- TUI v2：`/resume`（`session/load` 续持久化会话）、权限弹窗内的实时 `bash` 输出（客户端 `createTerminal`）、多行输入。

> 权限模式（`session/set_mode`）与模型选择（`session/set_model`）已实现，见上文「配置」。
