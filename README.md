# Sangxia.ai · 基于 Node.js 的 ACP Coding AI Agent

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
cp sangxia.config.example.json sangxia.config.json
export OPENAI_API_KEY=sk-...        # 配置里用 ${OPENAI_API_KEY} 引用

# 冒烟测试（离线，无需 key）
npm run smoke          # 完整 ACP 握手 + 工具 + 权限流（mock provider）
npm run smoke:openai   # 真实 OpenAI 兼容流式路径（本地假服务器）

# 两种用法：接入 Zed 等 ACP 客户端（见「接入 Zed」），或直接在终端里用 TUI
node dist/index.js tui  # 终端界面（见「终端界面（TUI）」）
```

> 下文的 `sangxia` 是 `package.json` 里声明的 bin 名；本地仓库直接用 `node dist/index.js …`，或先 `npm link` 让 `sangxia` 进 PATH。

## 配置

解析顺序：`--config <path>` → `$SANGXIA_CONFIG` → `./sangxia.config.json` → `~/.config/sangxia/config.json`。
字符串值支持 `${ENV_VAR}` 环境变量插值，密钥不必落盘。

**配置分层（D16）**：`~/.config/sangxia/config.json` 是**全局 base**，永远先加载，上面这份主配置作为 **overlay** 叠加（深合并，overlay 胜；只有 `hooks.events.*` 是**数组追加**，base 先、overlay 后）。于是：

- 项目里只需要写"和全局不一样的东西"（例如只写 `provider`），全局的 `hooks` 照样生效；
- **全局 hook 不能被某个项目配置静默删掉** —— 唯一关掉方式是显式 `"hooks": { "enabled": false }`（这是有意的：否则打开一个带 `sangxia.config.json` 的仓库就能悄悄卸掉你的守卫 hook）；
- 反过来，全局配置写错（未知事件名、路径形态命令不存在等）会让**所有**项目启动失败 —— 这是 fail fast 的代价，报错信息里会指名具体文件与条目；
- 项目里没有任何配置文件时，全局配置可以独立当配置用（`provider` + `hooks` 都写它即可）。

和分层配置同一思路的还有 **`~/.config/sangxia/AGENTS.md`（用户级长期指令）**：它不是配置项，而是一份纯 markdown，每次都进 system prompt、对所有项目生效（见「架构」一节的项目记忆说明）。

```jsonc
{
  "provider": {
    "type": "openai",                     // "openai" | "mock"
    "baseURL": "https://api.openai.com/v1",
    "apiKey": "${OPENAI_API_KEY}",
    "model": "gpt-4o",
    "models": [                           // 可选：在支持 ACP model selector 的 IDE 中显示
      // 每个模型可用 maxTokens / firstChunkTimeoutMs / streamIdleTimeoutMs /
      // streamTotalTimeoutMs / streamRetries / streamRetryBaseDelayMs
      // 覆盖同名全局值（未设置则继承）
      { "modelId": "gpt-4o", "name": "GPT-4o", "description": "默认模型", "maxTokens": 32768 }
    ],
    "temperature": 0,
    // "maxTokens": 8192,                 // 单次回复的输出上限（思考+正文+工具参数共用，见下）；
                                           // 不设置时不发送 max_tokens，交给后端自己的默认值
                                           // （如 DeepSeek 思考模式默认 64K，reasoning_effort=max 时 128K）
    "requestTimeoutMs": 120000,           // SDK 请求超时（毫秒）
    "firstChunkTimeoutMs": 600000,        // 首个流式 chunk 前的等待上限（连接建立 + 服务端排队）；
                                           // 默认 10 分钟，对齐 DeepSeek 高负载时的服务端断连窗口
    "streamIdleTimeoutMs": 60000,         // 首个 chunk 之后，chunk 之间的空闲上限
    "streamTotalTimeoutMs": 120000,       // 整次请求含 SSE 消费的总时长上限
    "streamRetries": 2,                   // 仅在“首个 delta 之前”失败时重试（网络抖动/429/5xx）
    "streamRetryBaseDelayMs": 500,        // 重试退避基数（指数增长，上限 8s；尊重 Retry-After）
    "streamIncludeUsage": true,            // 请求 stream_options.include_usage；不支持的端点会忽略该字段
    "passBackReasoning": "all",            // "all"（默认）把捕获的 reasoning_content 回传给后端；"none" 为不支持该字段的端点提供退路
    "extraHeaders": {}                     // 可选附加请求头
  },
  "agent": {
    "maxIterations": 120,                  // 单轮最多迭代次数
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
    "dirs": []                             // 额外技能目录；空=默认 <cwd>/skills 与 ~/.config/sangxia/skills
  },
  "hooks": {                               // 生命周期钩子（默认关闭），见「Hook（生命周期钩子）」
    "enabled": false,                      // 总开关：升级后行为完全不变，显式开启才生效
    "timeoutMs": 60000,                    // 单条 hook 的默认超时
    "onError": "allow",                    // 超时/崩溃/输出不可解析时："allow"（默认）| "deny"（fail-closed）
    "shell": null,                         // null = 平台默认（/bin/sh -c）；可指定 "/bin/bash"
    "projectFile": {                       // 项目级 hooks（随仓库分发的 .sangxia/hooks.json）
      "enabled": false,                    // 默认关闭：打开一个仓库不应执行它的任意命令（供应链风险）
      "path": ".sangxia/hooks.json"
    },
    "events": {                            // 事件名与 Claude Code 基本对齐（见下）
      // 配置级 hook 一律写绝对路径或 ${HOME}/…：相对路径的解析基准是**本配置文件
      // 所在目录**（不是 session cwd），写错位置会在加载期直接报错（fail fast）
      "session_start": [],
      "user_prompt_submit": [],
      "pre_tool_use": [
        // { "name": "guard-writes", "matcher": "^(write_file|edit_file)$", "command": "bash ${HOME}/.config/sangxia/hooks/guard-writes.sh" },
        // { "name": "guard-bash", "matcher": "^bash$", "command": "bash ${HOME}/.config/sangxia/hooks/guard-bash.sh", "onError": "deny" },
        // MCP 工具用注册名（带前缀）：{ "name": "guard-mcp", "matcher": "^mcp__router__execute_terminal_command$", "command": "…" }
      ],
      "post_tool_use": [],
      "turn_end": [],
      "session_end": []
    }
  }
}
```

> **权限模式覆盖**：`permissionMode` 也可用 CLI 参数 `--permission-mode auto|confirm` 或环境变量 `SANGXIA_PERMISSION_MODE=auto|confirm` 覆盖（优先级：CLI > 环境变量 > 配置文件），方便在 IDE 的 ACP agent 配置（args/env）里按 agent 各自选择。旧字段 `autoApprove: true` 等价于 `permissionMode: "auto"`。

> **会话模型选择**：配置 `provider.models` 后，Sangxia 会在 `session/new` / `session/load` 返回 ACP model 列表，并处理 `session/set_model`。`provider.model` 是新会话默认值，且必须出现在 `models` 中；未配置 `models` 时只暴露默认模型。

支持 ACP Session Modes 的客户端会在会话输入框下方显示权限下拉菜单：`Standard Access` 对应 `confirm`，`Full Access` 对应 `auto`。配置文件、CLI 或环境变量决定新会话的默认选项；在下拉菜单中的切换仅作用于当前会话，并随会话持久化。

> **切换模式会清空权限记忆**：`session/set_mode` 会同时清空该会话里已记住的「总是允许 / 总是拒绝」决策。ACP 没有单独的「重置授权」消息，因此这也是误按「总是拒绝」后唯一的恢复途径（Zed 里切一次模式、TUI 里 `/access standard` 或 `/permissions reset` 均可）。

### 兼容的端点

流式请求受三个独立上限约束：`firstChunkTimeoutMs`（首个 chunk 前，覆盖连接建立 + 服务端排队）、`streamIdleTimeoutMs`（首个 chunk 之后，chunk 之间的空闲上限）、`streamTotalTimeoutMs`（整次请求的总时长）；`provider.models` 中的每个模型都可用同名字段（以及 `streamRetries` / `streamRetryBaseDelayMs`）覆盖全局值。SDK 自动重试已关闭，避免隐藏重试扩大等待时间。超时会中止请求并显示首 chunk/空闲/总时长原因，ACP 返回 `refusal`（首 chunk 超时除外，见下）；用户取消返回 `cancelled`。

`firstChunkTimeoutMs` 单独拆分是因为它和 `streamIdleTimeoutMs` 的语义不同：高负载的 DeepSeek 端点排队时会持续发送 SSE 注释行 `: keep-alive`，而 openai SDK 会在产生 chunk 之前就丢弃注释行——也就是说这段等待对 Sangxia 完全不可见，无法用"空闲"计时去衡量。旧版用同一个 60s 空闲上限覆盖这段等待，在生产日志里观测到过 14 次首 chunk 等待超过 30 秒（最长 66.9 秒），若换成更短的空闲阈值本会被直接杀掉且不重试。现在这段等待由 `firstChunkTimeoutMs`（默认 10 分钟，对齐 DeepSeek 服务端"10 分钟未开始推理即断连"的窗口）单独承担，而且——因为这个阶段还没有任何内容流出——**允许重试**（走 `streamRetries` 同一套指数退避），不像空闲/总时长超时那样直接终止为 `refusal`。等待期间 TUI/ACP 的"思考"提示会每 20 秒刷新一次已等待时长，避免长时间排队被误认为卡死。

**关于 `maxTokens`（输出上限）**：这是**单次回复**的输出上限，由「思考过程（reasoning）+ 正文 + 工具调用参数」**共用**，并且很多后端会把它计入上下文预算（`prompt_tokens + max_tokens ≤ 上下文窗口`，超了直接 400）。因此：

- **默认不设置**：不写 `provider.maxTokens` 时请求里根本不带 `max_tokens` 字段，交给后端自己的默认值生效。这对思考型后端很关键——DeepSeek 思考模式的服务端默认是 **64K**（`reasoning_effort=max` 时 128K），比 Sangxia 过去硬编码的 8192 高得多；主动设一个更小的值只会主动收窄预算，没有任何好处。
- 思考型模型给 8K 基本等于不可用——实测有 `reasoningChars=28987 / contentChars=0` 的截断，即预算全烧在思考上、正文一个字都没出（表现为「模型响应为空」）。这正是硬编码小值的后果，不设置就不会遇到。
- 写文件也吃这个池子：一次 1.9 万字符的 `write_file` 参数就约 5k tokens，加上思考很容易撞顶；撞顶时本次响应的工具调用会被整体拒绝（避免半截参数乱跑），整个回合以 `max_tokens` 结束。
- 需要更大上限、或后端没有合理默认值（如普通非思考模型）时，可显式设置 `provider.maxTokens`（或按模型在 `provider.models[].maxTokens` 单独设置）；先看后端的上下文窗口，取 `max_tokens ≤ 窗口 − 你实际遇到的最大 prompt`。
- 调大不额外花钱（按实际输出计费），但会放宽单轮的最坏延迟。
- 撞顶时提示会写明实际额度：显式配置过就是 `[输出被截断] …（maxTokens=8192）`，未配置则是「使用服务端默认额度」并给出 DeepSeek 的参考值；日志同时记录当次 `textChars/reasoningChars/toolCalls`，便于判断是思考、正文还是工具参数吃掉了预算。

**关于 `reasoning_content`（思考内容回传）**：带 `tools` 的请求（Sangxia 每次都带），DeepSeek 思考模式要求把此前每一轮 assistant 消息的 `reasoning_content` 原样回传——哪怕那一轮没有发起工具调用；不回传会直接 400（生产日志里已经撞到过一次，且是偶发/条件式的，无法重试）。Sangxia 会把每轮的 reasoning 累积进对应的 assistant 消息（随会话文件落盘，`session/load` 后仍带），并在下一次请求里原样带上。不需要任何配置；`provider.passBackReasoning: "none"` 是给不认识该字段、且会因为多余字段报错（而不是忽略）的非 DeepSeek 端点留的退路。日志只统计 `reasoningChars`，从不打印思考正文。

**首 token 前有界重试**：网络抖动、429、5xx 这类失败若发生在**首个流式 delta 之前**（此时没有已展示内容、也没有副作用），Sangxia 会按 `streamRetries`（默认 2 次）指数退避重试，并尊重响应里的 `Retry-After`。一旦已经流出内容就不再重试（否则会重复输出），自己的空闲/总时长 watchdog 也不重试（否则等待时间翻倍），中途失败仍按现状终止为 `refusal`。运行期取消（`session/cancel`、Ctrl+C）会立即打断退避等待。

**错误提示中文化**：401/402/400/422/429/503 这几类常见状态码会被翻译成中文、可操作的提示（而不是原样转发英文 SDK 报错），例如 402 会提示"余额不足，请前往 platform.deepseek.com 充值"——这是 DeepSeek 用户最常见的"莫名失败"。识别不了的状态码/错误仍原样显示 SDK 报错文本，不会丢信息。

模型返回 `length` 时显示“输出被截断”并返回 `max_tokens`，本次工具调用全部拒绝执行；服务端过滤、未知或缺失结束原因返回 `refusal`。仅正常 `stop` 且有正文时结束为 `end_turn`；空正文且无工具调用的 `stop` 最多补偿一次，补偿计入 `maxIterations`（该轮若有 reasoning 仍会随 assistant 消息回传，见上）。正文里的 JSON / function 标签只作诊断。

所有工具（含 MCP）在权限确认前验证 JSON object 和声明的 JSON Schema（支持 draft-07、2019-09、2020-12）；失败返回配对的工具错误，交给模型修正。不会补默认参数或强制转换类型。日志只记录流式字符计数、时序和 token usage 等指标，不记录完整 reasoning 或工具参数。历史达到阈值时告警，保留消息及工具调用配对。

**工具超时（deadline）**：单次工具调用受 `agent.toolTimeoutMs`（默认 300s）约束，工具可以用 `tool.timeoutMs`、单次调用可以用参数（如 `bash` 的 `timeout`，其自己的缺省是 120s）覆盖；超时后返回 `Error: 工具执行超时（Xms）已终止…`，该回合继续（模型可自行缩小范围或重试），只有用户取消才会中止整轮。超时 / 取消同时可能触发时以「取消」为准。deadline 只保证 harness 不再等待：非可中断的工具（纯读文件等）底层操作可能仍在后台跑完，harness 不会假装杀掉了它。

`bash` 本地回退路径用独立进程组启动 shell，超时或取消时 `SIGKILL` **整个进程组**，避免 `npm run …` 之类的孙进程继续存活（POSIX 语义；Windows 上回退为只杀直接子进程）。客户端终端路径同样受 `timeout` 约束，超时会调用 `terminal.kill()`，但其尾部输出的保真度取决于客户端实现。

**Prompt 规模估算**：每次请求前会按启发式（ASCII 约 4 字符/token、非 ASCII 约 1.5 字符/token，加每消息开销与工具 schema）估算 prompt token 数并写日志（`estimatedPromptTokens=… rawEstimate=… lastPromptTokens=…`）。若后端返回 `usage.prompt_tokens`（需 `streamIncludeUsage: true`），下一次估算会用实测值与上次估算的比值做校准（比例夹在 0.5×–2× 之间，防单次异常值）。**这只是启发式，仅用于阈值判断和排障，不参与发送内容**。

**缓存命中率**：若后端在 `usage` 里报告 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（DeepSeek 始终会，其他端点可能以 `prompt_tokens_details.cached_tokens` 表达同一个数），每轮结束的日志行会带上 `cacheHitRatio=`（无数据时为 `n/a`）。DeepSeek 的未命中价是命中价的 50 倍，这是判断成本是否正常的第一手数据。

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

## 会话持久化

会话按事件流落盘到 `$SANGXIA_SESSION_DIR`（默认 `~/.config/sangxia/sessions/`），每个会话一个 `<sessionId>.jsonl`，**只追加、不重写**（避免长会话的全量重写放大）：

```jsonc
{"t":"meta","version":2,"sessionId":"…","cwd":"…","permissionMode":"confirm","modelId":"…","createdAt":"…"}
{"t":"message","message":{…}}                 // 历史消息，按序
{"t":"tool_started","toolCallId":"…","name":"bash","at":"…"}   // 写于工具真正启动之前
{"t":"tool_finished","toolCallId":"…","status":"completed","at":"…"}
{"t":"reset","messages":[…]}                  // 历史被整体替换（如中途修复）
{"t":"mode","permissionMode":"…"} / {"t":"model","modelId":"…"}
```

- 崩溃只会留下一个写了一半的**末行**，读取时忽略；中间的坏行跳过并告警。
- `tool_started` 是判断"工具到底跑没跑"的唯一证据：进程被中断后重新加载会话时，启动过但结果缺失的调用会被修补成「结果未知…请先核实外部状态」，未启动过的则修补成「未执行…可以安全重试」。日志里没有任何 `tool_started`（旧格式）时一律按保守的「结果未知」处理。
- 兼容旧格式：存在 `<sessionId>.json` 快照时会在首次读取时迁移为 JSONL（原文件删除），此后只写 JSONL。
- `sessionId` 来自客户端，写文件前会过白名单校验（`^[a-zA-Z0-9-]+$`）防路径注入。

## 接入 Zed

在 Zed 的 `settings.json` 里加一个外部 agent（用编译产物的绝对路径）：

```jsonc
{
  "agent_servers": {
    "Sangxia": {
      "command": "node",
      "args": ["/绝对路径/sangxia-ai/dist/index.js"],
      "env": { "OPENAI_API_KEY": "sk-..." }
    }
  }
}
```

然后在 Zed 的 Agent 面板里选择 “Sangxia”。Agent 会在你打开的项目目录下工作，读写文件走 Zed 的文件系统能力，命令走 Zed 的终端能力。

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
| 生命周期钩子 | `hooks.events.*` 声明外部命令，在 session/prompt/工具/turn 点位拦截、改写参数、注入上下文、审计（见「Hook（生命周期钩子）」） | 默认关闭；`deny`/`ask` 在 auto 模式下同样生效 |
| LLM 后端 | 任意 OpenAI 兼容 `/chat/completions`（`openai` / `mock` provider），JSON 配置 | 可换 baseURL/model |
| 取消 | `session/cancel` 中断进行中的 turn | — |
| 终端界面 | `sangxia tui`：同进程 ACP 配对的聊天式 TUI（流式/工具行/权限弹窗/斜杠命令） | 见「终端界面（TUI）」 |

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

- **发现目录**：默认 `<cwd>/skills` 与 `~/.config/sangxia/skills`（同名时项目优先）；可用 `config.skills.dirs` 覆盖/追加（相对路径按会话 cwd 解析）。
- **开关**：`config.skills.enabled`。

## Hook（生命周期钩子）

Hook 让你用**外部命令**在固定点位介入 agent 生命周期——策略拦截、参数改写、把 lint/测试结果回喂模型、审计每一次工具执行——不需要改 Sangxia 代码，也不依赖 ACP 客户端（**TUI 下同样可用**，与 MCP 相反）。

三个定位要点：

- **Hook 不是工具**：不暴露给模型，模型看不见也调不动。
- **Hook 不是权限的替代**：`allow` 只表示"hook 没意见"，**不会**跳过 `session/request_permission`；只有 `deny` 是强制的。
- **Hook 失败不影响 turn 收敛**：任何异常都被捕获，最坏是"少一次拦截 + 一条 warn 日志"；需要 fail-closed 就显式配 `onError: "deny"`。

### 事件与插入点

| 事件 | 触发点 | 可否阻塞 | `matcher` |
|---|---|---|---|
| `session_start` | `session/new` / `session/load` 建立会话后 | 否（只注入上下文） | `source`（`startup`\|`resume`） |
| `user_prompt_submit` | 提交 prompt 后、进入 turn 前（含项目初始化之前） | **是**（deny ⇒ `refusal`，不进历史、不调模型） | — |
| `pre_tool_use` | 参数校验通过后、**权限确认之前** | **是** | 工具名（正则） |
| `post_tool_use` | 工具执行返回（或超时/抛错）后 | 否（只能追加上下文） | 工具名（正则） |
| `turn_end` | 每次 prompt 的每条退出路径（含取消、初始化子 turn） | 否 | — |
| `session_end` | 进程退出（`shutdown`，2s 硬上限） | 否 | — |

`matcher` 是事件级过滤器（JS 正则）：工具事件作用于**工具注册名**，`session_start` 作用于 `source`（`startup` = `session/new`，`resume` = `session/load`，与 codex 的 `SessionStart` 一致）；其它事件没有可匹配字段，配了会被忽略并 warn 一次（写错位置不该静默生效）。事件名写错（如驼峰 `sessionStart`）会**加载期直接报错**，不会静默什么都不做。

`pre_tool_use` 在权限确认**之前**、也在 `tool_call` 通知之前：因此客户端显示的标题、`rawInput`、以及**人类在弹窗里批准的参数**与真正执行的参数三者一致——不存在"人批准了 A、实际跑了 B"。`post_tool_use` 覆盖成功、超时与抛错路径（失败也要能审计）。

### 协议：stdin 信封 → stdout 决策 + 退出码

每个 hook 进程启动后，stdin 收到**一个 JSON 对象 + `\n`** 然后 EOF：

```jsonc
{
  "hook_event_name": "pre_tool_use",
  "session_id": "…", "cwd": "/path/to/project",
  "permission_mode": "confirm", "model_id": "deepseek-v4-flash",
  "hook_name": "guard-writes", "timestamp": "2026-01-01T00:00:00.000Z",
  // 事件附加字段：pre/post_tool_use: tool_name/tool_call_id/tool_kind/tool_input/tool_title
  //               （post 另有 tool_output/tool_error/tool_elapsed_ms）
  //   user_prompt_submit: prompt    session_start: source(startup|resume)/mcp_servers/skills
  //   turn_end: stop_reason/iterations/elapsed_ms/turn_kind（main|init）  session_end: reason
  "tool_input": { "path": "src/a.ts" }
}
```

stdout 输出决策 JSON（允许有噪声，解析器会逐行找）：先

```jsonc
{ "decision": "allow" | "deny" | "ask", "reason": "…",
  "hookSpecificOutput": {
    "updatedInput": { /* pre_tool_use：**整体替换**参数，不是补丁 */ },
    "updatedPrompt": "…",              // 仅 user_prompt_submit
    "additionalContext": "…"           // session_start / post_tool_use：注入上下文
  } }
```

退出码语义：

| 退出码 | 语义 |
|---|---|
| `0` | 采用 stdout 决策；**空 stdout = allow**（纯审计型 hook 的正常形态） |
| `2` | **阻塞** ⇒ `deny`，原因取 stdout 的 `reason` 或 stderr 末尾 500 字符（优先于 `onError`） |
| 其它非 0 / 超时 / 被杀 | 执行失败，按 `onError`（默认 allow）处理 |

最简单的一条拦截脚本只要几行：

```sh
#!/bin/sh
input=$(cat)
case "$input" in *'"tool_name":"bash"'*'"rm -rf /"'*) echo "禁止删除根目录" >&2; exit 2;; esac
exit 0
```

### 决策语义

- **`deny`**：`pre_tool_use` 直接回一个失败的 tool result（`Error: 被 hook <name> 拒绝：<reason>`，不弹权限、不执行，且必须回填历史以保持 `tool_calls` 配对）；`user_prompt_submit` 则向客户端说明原因并返回 `refusal`。
- **`ask`**（仅 `pre_tool_use`）：**无条件**强制弹窗 —— 忽略"总是允许/总是拒绝"记忆，且**不会被 `permissionMode: "auto"` 与 `needsPermission: false` 短路**。也就是说：**Full Access / auto 模式下 `ask` 照样弹窗，只读工具（`read_file` / `grep` …，用于"读取敏感路径强制复核"）上同样弹窗**。auto 只是"平时别问我"的偏好，跳不过用户自己配置的策略层；唯一的退出方式是改配置（关掉该 hook 或 `hooks.enabled`），而不是切到 Full Access。
- **`updatedInput`** 是**完整替换**（需要只改一个字段就自己读 `tool_input` 再原样带回其余字段），替换后会**重新过 JSON Schema 校验**；非法则本次工具调用**不执行**并回失败结果——绝不让被污染的输入进入执行。
- 同一事件多条 hook **串行**执行：`updatedInput` 链式（后一条看到前一条的结果），`additionalContext` 全部拼接；`deny` > `ask` > `allow`。

### 安全说明（务必读）

- **配置级 hook 一律用绝对路径**（或 `${HOME}/…`）。相对路径的解析基准是**声明它的那份配置所在的目录**（配置级 = 配置文件目录，项目级 = 项目根），**不是 session cwd**；路径形态的命令在加载期就解析并校验存在性，找不到直接启动报错。这条规则是必须的：如果基准是 session cwd，全局配置里一句 `.sangxia/hooks/guard.sh` 就会在你打开任意恶意仓库时执行**那个仓库里**的同名脚本，而你以为是自己的守卫脚本。
- hook 进程的运行时 `cwd` 仍是 **session cwd**（脚本里的 `git status` / `npm` 语义不变）。因此**不要在全局配置里写依赖仓库的裸命令**（`"npm run lint"` 会跑被打开仓库的 `package.json` scripts 与 `node_modules/.bin`）；要跑就写绝对解释器 + 绝对脚本：`"bash ${HOME}/.config/sangxia/hooks/lint.sh"`。
- **全局配置里的 hook 在所有项目里都生效**（配置分层，D16）：这是全局 hook 的意义所在，也意味着**你打开任何仓库时它都会跑**。因此全局 hook 尤其要遵守上一条（绝对解释器 + 绝对脚本），且**不要**在全局 hook 里执行依赖仓库内容的裸命令。
- **项目级 hooks（`.sangxia/hooks.json`）默认关闭**：该文件随仓库分发，开启等于"打开仓库就执行任意命令"；显式 `projectFile.enabled: true` 才加载（开启时会 warn 一次），且项目级条目的 `onError` / `timeoutMs` 只能**更严**不能放宽。
- hook 是**本地用户自己配置的、权限等同你 shell 的非沙箱进程**：它能看到模型文本、工具参数与输出（可能含代码/密钥）；不要把 payload POST 到不可信地址。stdout 不整体进日志（只记解析结果与长度），stderr 截断后进日志。
- **hook 策略是"深度防御"，不是沙箱**：基于工具参数字符串的规则天然可绕过（禁止写 `.env` 的规则挡不住 `bash -c 'echo … > .env'`）。要真正隔离请用 OS 级机制；能拦刀就同时配 `guard-writes` + `guard-bash` 两条 matcher。

### 环境变量（stdin 之外的第二通道）

`SANGXIA_HOOK_EVENT`、`SANGXIA_SESSION_ID`、`SANGXIA_CWD`、`SANGXIA_PERMISSION_MODE`、`SANGXIA_PROJECT_DIR`（= 项目根 / session cwd）、`SANGXIA_AGENT_CWD`（Sangxia 进程启动目录）。

### 与 Claude Code Hooks 的对应

事件名改为 snake_case（`PreToolUse`→`pre_tool_use`、`Stop`→`turn_end`），输入字段、`exit 2` 语义一致；决策读取兼容 `hookSpecificOutput.permissionDecision` 与旧式顶层 `decision: "approve" / "block"`（未知取值按失败处理，绝不静默放行）。已有脚本**大概率**能直接跑（差异：本设计的顶层字段是 `decision`，另有 `updatedPrompt`；`UserPromptSubmit` 在 Claude Code 里不支持改写 prompt）。

### 最小示例

```sh
#!/bin/sh
# ~/.config/sangxia/hooks/guard-writes.sh
# 配置: { "matcher": "^(write_file|edit_file)$", "command": "bash ${HOME}/.config/sangxia/hooks/guard-writes.sh" }
payload=$(cat)
path=$(printf '%s' "$payload" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tool_input?.path??""))')
case "$path" in *.env|*.env.*|*id_rsa*|*.pem) echo "禁止写入敏感文件: $path" >&2; exit 2 ;; esac
exit 0
```

```sh
#!/bin/sh
# ~/.config/sangxia/hooks/ts-check.sh（post_tool_use，matcher ^edit_file$，timeoutMs 120000）
out=$(npm run -s typecheck 2>&1) || {
  node -e 'console.log(JSON.stringify({hookSpecificOutput:{additionalContext:"[typecheck 失败]\n"+process.argv[1]}}))' "$out"
}
exit 0
```

一个典型的**全局 hook**：每次会话开始都在后台预热索引（`~/.config/sangxia/config.json`，对所有项目生效）：

```jsonc
{
  "hooks": {
    "enabled": true,
    "events": {
      "session_start": [
        {
          "name": "jbcontext-index",
          "matcher": "startup|resume",              // 只在新会话 / 恢复会话时跑
          "command": "sh -c 'jbcontext index --silent >/dev/null 2>&1 &'",  // & = 不阻塞会话启动
          "timeoutMs": 2000                          // 命令本身立刻返回，2s 只是安全网
        }
      ]
    }
  }
}
```

> 这里用 `sh -c '… &'` 是为了"同步 hook + 后台任务"的组合：Sangxia 的 hook 一律同步等待（决策必须在继续之前拿到），命令自己 `&` 掉即可立刻返回。`matcher` 用的是 codex `SessionStart` 的同一套 `source` 词汇表。

## 架构

```
入口 A  stdio (JSON-RPC / ACP)     ← Zed 等 ACP 客户端驱动
入口 B  sangxia tui (src/tui/)      ← 界面自带 ClientSideConnection，
        │                            经内存流 PassThrough 与下方 agent 配对；
        │                            两个入口走完全相同的协议路径
        ▼
   AgentSideConnection            ← @zed-industries/agent-client-protocol
        │
   SangxiaAgent (src/agent.ts)     ← initialize / newSession / prompt / cancel
        │                            newSession: 连接 MCP + 发现技能 → 组装本会话工具集
   harness/loop.ts  ──►  LLMProvider (llm/*)      OpenAI 兼容 / mock
        │            └─►  ToolRegistry(每会话)     内置(tools/*) + MCP(mcp/*) + use_skill(skills/*)
        │            └─►  permissions.ts           session/request_permission
        │            └─►  hooks/*.ts               外部命令钩子（pre/post_tool_use 等，见「Hook」）
   Session (src/session.ts)       ← 每会话历史 / cwd / 权限记忆 / 取消 / MCP 连接 / 技能 / hooks
```

- **stdout 是协议通道**，所有日志走 stderr（`SANGXIA_LOG_FILE` 可另存为单个文件；`SANGXIA_LOG_DIR` 可按 session 分文件，见下；`SANGXIA_LOG_LEVEL` 调级别）。日志默认使用运行进程的本地时区，并在时间戳中包含 UTC 偏移量；如 ACP 宿主时区不正确，可设置 `SANGXIA_LOG_TIMEZONE=Asia/Shanghai`。TUI 模式下 stdout 是渲染目标而非协议通道，因此启动时会 `logger.configure({ stderr: false, … })` 把日志只写进文件。
- **按 session 分日志**：设置 `SANGXIA_LOG_DIR=<目录>` 后，每个 session 的日志写入 `<目录>/<sessionId>.log`（启动、`initialize` 等无 session 的日志写入 `<目录>/global.log`）。session 归属基于 Node `AsyncLocalStorage`（`logger.withSession`），多 session 并发执行时日志也不会串文件；行内带 `[session=<id>]` 标记；同时设置时 `SANGXIA_LOG_DIR` 优先于 `SANGXIA_LOG_FILE`。
- Provider 是接口，新增后端（如 Anthropic 原生）只需实现 `LLMProvider` 再在 `llm/factory.ts` 注册。
- 会话工具集在 `newSession`/`loadSession` 组装：内置工具 + `use_skill`（若发现技能）+ 已连接的 MCP 工具（`src/agent.ts`）。
- 会话历史默认持久化到 `~/.config/sangxia/sessions/<sessionId>.json`，可用 `SANGXIA_SESSION_DIR` 修改目录；支持 ACP `session/load` 恢复历史。
- 新会话会自动加载项目根目录的 `AGENTS.md` 和 `.sangxia/memory.md`，用于保存跨 session 的项目约定与进度；此外 `~/.config/sangxia/AGENTS.md`（**用户级长期指令**）会**在所有项目**里加载，用来放"无论打开哪个仓库都成立"的工作方式约定（例如某个 CLI 的用法、语义搜索优先于 grep）。加载顺序：用户级在前、项目记忆在后（后者更具体，冲突时以项目为准）。该文件**不会**被自动创建，也不参与项目初始化补齐。
- 如果上述任一文件缺失，第一次正式 prompt 前会请求用户确认；确认后 agent 会先扫描项目并只补齐缺失的记忆文件，再执行原始任务。
- 一次 prompt 的完整时序见 [`doc/uml/prompt-turn.md`](doc/uml/prompt-turn.md)。

## 终端界面（TUI）

`sangxia tui` 在真实终端里启动一个聊天式 TUI，与 Zed 走**同一套 ACP 协议**：内部把同一个 `SangxiaAgent` 通过内存流配对到客户端侧，stdio 只归界面（渲染 + 键盘）。

```bash
sangxia tui                          # 需要 stdin 与 stdout 均为 TTY；非 TTY 会友好报错
sangxia tui --crt                    # 可选 CRT 黑底模式（默认不强制黑底）
sangxia tui --config ./other.json    # 与 ACP 模式共用同一套配置解析
sangxia tui --permission-mode auto   # 直接以 FULL ACCESS 启动（首帧即有红色 badge + 横幅）
```

- **布局**：状态栏（agent · 当前模型 · cwd + 权限 badge）→ 对话区（流式回答/工具行/TODO 计划）→ 权限弹窗（confirm 模式）→ 输入行。配色红/绿/白三色（安全=绿、危险/错误=红、正文=白，**颜色永不作唯一通道**）；设置 `NO_COLOR` 可去色。
- **斜杠命令**（纯客户端本地命令）：
  - `/model [modelId]` 查看/切换模型（配置 `provider.models`；无参数弹选择器；模型**下一轮生效**，状态栏带 `*` 待生效标记）。
  - `/access` 只显示当前权限模式；`/access full` 进入 FULL ACCESS（需二次确认，变更不再请求确认，红横幅+badge）；`/access standard` 切回每次确认。切换会清空本会话"总是允许/总是拒绝"记忆。
  - `/permissions reset` 清空记住的授权决策（等价于重发一次 `set_mode`）；`/help`、`/clear`（只清屏，不动会话历史）、`/new`（重开会话，仅空闲时可用）、`/quit`。
- **快捷键**：Enter 发送（上一轮未结束时禁用，Ctrl+C 可取消该轮）、↑/↓ 输入历史、Tab 补全命令/modelId、Ctrl+C 清空输入行（**空闲时连按两次 = 退出**，turn 中 = 取消）、Ctrl+U 删到行首、Ctrl+W 删词、Ctrl+A/Ctrl+E 行首/行尾、Ctrl+D 删字符（空行 = 立即退出）、PgUp/PgDn 与 Shift+↑/↓ 滚动对话区、Esc 关弹窗。权限弹窗支持数字键直选或 ↑/↓ + Enter；模型选择器用 ↑/↓ + Enter，Esc 取消。
- **粘贴**：启用了终端 bracketed paste，粘贴多行文本不会被当成多次回车——换行会归一成空格并入单行输入（v1 是单行编辑器）。
- **日志**：TUI 模式下日志不打印到屏幕，只写入 `SANGXIA_LOG_DIR`（未设置时为系统临时目录 `sangxia-tui-logs/`），级别默认降到 `warn`。
- **已知差异**：TUI 不向 agent 声明 `fs` / `terminal` 能力，文件读写与 `bash` 都走本地 Node 回退——`bash` 输出在命令结束时一次性返回（工具行的 spinner + 计时是"仍在运行"的唯一信号）；Zed 里则走编辑器的终端、输出实时可见。

## 开发

```bash
npm run dev         # tsx 直跑 src/index.ts
npm run typecheck   # 仅类型检查
npm run build       # 编译到 dist/
npm run smoke        # ACP 握手 + 工具 + 权限流冒烟（mock provider）
npm run smoke:openai # 真实 OpenAIProvider 流式路径（本地假服务器）
npm run smoke:mcp    # MCP 工具接入冒烟
npm run smoke:skill  # 技能层冒烟（发现/目录注入/use_skill 加载）
npm run smoke:tui    # TUI 层 headless 冒烟（命令/输入/通知映射/内存配对/取消）
npm run smoke:hooks  # Hook 层冒烟（拦截/改写/ask/超时/取消/路径基准/项目级 hooks/配置分层，89 项断言）
npm run smoke:reliability # 截断/空响应/Schema/超时/取消与断连回归
```

## 目前未覆盖（预留扩展点）

- Anthropic 原生 provider（接口已就绪）。
- 图片/音频输入（`initialize` 里 `promptCapabilities.image/audio` 均为 false）。
- MCP 连接的按会话回收（当前在进程退出时统一关闭；ACP 0.4.5 无会话结束事件）。
- TUI v2：`/resume`（`session/load` 续持久化会话）、权限弹窗内的实时 `bash` 输出（客户端 `createTerminal`）、多行输入。
- Hook v2：会话级 `session_end`（等 ACP 有会话结束事件）、`pre_compact` / `subagent_*`、`turn_end` 的 `decision: "continue"`（要求模型再跑一轮）、结构化注入（图片/文件引用）、可选审计文件（`hooks.auditFile`）。

> 权限模式（`session/set_mode`）与模型选择（`session/set_model`）已实现，见上文「配置」。
