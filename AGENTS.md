# AGENTS.md — ZhenTe 项目工作规则

## 项目简介

ZhenTe（eye-zhen-te）是一个基于 Node.js/TypeScript 的 ACP（Agent Client Protocol）编程 AI agent：通过 stdio 上的 JSON-RPC 与 Zed 等 ACP 客户端通信，自带完整工具 harness（流式输出 → 工具调用 → 权限确认 → 执行 → 回喂 → 收敛），LLM 后端走任意 OpenAI 兼容 `/chat/completions` 端点，可通过 ACP `session/new` 接入 MCP servers，支持本地技能（Skills）渐进式加载，以及由本地配置驱动、不依赖 ACP 客户端的生命周期钩子（Hooks）。

## 技术栈

- **语言/运行时**：TypeScript 5.6+，Node.js >= 20，ESM（`"type": "module"`）
- **模块解析**：`NodeNext`；目标 `ES2023`；严格模式（`strict` + `noUncheckedIndexedAccess`）
- **关键依赖**：`@zed-industries/agent-client-protocol@0.4.5`、`@modelcontextprotocol/sdk`、`openai`、`zod`、`tinyglobby`
- **开发工具**：`tsx`（dev 直跑）、`tsc`（build/typecheck）、Node 内置 `node:test` 风格脚本冒烟测试

## 常用命令

```bash
npm run dev         # tsx 直跑 src/index.ts（开发）
npm run typecheck   # 仅类型检查（提交前必跑）
npm run build       # 编译到 dist/
npm run smoke       # 离线冒烟：完整 ACP 握手 + 工具 + 权限流（mock provider）
npm run smoke:openai  # 真实 OpenAI 兼容流式路径（本地假服务器）
npm run smoke:mcp     # MCP 工具接入冒烟
npm run smoke:skill   # 技能层冒烟（skills.dirs 发现 + 目录注入 + use_skill 加载/未知名称报错）
npm run smoke:tui     # TUI 层 headless 冒烟（命令/主题/输入/通知映射/内存配对/取消）
npm run smoke:hooks   # Hook 层冒烟（拦截/改写/ask/超时/取消/路径基准/项目级 hooks/配置分层，89 项断言）
npm run smoke:reliability # 截断/空响应/参数校验/流式超时/重试/工具 deadline/持久化/取消与断连回归（32 组）
scripts/install-skills.sh  # 把 skills/ 装到 ~/.config/zhente/skills（--dry-run/--force/--skill/--target）
```

## 目录约定

```
src/
  acp/         ACP 侧内容处理（content.ts）
  agent.ts     主 Agent：initialize / newSession / prompt / cancel；组装会话工具集
  config.ts    配置加载（--config → $ZHENTE_CONFIG → ./zhente.config.json → ~/.config/zhente/config.json，
               支持 ${ENV} 插值；D16 分层：~/.config/zhente/config.json 是全局 base，主配置在其上深合并，
               hooks.events.* 数组追加 = 全局 hook 无法被项目配置删掉）
  harness/     主循环 loop.ts、权限 permissions.ts、工具抽象 tool.ts、统一参数校验 validation.ts
               头尾截断 truncate.ts、prompt token 估算 context.ts
  llm/         LLMProvider 接口（types.ts）+ OpenAI（openai.ts）/ mock（mock.ts）+ factory.ts
  mcp/         MCP client（client.ts）
  hooks/       生命周期钩子：types.ts（事件/信封/决策类型）、paths.ts（D15 路径基准
               解析 + 加载期 fail-fast）、exec.ts（单条 hook 进程：spawn/进程组超时
               kill/容错解析/exit 2）、index.ts（HookRegistry：matcher/串行链式/合并
               决策/项目级 hooks.json + onError 与超时钳制）
  skills/      技能发现与 use_skill（index.ts）
  tools/       内置工具：fs-tools.ts（read/write/edit/list/glob/grep）、bash.ts、plan.ts
  tui/         终端 UI（`zhente tui`）：index.ts 主循环 / bridge.ts 进程内 ACP 配对
               / ui.ts 备用屏渲染 / keys.ts raw 键盘解析 / input.ts 行编辑
               / model.ts ACP 通知→聊天条目映射 / commands.ts 斜杠命令
               / theme.ts 红绿白主题 / wcwidth.ts 最小 CJK 宽度（零依赖）
  index.ts     入口（stdio JSON-RPC；argv[0]==="tui" 时转 TUI 分支）
  logger.ts    日志（stdout 是协议通道，日志一律走 stderr；可选 ZHENTE_LOG_FILE 单文件或 ZHENTE_LOG_DIR 按 session 分文件；logger.configure 支持运行时改 stderr/level/dir，TUI 用它把日志只进文件）
  persistence.ts  会话持久化：JSONL 事件流（~/.config/zhente/sessions/<id>.jsonl），persistSession 唯一写入口
  project-memory.ts  AGENTS.md / .zhente/memory.md 的发现与加载（+ 用户级 ~/.config/zhente/AGENTS.md）
doc/uml/       时序图（prompt-turn）
scripts/       冒烟测试脚本（*.mjs）+ install-skills.sh（把 skills/ 装到全局技能目录）
               install-skills.sh 需注意：bash 里 `$var` 紧挨全角括号会被吞进变量名，一律写 `${var}
.claude/skills/ 本地安装的第三方技能（Claude Code 布局；analyze 来自 jet-desk，见 .zhente/memory.md）
skills/      本项目自有技能（deepseek-usage：DeepSeek 余额 + 本地 token 用量）
```

## 技能（Skills）

- 发现目录：配置 `skills.dirs`（相对路径按 session cwd 解析）优先；未配置时回退 `<cwd>/skills` + `~/.config/zhente/skills`。同名先到先得（项目技能盖过全局）。
- **共享技能给其他项目**：把技能装进默认目录 `<项目>/skills`（零配置）或全局 `~/.config/zhente/skills`（用 `scripts/install-skills.sh`）。全局目录只对**未设置 `skills.dirs`** 的项目生效——`skills.dirs` 非空会替换默认列表，此时必须把全局目录显式列进去（按顺序，靠后的被靠前的同名技能盖过）。技能不跟随 Agent 安装位置，只按 session cwd 扫描。装完需新开会话。
- `SKILL.md` 只需 frontmatter 的 `name` / `description`；`description` 支持 YAML 块标量（`>-` / `|`），Claude Code 技能的长描述可直接用。
- 目录（name+description）只在 `newSession` 时扫描一次并注入 system prompt，`use_skill` 工具仅在发现到技能时才暴露——**安装技能后需要新会话才生效**。
- `use_skill` 只加载 SKILL.md 正文；Claude 专属的 `allowed-tools` / `$ARGUMENTS` / `argument-hint` 不解析（正文里按需自解释）。技能内引用的相对路径（如 `.claude/skills/<name>/references/*.md`）按 session cwd 解析，安装时要保证路径与 cwd 匹配。
- 技能里如果依赖 MCP 工具（javaperf/diogen/…），必须由 ACP 客户端在 `session/new` 传 `mcpServers`；TUI 传空数组，所以 TUI 下只能用纯本地工具的技能。

## 工作规则

1. **先读后改**：不臆测文件内容，先用 `read_file`/`list_dir`/`glob`/`grep` 确认；修改用 `edit_file` 做最小化精确改动。
2. **运行命令**：构建/测试/git 等一律通过 `bash` 执行；提交前必须过 `npm run typecheck`（可再跑 `npm run build`）。
3. **日志纪律**：stdout 是 ACP 协议通道，任何调试/日志输出必须走 stderr 或 `ZHENTE_LOG_FILE`/`ZHENTE_LOG_DIR`，严禁污染 stdout。日志时间戳含本地时区 UTC 偏移；宿主时区不对时用 `ZHENTE_LOG_TIMEZONE` 修正。`ZHENTE_LOG_DIR` 按 session 分文件（`<sessionId>.log` + `global.log`），session 归属用 `AsyncLocalStorage` 实现（`logger.withSession`，见 agent.ts 的 newSession/loadSession/prompt/cancel 包裹），多 session 并发也不串文件。
4. **配置与密钥**：`zhente.config.json` 已被 gitignore，不要提交；密钥用 `${ENV_VAR}` 引用，避免落盘。
5. **产物与生成文件**：`dist/`、`node_modules/` 为构建产物，不手改、不提交。
6. **记忆维护**：跨 session 的项目背景、重要决策、待办事项写入 `.zhente/memory.md`（每次 session 自动加载）；涉及架构/决策/未完成事项时，任务完成后更新。**用户级**（对所有项目成立）的工作方式约定写 `~/.config/zhente/AGENTS.md`，由 `loadUserMemory()` 加载，顺序在项目记忆**之前**；该文件不被自动创建/补齐（是用户自己的文件）。
7. **新增 LLM 后端**：实现 `LLMProvider` 接口，在 `llm/factory.ts` 注册即可。
8. **权限模型**：变更类工具（write/edit/bash/MCP 工具）执行前走 `session/request_permission`；读类工具免权限；`update_plan`/`use_skill` 免权限。
   所有工具先过 JSON object / JSON Schema 校验；非法参数不得进入权限确认，截断响应中的工具调用一律拒绝执行，并补齐失败 tool result。
9. **会话隔离**：工具集按会话组装（内置 + 技能 + MCP）；MCP server 连接失败只告警跳过，不影响其他工具。
10. **TUI 纪律**：`zhente tui` 分支完全接管进程生命周期（stdio/TTY/信号），不注册 ACP 模式的 SIGINT 逻辑；TUI 下日志必须 `logger.configure({ stderr:false, dir })` 只进文件，严禁把日志写进备用屏。输入层是自研 raw 键盘解析（keys.ts），不要换回 readline——`rl.pause()` 无法隔离 raw 弹窗（按键会漏进行输入行，spike 已验证）。
11. **SDK 陷阱**：`@zed-industries/agent-client-protocol@0.4.5` 的 `ClientSideConnection.setSessionModel` 会错发 `session/set_mode`；绕行 `extMethod("zhente.set_model")`（agent.ts 已登记，转发到标准 setSessionModel）。不要"修" SDK 里那两处辅助方法（node_modules 是产物）。
12. **持久化纪律**：`src/persistence.ts` 是唯一的会话写入口（`persistSession`）+ 工具事件（`persistToolEvent`）+ 历史替换（`persistHistoryReset`）。存储是 append-only JSONL 事件流（`meta`/`message`/`reset`/`tool_started`/`tool_finished`/`mode`/`model`），**不要**退回"每条消息全量重写快照"（长会话 O(n²)，且无法记录工具是否启动过）。`tool_started` 必须在 `tool.run` **之前**落盘——`sanitizeHistory` 靠它区分"结果未知"与"可安全重试"。`sessionId` 写文件前必过 `/^[a-zA-Z0-9-]+$/` 白名单。
13. **工具超时纪律**：工具调用受 `agent.toolTimeoutMs`（默认 300s）约束，`tool.timeoutMs` / 调用参数（bash 的 `timeout`）优先；deadline 必须 **race** 工具 promise，只 abort signal 不够（不理会 signal 的工具会永久 await）。超时按 `deadline.signal.aborted && !signal.aborted` 判定为失败 tool result，用户取消优先级更高（语义不得混）。
14. **LLM 重试边界**：provider 只重试**首个 delta 之前**的瞬时失败（网络/408/409/429/5xx），尊重 `Retry-After`，可被 signal 打断；已流出内容、`StreamTimeoutError`、参数类错误一律不重试。SDK `maxRetries: 0` 保持不动。

15. **Hook 纪律**：`src/hooks/` 的四条不变式，改动前先读 `plan/hooks_support.md` 的 §7/§10-D14/§10-D15。
    - `pre_tool_use` 必须插在 `tool_call` 通知与 `session/request_permission` **之前**，且 `title`/`locations`/`rawInput`/权限弹窗全部用**可能被改写后的最终参数** —— "人批准的就是实际执行的"（D1/M1）；`updatedInput` 是整体替换，替换后必须**重新过 JSON Schema**，非法即不执行。
    - `ask` 必须**无条件强制弹窗**（`ignoreRemembered: true` + 绕过 `needsPermission`/`permissionMode` 两个门控）：auto 模式与 `needsPermission:false` 的只读工具上都要弹，否则对企业承诺的硬约束是假的（D14）。`deny`/`ask` 都必须回填 tool result，否则触发 `tool_calls` 配对 400（D2/D13）。
    - **命令路径的解析基准 = 声明它的那份配置所在目录**（配置级 = 配置文件目录，项目级 = 项目根），与 hook 进程的 `cwd`（= session cwd）解耦。**绝不要把基准改成 session cwd** —— 那等于让被打开的仓库决定执行哪个文件（D15 / review H2）；路径形态的命令在加载期解析并校验存在性，缺失直接 fail fast。
    - hook 失败**绝不能影响 turn 收敛**（异常全捕获 + warn 日志，`onError` 只约束"失败"路径，不改写显式 deny）；`hooks.enabled` 与 `projectFile.enabled` 默认 **false**；项目级条目的 `onError`/`timeoutMs` 只能更严不能放宽（L3）。
    - 项目级 hooks 文件（`.zhente/hooks.json`）在**会话建立时**加载（基准是 session cwd），配置级在 `loadConfig` 阶段解析路径。
    - **配置分层（D16）**：`~/.config/zhente/config.json` 永远是 base，主配置是 overlay；`hooks.events.*` 按"base 先、overlay 后"**追加**，所以**不要**给 hooks 加"数组覆盖"或去重 —— 那会让项目配置静默卸掉用户的全局守卫 hook。唯一关闭入口是显式 `hooks.enabled: false`。改 `loadConfig` 时不要退回"单文件、先找到先用"。


## 已知扩展点（勿破坏预留接口）

- Anthropic 原生 provider（接口已就绪，未实现）。
- 图片/音频输入、多模式（`session/set_mode`）。
- MCP 连接按会话回收（当前进程退出时统一关闭，受 ACP 0.4.5 无会话结束事件限制）。
- TUI v2：`/resume`（session/load 续持久化会话）、权限弹窗内实时 bash 输出（客户端 createTerminal，terminal:true）、多行输入。
- `reasoning_effort` / 请求体透传：当前 provider 只发 `max_tokens`，无法单独控制思考预算（DeepSeek 的 `reasoning_effort=max` → 默认输出 128K 那一档因此用不上）。
- Hook v2（实现见 `src/hooks/`，v1 已落地 6 个事件）：会话级 `session_end`（等 ACP 有会话结束事件或 TUI 支持销毁会话）、`pre_compact`、`subagent_start`/`subagent_stop`、`turn_end` 的 `decision: "continue"`（需给 `runTurn` 加 resume 语义）、结构化注入（图片/文件引用）、可选审计文件 `hooks.auditFile`。子代理每步工具调用走父循环的 `executeToolCall`，hook 自动生效，但不产生会话级事件（D6）。
- 上下文压缩（`plan/harness_hardening_plan.md` 步骤 10b/10c）：`harness/context.ts` 已备好 `estimateTokens` / `shouldCompact`，但**按实测证据挂起**（真实请求最大 182k prompt tokens / 789 消息、0 次 `context_length_exceeded`，见 `.zhente/memory.md`）；重启前先看有没有新的溢出证据，不要用 128k 之类的默认窗口猜阈值。
