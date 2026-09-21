# ZhenTe 项目记忆

## 维护方式

- 这里保存跨 ACP session 的项目背景、重要决策和未完成事项。
- 完成较大的任务后，请让 agent 更新本文件；不要把临时命令输出长期堆在这里。

## 当前项目

- 项目是基于 Node.js/TypeScript 的 ACP coding agent。
- LLM 使用 OpenAI-compatible `/chat/completions` 接口。
- 构建产物输出到 `dist/`，主要开发命令是 `npm run typecheck` 和 `npm run build`。

## 日志：按 session 分文件

- `ZHENTE_LOG_DIR=<目录>` 启用按 session 分文件：每个 session 写 `<目录>/<sessionId>.log`，无 session 的日志（启动/initialize）写 `<目录>/global.log`；`ZHENTE_LOG_FILE` 仍是单文件模式，两者同时设置时 `ZHENTE_LOG_DIR` 优先。
- 实现于 `src/logger.ts`：session 归属用 Node 内置 `AsyncLocalStorage`（`logger.withSession(id, fn)` 包裹处理器），异步链内所有日志（含 await 之后）都能拿到自己的 sessionId；行内带 `[session=<id>]` 标记。
- session 绑定点在 `src/agent.ts` 的 newSession / loadSession / prompt / cancel（用 `withSession` 包裹整个处理器）；loadSession 的 sessionId 来自客户端，写文件前用 `SESSION_ID_RE`（`/^[a-zA-Z0-9-]+$/`）白名单校验，防止路径注入。
- 并发安全：多 session 并发 prompt（不同异步链交错执行）时，每条日志按各自 ALS 上下文归属，不会串文件（已验证）。

## 权限配置：permissionMode

- `agent.permissionMode: "confirm" | "auto"`（默认 `confirm`）：`confirm` 每次请求人类确认；`auto` bypass 全部权限确认。
- 兼容旧字段 `agent.autoApprove: true`（等价于 `"auto"`），解析时在 config.ts 归一化，`AgentConfig` 类型上不再有 `autoApprove`。
- ACP Session Modes 暴露 `Standard Access`（`confirm`）和 `Full Access`（`auto`）；IDE 通过 `session/set_mode` 切换当前会话权限模式。
- 配置项决定新会话默认模式，实际模式保存在 `Session.permissionMode` 并随会话持久化；变更工具执行时读取会话模式。
- 覆盖优先级：CLI `--permission-mode auto|confirm` > 环境变量 `ZHENTE_PERMISSION_MODE` > 配置文件（实现于 `src/config.ts` 的 `permissionModeOverride`），便于 IDE ACP agent 配置（args/env）里按 agent 各自选择。

## 设计书（根据代码整理）

- `plan/agent-design.md`：依据现有代码整理的完整设计书（架构分层/harness/权限模型/工具系统/LLM 抽象/MCP/技能/TUI/持久化/健壮性/配置/待办扩展点），与 `src/` 代码一一对应；后续改动大时记得同步更新。

## Harness 对比评估（2026-09-11）

- 评估文档：`../plan/harness_compare_to_dsh(gpt6).md`，对比当前工作区与官方 DeepSeek Harness `c291e7961a515f6d7af9304e7fd1d257929aef26`，含源码依据、能力差异和分阶段建议；`plan/` 被忽略，属于本地归档。
- 审查重点：崩溃缺失 tool result 不能一律解释为“未执行”；同 session prompt 需在途保护；长上下文预算/压缩、工具停稳语义需要加强。另发现 loop 中途快照未带 modelId、模型历史未保留显式 isError。以上是待验证/修复建议，本次未改运行代码，也未决定重构。
- 本次 `npm run typecheck` 与 `npm run smoke:reliability`（13 组，含 build）通过；没有做双方真实任务成功率或成本对照实验。

## 待办：Sub Agent 工作模式（设计已完成，未实现）

- 设计文档：`plan/subAgentPlan-ds4flash.md`（spawn_subagent 工具、独立子上下文循环、权限模型、配置 schema、实施步骤）。
- 核心思路：工具层实现 `spawn_subagent`，进程内开独立 LLM 上下文；ACP 协议层零改动；子代理无权限通道，未授权变更工具默认拒绝。
- 实现时建议：先独立轻量循环，验证后再把 runTurn 抽成 runToolLoop 复用；跑完冒烟记得更新 AGENTS.md 目录约定与扩展点。

## Hook（生命周期钩子）支持（已实现，2026-09-21）

- 设计文档：`plan/hooks_support.md`（v1 六个事件：session_start / user_prompt_submit / pre_tool_use / post_tool_use / turn_end / session_end）；实现于 `src/hooks/{types,paths,exec,index}.ts`，验收 `npm run smoke:hooks`（76 项断言）。
- 核心机制：外部命令 + stdin JSON（统一信封，含 `tool_name`/`tool_input`/`cwd`/`session_id`），stdout 决策 JSON（`decision: allow|deny|ask`、`updatedInput`、`additionalContext`），`exit 2` 等价 deny；协议对齐 Claude Code Hooks 便于复用已有脚本。
- 关键设计决策：`pre_tool_use` 插在**权限确认之前**（保证“人类批准的就是实际执行的”）；`allow` 不跳过 `request_permission`（hook 是追加策略层，不是绕过口）；hook 的 deny 必须回填 tool result，否则触发 tool_calls 配对 400；`hooks.enabled` 默认 **false**（升级零行为变化）；项目级 `.zhente/hooks.json` 默认关闭（供应链风险）。
- 落地清单（§8）：新增 `src/hooks/{types,paths,exec,index}.ts`；改 `config.ts`（hooks schema + 加载期路径解析 + `configPath`/`configDir` 透出）、`agent.ts`（四个会话级事件 + context 注入）、`harness/loop.ts`（工具前后 + `ask` 独立分支）、`harness/permissions.ts`（`ignoreRemembered`）、`session.ts`（`hooks`/`hookContext`/`turnIterations`）；新增 `npm run smoke:hooks`。
- 与既有扩展点关系：hook 由本地配置驱动、与 ACP 客户端无关 —— TUI 下也能用（与 MCP 相反）；子代理的工具调用同样经过 hook，但不产生会话级事件。

### 2026-09-15 按 review 定案的两项（H1 / H2）

- 依据 `plan/hooks_support-review-high.md`（同目录还有 -medium / -low 两份 review），已在 `plan/hooks_support.md` 定案并写入 §3/§4/§5/§6/§7/§8/§9/§10/§11/附录 A：
  - **D14 `ask` = 无条件强制弹窗**（选了 review 的方案 A，否掉 B“auto 下降级为 deny”与 C“收窄为仅 confirm + needsPermission:true 有效”）：`executeToolCall` 走独立分支，绕过 `if (tool.needsPermission && session.permissionMode !== "auto")` 两个条件直接 `ensurePermission(..., { ignoreRemembered: true })` —— 所以 **auto 模式与 `needsPermission:false` 的只读工具上 `ask` 都会弹窗**（只加 `ignoreRemembered` 选项而不动门控条件，会让 auto 下 `ask` 静默变 allow，企业“硬约束”承诺是假的）。代价：auto/Full Access 不再等于“绝不弹窗”，README 需写明。
  - **D15 相对路径 `command` 的解析基准 = 声明它的那份配置**（配置级 → 配置文件目录，项目级 → 项目根），**不是 session cwd**；进程 `cwd` 仍是 session cwd（两者解耦）。因为 D4 只封住了“项目文件声明 hooks”，而全局配置里写 `.zhente/hooks/x.sh` + hook cwd = session cwd 会让被打开仓库决定执行哪个文件。配套：路径形态判定（`./ ../ / ~` 或含 `/` 或脚本后缀）+ 加载期解析并校验存在性 fail fast（否则退化成“调用即失败 + onError 默认 allow”静默失效）、示例改绝对路径/`${HOME}`、README 规定配置级 hook 用绝对路径。
  - §11 冒烟补 4 条：`auto + ask`、`needsPermission:false + ask`、相对路径基准（陷阱脚本对照）、路径形态命令不存在 ⇒ 加载期报错。

### 实施记录（2026-09-21，commits cb6daf5 / 508f479）

- 落地范围：v1 六个事件全部实现；`hooks.enabled` 与 `hooks.projectFile.enabled` 默认 false；配置级 hook 的路径形态命令在 `loadConfig` 阶段按**配置文件目录**解析并校验存在性（fail fast），项目级在**会话建立时**按 session cwd 解析（`createHookRegistry(config, { cwd })`，注册表挂在 `session.hooks`）。
- 实现时对 review 的取舍（都已写进代码注释，改动前先看）：
  - **M1 采纳**：`pre_tool_use` 插在 `tool_call` announce **之前**，`title`/`locations`/`rawInput`/权限弹窗标题全部用最终参数；so "人看到/批准的 = 执行的"。
  - **M3 采纳**：`turn_end` 改为"`prompt()` 每条退出路径恰好一次"（含 `cancelled during initialization`、`user_prompt_submit` deny），payload 带 `turn_kind: "main" | "init"`；初始化子 turn 的 `runTurn` 也传 hooks 并单独记一次 `turn_end`（其 stopReason 不再被丢弃）。`iterations` 来自 `session.turnIterations`（loop 每轮写入）。
  - **M4 采纳**：`exit 0` + 空 stdout 一律 `allow`（不受 `onError` 影响）；`onError` 只覆盖"stdout 非空但解析不出决策"、超时、信号、其它非 0 退出码。
  - **M5 采纳**：hook 进程 `detached: true` 起进程组，超时/取消 `kill(-pid, SIGTERM)` → 宽限 2s → `SIGKILL`（与 `tools/bash.ts` 同一套；`shell:true` 下只杀 `/bin/sh` 会留下孙进程）。
  - **M6 采纳**：顶层 `decision` 兼容 Claude Code 旧式 `approve`/`block`；**字段存在但取值未知 ⇒ 按执行失败处理（onError）**，绝不静默 allow。
  - **M7 采纳**：`user_prompt_submit` 在 `maybeInitializeProject` **之前**，且 `updatedPrompt` 是后续所有逻辑（含目录探测）看到的文本；deny 时 `initializationChecked` 不置位（留给下一条合法 prompt）。
  - **M2 部分采纳**：`systemPrompt()` 统一读 `session.hookContext`（newSession 与项目初始化重建都带上）；`loadSession` 走"改写恢复出的 system 消息 + `persistHistoryReset`"（JSONL 是 append-only，改已有消息必须整段重写），无 system 消息时 warn 并忽略。
  - **L1 采纳**：post_tool_use 的 `additionalContext` 有独立预算（单条 20k / 合计 40k 字符，不进 `MAX_TOOL_OUTPUT` 的挤压），且先发工具自身结果的 `tool_call_update`、追加后再补一条，保证 UI 与历史/模型一致（慢 hook 不拖住 UI）。
  - **L2 采纳**：解析器在"整体 parse / 逐行"之外补了"从后往前找最后一个平衡大括号块"，多行 pretty-print（`jq` 默认输出）也能解析；README 仍建议带噪声时用 `jq -c`。
  - **L3 采纳**：项目级条目方向化钳制 —— `timeoutMs = min(项目值, 配置级值)`，`onError` 只允许从 allow 收紧到 deny。
  - **L5 采纳（与 plan 文本不同，故意）**：`ZHENTE_PROJECT_DIR` = **session cwd**（与 Claude Code 的 `CLAUDE_PROJECT_DIR` 语义一致，避免"名字叫 PROJECT_DIR 却不是项目目录"）；ZhenTe 进程启动目录另给 `ZHENTE_AGENT_CWD`。plan §6.3 里写的是 `process.cwd()`。
  - **L6 采纳**：README 与配置示例都给了 MCP 工具的 matcher 写法（`^mcp__router__execute_terminal_command$`）。
- 两处与 plan 文本不同的实现决定：
  1. `updatedInput` 非法时按 **§11-5（不执行 + 失败 tool result）** 实现，而不是 §5.2 的"该 hook 失效 + 告警"（后者会退回用旧参数执行，语义更危险）；冒烟 #5 断言的是"不执行"。
  2. `deny` / 非法改写两条路径的 `tool_call`(failed) 通知里**带上了 content**（与模型看到同一文本），便于客户端显示原因；既有的参数校验失败路径未改（保持原样）。
- 其它：hook 失败只记 warn（`logger`，session 归属走现有 ALS）；stdout 不整体进日志（可能含代码/密钥），只记解析结果与长度；`session_end` 在 `agent.shutdown()` 汇总执行，2s 硬上限（`unref` 的定时器），超时放弃。
- 冒烟隔离：`scripts/smoke-hooks.mjs` 给每个场景设置 `ZHENTE_SESSION_DIR=<临时目录>`（+ `ZHENTE_LOG_DIR`），不再往用户真实的 `~/.config/zhente/sessions` 写测试会话。历史遗留的测试会话已按 `meta.cwd` 里的 `/var/folders/…zhente-…` 标记清理（其余既有 `.json` 旧快照属用户数据，未动）。
- 回归：`npm run typecheck` + `smoke` / `smoke:openai` / `smoke:mcp` / `smoke:skill` / `smoke:tui` / `smoke:reliability` / `smoke:hooks` 全绿（hooks 默认关闭，对既有行为零影响；`scripts/smoke-reliability.mjs` 里手搓的配置对象补了 `hooks: { enabled: false }`）。
- 待办（v2，接口已留）：会话级 `session_end`（等 ACP 有会话结束事件/TUI 支持销毁会话）、`pre_compact`、`subagent_start`/`subagent_stop`、`turn_end` 的 `decision: "continue"`（需给 `runTurn` 加 resume 语义）、结构化注入（图片/文件引用）、可选审计文件 `hooks.auditFile`。

## 已修复：tool_calls 历史不一致导致 400

- 症状：`400 An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'`。
- 根因：turn 被取消/中断时（用户取消、权限流程异常、多工具中途 abort），assistant 消息（含 tool_calls）已 push 并持久化，但未执行的 tool_call 没有对应 tool 响应消息，下一轮把坏历史发给 API 即报 400。MCP 工具（needsPermission=true）多调用场景最容易触发。
- 修复（src/harness/loop.ts）：
  1. `sanitizeHistory()`：每次 runTurn 开头修复历史——为缺失响应的 tool_call_id 补占位 tool 消息、丢弃孤儿 tool 消息，回写并持久化。
  2. `executeToolCall` 全部 `conn.sessionUpdate` 改走 `safeSessionUpdate`（try/catch），`ensurePermission` 抛错按拒绝处理——任何异常路径都保证 `pushToolResult` 执行。
  3. abort 时给剩余未执行 tool_calls 补齐占位 tool 响应再返回。
- 注意：不要删掉 runTurn 开头的 sanitize，它是崩溃/进程被杀场景的最后兜底。

## 待办：ACP Registry 注册（计划已定，未实施）

- 计划书：`plan/acpreg.md`（注册前置工作 + headless 认证设计）。
- 硬性门槛：registry 只收支持用户认证的 agent，CI 校验 `initialize` 的 `authMethods`，仅认 Agent Auth / Terminal Auth；当前 `authenticate()` 是 no-op 且不声明 authMethods，不满足准入。
- 方案：Terminal Auth（`zhente setup`）；headless 认证 = 注入 LLM 凭据，路径 A 交互 setup / B 非交互 setup / C 环境变量 bootstrap / D 配置文件，全部不依赖浏览器；设备码流（RFC 8628）为未来 OAuth provider 的可选扩展。
- 关键改动点：`src/index.ts` 加 CLI 参数分发、`loadConfig()` 失败降级为 unconfigured（不崩溃）、`initialize` 返回 authMethods、未认证时 prompt 返回 AUTH_REQUIRED、新增 `src/setup.ts`。
- 执行顺序：本地开发 + 冒烟 → `npm publish` → 再提 registry PR（cron 每小时自动扫 npm 版本，必须先发版再注册）。
- 阶段 0 遗留调研：AUTH_REQUIRED 错误码/格式（对照 ACP RFD + registry CI）、npm 包名 `eye-zhen-te` 占用情况。

## 初始化范围

- 首次初始化项目记忆前，通过 ACP 权限请求让用户选择仅读取当前工作目录，或同时读取其上层目录；无论选择哪种范围，初始化只写入当前目录下缺失的记忆文件。
- 如果首次用户 prompt 明确提到一个已存在的目录，初始化确认会额外提供在该目录下初始化的选项，并按确认后的目录检查和写入项目记忆。

## LLM 等待反馈与超时

- `provider.requestTimeoutMs` 默认 120 秒，仅作 SDK 请求超时；另用 `streamIdleTimeoutMs` 默认 60 秒与 `streamTotalTimeoutMs` 默认 120 秒覆盖完整 SSE 消费。模型目录可覆盖两者；SDK 自动重试关闭。
- 每次请求记录 start、首个流 chunk 延迟、总耗时和 `finish_reason`；turn 在等待模型期间向 ACP 客户端发送“模型处理中…”思考状态。
- 若请求完成但没有正文和工具调用，记录空可见内容告警，便于识别 reasoning-only、过滤或后端兼容性问题。

## ACP 会话模型选择

- `provider.models` 可配置 ACP 模型目录（`modelId` / `name` / 可选 `description`）；`provider.model` 是新会话默认模型，配置目录时默认模型必须包含在目录中。
- `session/new`、`session/load` 返回 `models`，`session/set_model` 按会话切换；当前 `modelId` 随会话持久化，prompt 和项目初始化均使用所选模型。
- 本地 DeepSeek 配置当前开放 `deepseek-v4-flash` 和 `deepseek-v4-pro`，默认 `deepseek-v4-flash`。
- ACP TypeScript SDK 0.4.5 的 `ClientSideConnection.setSessionModel` 错误发送 `session/set_mode`，但 Agent 服务端 `session/set_model` 路由正确；Zed 直接发协议请求不受该辅助方法 bug 影响。

## TUI 支持（已实现，已合并入 main）

- 合并记录：`feature-tui` 以 `--no-ff` 合入 `main`（merge commit `960cac3`，前一个 main 为 `f0358ba`）；合并后 `main` 内容与 `feature-tui` 完全一致，本地分支 `feature-tui` 保留未删。

- 设计文档：`plan/tui_support.md`（`zhente tui` 子命令、进程内 ACP 内存流配对、/model 与 /access 斜杠命令、红/绿/白三色主题）。实现于 `src/tui/`，见 AGENTS.md 目录约定。
- **进程内配对**：bridge.ts 用两个 PassThrough 构成双向 NDJSON（A=client→agent，B=agent→client；接反=自己跟自己说话挂死）。agent 侧 `ndJsonStream(write B, read A)` 喂 ZhenTeAgent，client 侧 `ndJsonStream(write A, read B)` 接 ClientSideConnection。stdio 只归 UI。
- **输入层改判（spike 证伪 readline）**：设计原定 readline 行编辑 + raw 弹窗 pause/resume 切换；步骤 0 spike 用 pty 实测发现 `rl.pause()` 后 readline 的 keypress 监听仍消费字节（弹窗按键混进输入行，LINE "1def"）。结论：**自研 raw 键盘解析 keys.ts（StringDecoder 增量 UTF-8 + CSI/SS3 状态机）+ input.ts 行编辑**，输入行与弹窗共用同一解析，天然消除"切换残留"。CJK 宽度用自带最小 wcwidth（unicode property 正则，零依赖）；全界面 ASCII 符号。
- **/model 走 ACP 扩展方法**：SDK 0.4.5 `ClientSideConnection.setSessionModel` 错发 `session/set_mode`（辅助方法 bug，agent 服务端路由本身正确）。TUI 客户端走 `extMethod("zhente.set_model")`（agent.ts 的 extMethod 已登记，转发到标准 setSessionModel，校验/持久化/错误语义一致）——不是旁路 API。Zed 直发协议不受影响。
- **agent 侧两处小改**（均为所有客户端受益的行为增强）：`setSessionMode` 里 `session.permissions.clear()`（N1：切模式重置"总是允许/拒绝"记忆，`/access standard` 与 `/permissions reset`(语法糖重发 set_mode) 都是恢复途径，M3 不做 already-in-mode 短路）；项目初始化 turn 改传 `session.abort` signal（B3：首次进新目录 Ctrl+C 可取消，之前用独立 AbortController 最多卡 12 轮）。
- **权限弹窗**：按 agent 返回的 `options[]` 动态编号（初始化请求 3/5 项、工具 4 项，B4）；`option.name` 原样显示；Esc 优先回 `reject_once`（N4），无此选项才回 cancelled；取消 turn（Ctrl+C）时 bridge 以 cancelled resolve 所有未决权限请求（A7），否则 ensurePermission 永久 await、prompt 永不返回。
- **生命周期**：TUI 分支完全接管（不注册 ACP 模式 SIGINT/stdin-close）；`restoreTerminal()`（`?1049l`+`?25h`）幂等，挂在正常退出、`process.on("exit")`、uncaughtException/unhandledRejection、SIGTERM/SIGHUP 全路径；fatal 先 restore 再打 stderr（备用屏未恢复时用户看不到）。
- **日志**：logger.ts 加运行时 `logger.configure({ stderr:false, level, dir })`；TUI 启动即 configure 到 `$ZHENTE_LOG_DIR` 或 tmpdir（info→warn 级），日志只进文件不污染备用屏。
- **验收**：`npm run smoke:tui`（41 断言 headless：命令解析/主题/输入/通知映射/plan 整体替换/tool failed 直达/内存配对权限流/N1/A7 取消）；pty 驱动手工回归 20 项全 PASS（状态栏/中文输入/权限弹窗 Esc→reject/Full Access 横幅+badge/access 切换/model 选择器/退出恢复）；非 TTY 与 TERM=dumb 守卫友好报错。
- **顺手修复**：agent.ts prepareSession 补工具计数诊断日志（`skills=N mcpTools=N`），恢复 main 上已损坏的 `smoke:mcp` 断言（旧日志格式在 db13a84 重构中被移除，测试自初始提交未改）。
- 待办（TUI v2，设计已预留）：`/resume`（session/load）、权限弹窗内实时 bash 输出（createTerminal，terminal:true）、多行输入；交互冒烟仍是手工（无 node-pty，零依赖）。

## TUI 代码 review 修复（P0/P1，已合入 main）

- Review 文档：`plan/tui_code-review.md`。P0+P1 六项全部修复 + 冒烟断言补齐（smoke:tui 47→50 断言，另补 pty 回归）。
- **P0-1 行尾残留**：`writeDiffed` 每行重写追加 `\x1b[K`（chat/tool/dialog 行不补白，行变短/变空会残留旧字形）。
- **P0-2 resize 失效 diff 缓存**：`ui.ts` 导出 `invalidateFrame()`（清 `prevRows` + 可清屏），resize handler 与 "terminal too small" 分支都先调用再重画——否则旧宽度帧的内容相同行被 diff 跳过，放大回来大片空白。
- **P1-3 正文/工具行顺序**：`model.ts` 新增 `finalizeBeforeTool()`，收到 `tool_call` 或 `plan` 通知时先固化当前 streaming 文本段（只有文本才固化，纯 thinking 中间态如"（模型处理中…）"丢弃），转录按"解说→工具行→解说"时间序排列。
- **P1-4 bracketed paste**：进备用屏发 `\x1b[?2004h`、restore 发 `\x1b[?2004l`；`keys.ts` 在字符串层识别 `ESC[200~…ESC[201~` 整体作为一个 `paste` key（多行含 \r\n 不触发 Enter）；index.ts 将粘贴内换行归一为空格插入单行输入框。
- **P1-5 `/model` 待生效标记**：仅 turn 进行中（`state.busy`）切换才挂 `pendingModelSwitch`（状态栏"旧模型*"，prompt 返回后应用）；空闲切换立即更新 `currentModelId`、不加星、无"下一轮生效"文案——不再出现"用新模型跑的一整轮状态栏还显示旧模型"。
- **P1-6 fire-and-forget Promise**：新增 `fireAndLog(p, what)`（.catch → logger.error + 红行 notice），替换 `submit`/`quit`/`cancelTurn`/`awaitCmd` 的裸 `void`；`unhandledRejection` 从 fatal 降级为"记日志 + 红行提示"（`uncaughtException` 仍 fatal exit）——连接异常不再整 UI 退出。
- 顺手 P2-9：`bridge.respondPermission`/`dismissPermission` resolve 前先清 `#pendingPermission`/`#permissionRequest`（getter 不再返回已回答请求）。
- 新增冒烟断言：行缩短/变空含 `\x1b[K`；`invalidateFrame` 后相同内容全量重画（定位序列数≥行数）；"文本→tool_call→文本"后 assistant 在 tool 之前、且 tool_call 不产生空 assistant 行；paste 单 key 且保留内嵌换行、其后按键正常。pty 新增粘贴（多行粘贴成单行不触发发送）与空闲 `/model` 即时切换无星两个场景。

## DPAIA Benchmark（dpaia-benchmark/）

- 用途：用真实 Java 开源 issue 评测 agent 的 bug 修复能力；每个用例目录含 TASK.md / solution.patch / repo/（base_commit 快照）。
- 评测结果必须持久化到 `dpaia-benchmark/RESULTS.md`（baseline 两步 + eval 两步 + 结论），不要只留在终端。
- 本地跑法：run.sh 依赖容器路径（/evaluation-project），直接按 TASK.md 的 mvn/gradle 命令验证；跑完把结果记入 RESULTS.md。
- 环境：gson/jackson 老 pom 用 source/target 6，JDK 21 会编译失败，需 JDK 11（本机 Temurin 11）；jib 是 Gradle + JVM 8。
- 跑完一个用例记得 `git checkout -- . && git clean -fdx` 把 repo/ 恢复 base 干净状态再跑下一个。

## 已修复：流式停顿与意外正常结束（2026-09-10）

- 依据 `plan/performance_issues_unexpected_terminated.md`：provider 归一化结束原因；`length` → `max_tokens` 并标注截断，过滤/未知结束原因 → `refusal`，截断工具一律不执行并回填配对失败结果。
- `src/harness/validation.ts` 使用 Ajv 统一校验内置与 MCP 的 JSON object / Schema，拒绝非法 JSON（不再回退 `{}`）；在权限前校验，不转换类型或补默认值。
- 空正文且无工具的 `stop` 最多补偿一次，计入 maxIterations；`length` 不补偿。reasoning 仅转发/计数，不持久化或回传。正文中的伪工具仅作诊断。
- 两层 watchdog 组合用户取消信号；Session.dispose / Agent.shutdown 先 abort 再关闭 MCP；stdin EOF 与信号退出均终止活跃请求，权限等待可取消。
- 日志增加字符计数、chunk 时序及数值 usage；`streamIncludeUsage` 默认 false。`historyWarningMessages` 默认 400，仅告警，不裁剪工具配对；摘要压缩仍属后续工作，当前不调低 maxTokens。
- 回归入口 `npm run smoke:reliability`，覆盖真实本地 SSE、内置/MCP 参数拒绝、ACP stop reason、取消、stdin EOF 和 shutdown。

## 安装并使用外部（Claude Code）技能：analyze（2026-09-10）

- 来源：`/Users/ethan.yin/IdeaProjects/jet-desk/.claude/skills/analyze`（JetBrains 支持流程技能，依赖 javaperf/diogen/youtrack/glean/zendesk MCP + IDE bridge）。
- 安装方式：整目录复制到本项目 `.claude/skills/analyze/`（保持 Claude 布局，因为 SKILL.md 正文里引用的是相对路径 `.claude/skills/analyze/references/*.md`，需与本项目 cwd 对齐；已逐个校验可解析），并在 `zhente.config.json` 增加 `"skills": { "enabled": true, "dirs": [".claude/skills", "skills", "<home>/.config/zhente/skills"] }`（`dirs` 非空会**替换**默认目录，所以把默认的两个也显式列出；配置里不能用 `~`）。
  - 装到别的项目的通用做法：`<目标项目>/skills/<name>/`（默认目录，零配置），或配置 `skills.dirs` 指向含技能子目录的目录（绝对路径支持；**不支持符号链接**，`discoverSkills` 用 `ent.isDirectory()` 过滤）。
- 配套代码修复：`src/skills/index.ts` 的 `parseFrontmatter` 现在支持 YAML 块标量（`>`/`>-`/`>+` 折行、`|`/`|-`/`|+` 保留换行、自动去缩进）。此前 20 个 jet-desk 技能里有 7 个的 `description: >-` 被解析成字面量 `>-`，目录里毫无信息量。
- 新增回归：`npm run smoke:skill`（`scripts/smoke-skill.mjs`）——临时 cwd 下的夹具技能（折叠描述）+ 本地假 OpenAI 服务器驱动真实 ACP 路径，断言：折叠描述进 system prompt 目录、`use_skill` 未知名称返回可读错误、已知名称返回正文、tool_call 标题正确。
- 已知限制（要用 analyze 必须知道）：
  1. 技能在 `newSession` 时扫描，**装完要新会话才生效**（当前会话不会出现 `use_skill` 工具）。
  2. Claude 专属 frontmatter/语义不解析：`allowed-tools`、`user-invocable`、`argument-hint`、`$ARGUMENTS` 占位符——正文会原样带 `$ARGUMENTS` 字样，需要模型自己从用户输入里取参数。
  3. analyze 的实际后端是 MCP 工具（javaperf/diogen/youtrack/glean/ijproxy-monorepo/zendesk）+ jetdesk CLI + IntelliJ 单体库；MCP 只能由 ACP 客户端在 `session/new` 传 `mcpServers`，**TUI 固定传 `[]`**，ZhenTe 配置里也没有 MCP server 列表 → 在 eye-zhen-te 这个 cwd 下它是"可加载但跑不动"的展示；真正可用要在 jet-desk 环境（cwd 为 monorepo、客户端带 MCP）里跑。
  4. 复制件会与上游 jet-desk 版本漂移；`.claude/skills/` 目前是**未跟踪**状态（还没有进 .gitignore），提交前先确认是否要把 JetBrains 内部技能纳入本仓库。
- 待办（若要支持这类技能）：① 配置级 MCP server 列表（让 TUI/无客户端场景也能用 MCP 技能）；② `skills.dirs` 语义改为"追加默认目录"；③ `use_skill` 支持参数注入 `$ARGUMENTS`；④ 发现层支持符号链接（避免复制漂移）。

## IntelliJ 内置 MCP 与 custom ACP agent 接入（2026-09-10 调研）

- **客户端配置只有两个开关**：custom ACP agent 的 JSON（`EYE-ZhenTe`）里 `use_idea_mcp: true` / `use_custom_mcp: true`（IDE 侧反序列化键名 `use_idea_mcp` / `use_custom_mcp` / `idea_mcp_allowed_tools`，见 `intellij.ml.llm.agents.acp` 的 `DefaultMcpSettings`；`IdeaMcpMode` = OFF / ON_DEMAND / DEFAULT）。
  - `use_custom_mcp` → IDE 把用户在 Settings 里配的 MCP server（如 `Docker Engine`）放进 `session/new` 的 `mcpServers`。
  - `use_idea_mcp` → IDE 为这个 agent 起一个**私有 IJ MCP 会话**（`AcpIdeaMcpProviderImpl: Running private IJ MCP session for agent … over Stdio`），同样作为 `mcpServers` 条目传给 agent，名字是 `idea`。
- **私有会话的实质**（反编译 `/Applications/IntelliJ IDEA 2026.2.2.app/Contents/plugins/mcpserver/lib/mcpserver.jar`）：`<java.home>/bin/java -classpath <mcpserver jar 等> com.intellij.mcpserver.stdio.McpStdioRunnerKt`，env 传 `IJ_MCP_SERVER_PORT` / `IJ_MCP_SERVER_PROJECT_PATH` / `IJ_MCP_HEADER_*`；它是个 **stdio↔SSE 代理**，转发到 IDE 内的 `http://localhost:<port>/sse`（restricted mode，需 token 头）。MCP SDK 的 `StdioClientTransport` 默认 `stderr: "inherit"`，所以该代理的启动日志会出现在 ZhenTe（ACP agent）的 stderr 里，被 IDE 记为 `[EYE-ZhenTe] stderr`。
- **ZhenTe 侧零改动即可用**：走的就是标准 `session/new` → `mcpServers`（`src/mcp/client.ts`），工具名 `mcp__idea__<tool>`，`needsPermission=true`。
- **为什么只看到一个工具 `execute_tool`**：IDE 的 MCP 工具过滤处于 **router-only（VIA_ROUTER）** 模式 —— `~/Library/Application Support/JetBrains/IntelliJIdea2026.2/options/mcpToolFilter.xml` 里 `invocationMode=VIA_ROUTER`，配合 `acpAgents.xml` 的 `global_use_idea_mcp=ON_DEMAND`（设置页文案 “Enable router-only mode”，工具状态列显示 “Router-only”）。此时 `McpFilteredToolsListProvider` 只暴露 `UniversalToolset.execute_tool`，其余工具（含 `rename_refactoring`）**被隐藏但仍可调用**。
  - 实测证据：`zhente-acp.log` 2026-09-10 16:11:52 `MCP 'idea' 已连接，工具 1 个: execute_tool`。
  - 对照：2026-08-28 的 PyCharm 会话里 `MCP 'pycharm' 已连接，工具 51 个: … rename_refactoring …`（那个 server 是原子工具形态，非 router）。形态取决于 server 版本/过滤设置。
- **router 调用语法**（`UniversalToolset.execute_tool(command: String)`，单参数 `command`）：`<toolName> --param value --param2 value2`；对象/数组参数按 JSON 传（原文案：`Expected '--paramName value' format. For object/array parameters pass a JSON value, e.g. --findings '[{...}]'`）。如：
  `execute_tool(command="rename_refactoring --pathInProject src/a/B.java --symbolName oldName --newName newName")`
  （`RefactoringToolset.rename_refactoring(pathInProject, symbolName, newName)`，参数名从 class 常量池确认）。
- **要直接看到 `rename_refactoring` 等原子工具**：IDE 侧 Settings → Tools → MCP Server 关掉 “Enable router-only mode”（或把对应工具的 Router-only 状态改成直接暴露）→ `invocationMode` 变 DIRECT → 新会话里 ZhenTe 会拿到全部工具，名为 `mcp__idea__rename_refactoring` 等。**必须新开会话**（工具集在 `newSession` 一次性装配）。
- **坑 2 已定位（2026-09-10 晚复测）**：`mcpServers=0` 只出现在 **`session/load`（恢复旧会话）** 场景 —— IDE 侧日志 `ACP session MCP servers: 0`，即 IDE 在 `session/load` 不传 MCP。用户在 IDE 的 MCP 服务设置里点过自动配置后，**新会话稳定 `mcpServers=2`**（Docker Engine + idea，日志 16:47 两连发）。结论：**改了 MCP 开关必须新开会话**，恢复的旧会话永远拿不到 MCP。ZhenTe 侧无需改（`loadSession` 同样吃 `params.mcpServers`，是 IDE 传了 0）。
- **重大发现：IDE 内置 MCP server 的公网端口无需鉴权，可直接 HTTP 调用**。复测时 `127.0.0.1:64342` 从 `404` 变为 **`/stream` 200（streamable-http，无 token）**（`/sse` 也 200），`initialize` 返回 `{"name":"IntelliJ IDEA MCP Server","version":"2026.2.2"}`；64342 = IDEA 的 `DEFAULT_MCP_PORT`（`McpServerSettings`，私网端口 = +100 = 64442，那个才是 restricted/401）。
  - **实测成功**：写 `.zhente-mcp-probe/probe.ts`（含 `oldProbeName` 声明 + 1 处引用），POST `tools/call execute_tool` → `Successfully renamed 'oldProbeName' to 'newProbeName' in .zhente-mcp-probe/probe.ts with 1 usages.`，文件内容两处都改了（探针已删）。
  - 因此**任何会话（含当前会话、TUI）都能用 bash+curl 驱动 IDE 工具**，不依赖客户端传 `mcpServers`。
  - 安全提示：64342 无鉴权 = 本机任意进程可驱动 IDE 做重命名/执行终端等操作。
- **router-only 仍开着**（`mcpToolFilter.xml` `VIA_ROUTER` 自 08-19 未变）：`tools/list` 只有 `execute_tool`；隐藏工具共 **62 个**，用「不存在的工具名」调 `execute_tool`，错误信息会把全量清单吐出来（`Tool 'x' not found. Available tools: …`）——含 `rename_refactoring` / `get_symbol_info` / `search_symbol` / `generate_psi_tree` / `reformat_file` / `execute_terminal_command` / `build_project` / `xdebug_*` 等。
- `execute_tool` 有**两个**参数：`command`（`<toolName> --k v …`）与 `projectPath`（建议总传绝对路径，减少歧义调用）。
- **可做的 ZhenTe 侧改进（未实施）**：① 给 `mcp` 配置加 `servers` 字段（待办 ①）——`src/mcp/client.ts` 已支持 `streamable-http`/`sse`/`stdio` 三种传输，直接把 `{name:"idea", type:"streamable-http", url:"http://127.0.0.1:64342/stream"}` 配进去即可让**所有会话（含 TUI、含 loadSession）**用上 IDE 工具，零客户端改动、无需 token；② `execute_tool` 的 router 语法（`command="tool --k v"` + `projectPath`）以及隐藏工具清单值得写进技能或 system prompt 提示，否则模型看到 `execute_tool` 摸不着头脑。

## heap dump 分析能力与那次 IDE Metal OOM（2026-09-10）

- **本机 YourKit 无有效 license**：`/analyze --yourkit <hprof>` 会失败，日志 `~/.yjp/log/profiler-ui-*.log` 只有 `Cannot read license config`（2 月那次直接 `exitCode=5; Bad license`），`-export` 抛 `com.yourkit.p.ad` 且不产生任何输出文件。要用它就得先在有 license 的机器/环境激活（ITKB-A-66）。YourKit 装在 `/Applications/YourKit Java Profiler.app`（2025.9.185，自带 JBR 21 在 `Contents/jdk/...`）。
- 本机可以装 **Eclipse MAT**（`brew install --cask memoryanalyzer`，1.17.0）作为 retained size / dominator / leak suspects 的权威替代——**未安装，需用户同意**。
- 兜底方案（已实现，**已内置进 analyze 技能**：`.claude/skills/analyze/scripts/hprof-histogram.mjs` + `hprof-diff.mjs`，零依赖）：class histogram（真实 shallow size）、最大单体对象、按类加载器（插件）分组的 shallow 字节 + 各 loader 的 top 包名；`--csv` 供 diff 用，`--oop 8` 应对非压缩引用；`hprof-diff.mjs` 可直接吃两个 hprof（内部调 histogram）或两个 csv，输出增长/减少 Top、新增类、净对象与净字节变化。1.07GB dump 约 6 秒解析完。用法见 `SKILL.md` 的 "Heap dump when YourKit is missing or unlicensed" 与 `yourkit-backend.md` 的 Step F2。
  - 两个坑（都踩过并解决）：① CLASS_DUMP 的 `instance_size` 是"继承链字段字节 + **8 字节引用**、**不含对象头**"，直接当 shallow size 会系统性偏小（String 会报 14B、HashMap$Node 报 28B）；正确算法 = `align8(12 + 继承链字段，oop 按 4B)`，得到 String 24B / HashMap$Node 32B / ArrayList 24B（与真实 HotSpot 一致）。② sub-record tag 编号要用 IDEA 自带解析器 `com.intellij.diagnostic.hprof.parser.HeapDumpRecordType` 的映射校准（`javap` 反编译 `intellij.platform.ide.impl.jar` 即可），凭 JDK 文档记忆写会错位。
  - INSTANCE_DUMP 的 `nbytes` / CLASS_DUMP 的 `instance_size` 在 dump 里**一定**是 headerless + 8B 引用的值，可用来校验解析器是否同步。
- **那次 OOM 的结论（不是 Java 堆问题）**：`heapDump-idea-1789028114157.hprof`(16:15) 与 `heapDump-idea-1789029548469.hprof`(16:39) 都出自同一会话（16:11:36 启动），日志明确 `HeapDumpSnapshotRunnable - reason=OutOfMemory`，而真实 OOM 全是 **`java.lang.OutOfMemoryError: can't create offscreen surface`（JBR Metal 渲染管线，`sun.java2d.metal.MTLSurfaceData.initSurfaceNow`）**：16:11 会话 1391 次（首次 16:15:09，5 秒后就触发 dump）；当前 17:38 会话 2166 次。堆本身健康：两份 dump 存活对象 1290 万→838 万、shallow 631MB→479MB（**24 分钟后变小**，无单调增长＝无 Java 堆泄漏），`jcmd GC.heap_info` 当时 `ZHeap used 1574M / max 4096M`（`idea.vmoptions` = `-Xmx4096m -XX:+UseZGC`）。Java 侧离屏表面也没堆积（`MTLOffScreenSurfaceData` 仅 252/289 个）。系统也不缺内存（64GB、swap 0、~2GB free + 大量 inactive）。
  - 判别技巧：`can't create offscreen surface` 报的是 **Java2D/Metal 的本地内存**，但 IDEA 的 OOM 处理会照样抓 heap dump → 看到"堆很空却 dump、reason=OutOfMemory"就先 grep 日志里的 OOM 文本种类（`grep -o "OutOfMemoryError[^\"]\{0,90\}" | sort | uniq -c`）。

## analyze 技能改造：YourKit 不可用时的 fallback（2026-09-10）

- 起因：本机 YourKit 无 license，`/analyze <hprof>` 只能以"导不出来"收场。现在把当次自研的 HPROF 解析固化成技能的正式 fallback，**不再需要临场造轮子**。
- 改动清单：
  - 新增 `.claude/skills/analyze/scripts/hprof-histogram.mjs`（shallow histogram / 最大单体对象 / 类加载器+插件包归属；参数 `--top N`、`--csv out.csv`、`--oop 8`）与 `hprof-diff.mjs`（两 dump 差分：增长/减少 Top、新增类、净对象与净字节；hprof 或 csv 都吃，hprof 走内部调用生成临时 csv）。
  - `references/yourkit-backend.md`：Prerequisites 增加 **license 前置探测**（`ls ~/.yjp/am*.txt` + `grep license ~/.yjp/log/profiler-ui-*.log`，并写明未授权导出的失败特征 `com.yourkit.p.ad` / 3 秒失败 / 无任何输出文件）；新增 **Fallback 章节 Step F1–F6**：F1 先问用户是否装 Eclipse MAT（`brew install --cask memoryanalyzer`，唯一免费能给 retained/dominator/GC roots），F2 本地脚本用法，**F3 先查 OOM 文本种类**（`grep -oh "OutOfMemoryError[^\"]\{0,90\}" idea.log idea.*.log | sort | uniq -c | sort -rn` + `jcmd <pid> GC.heap_info`）判断 Java 堆还是 native/GPU，F4 能力边界（无 retained/dominator/GC roots），F5 输出模板，F6 把"YourKit 不可用"记进 `meta/user.md` 以免下次再撞；Limitations 与 "When to use" 也加了指向。
  - `SKILL.md`：frontmatter description、路由表 heap dump 行的 Notes、`### YourKit` 执行段（先探测 license，再分 MAT/本地脚本两条路，并强调"有第二份 dump 一定要做差分"）、以及 examples 新增 "Heap dump when YourKit is missing or unlicensed"。
- 设计要点（别退化）：**先探测再导出**（未授权 3 秒就失败，别等）；**差分优先**（堆变小是最强的"Java 侧没累积"证据）；**先定 OOM 类型**（heap dump 对任何 OOM 都会抓，堆半空是正常结果而非分析失败）；**明说局限**（shallow-only，需要保留路径就推 MAT/授权 YourKit）。
- 脚本鲁棒性：坏输入给 `error: <file> is not an HPROF heap dump (header: ...)`，gzip 输入提示先解压；`uncaughtException` 转成单行 `error:` 输出；无参数时打印 usage 并 exit 2。
- 注意：`.claude/skills/` 仍是**未跟踪**目录（见上文 analyze 技能条目），脚本改动是否会进本仓库取决于该目录的提交决定。

## 报告归档：plan/heap_analyze_report.md（2026-09-10）

- 那次 IDE Metal OOM 的完整分析报告已写入 `plan/heap_analyze_report.md`（8 章 + 2 附录：工具链限制与 YourKit license 证据、环境与两份 dump 概览、OOM 类型判定、堆内容与类加载器归属、两份 dump 差分、可复用的判别方法论、能力边界、后续动作、复现命令、涉及文件清单）。
- 报告里的结论/数字均已回查原始日志与 dump 校验过（含 OOM 次数、LowMemoryWatcher 触发次数、文件大小、对象/shallow 统计）。
- 注意：`plan/` 在 `.gitignore` 里，报告属本地文档，不会进仓库。


- 依据 `plan/harness_compare_to_dsh(Fable).md` §4/§5，把 10 项改动写成可执行 plan（含每步文件/规模/验收断言/风险，以及"明确不做"清单）。
- 顺序：① H1① 占位文案"结果未知"（1 行）② M1 `isError` 前缀 ③ H2 prompt busy 拒绝 + finally 条件清理 abort ④ H3③ 截断改头尾各保留（新增 `harness/truncate.ts`）⑤ M2 收敛序列化入口带 `modelId` ⑥ H3① 历史告警走 `notice()` ⑦ M4 首 token 前有界重试 ⑧ M3 工具 deadline + 进程组终止 ⑨ H1② started 标记 + L1 JSONL 化 ⑩ H3②③ token 估算→摘要压缩。
- 几个已定的设计判断（避免返工时反复讨论）：turn 内取消的"未执行"文案**保持不动**，只改跨重启场景；`maxRetries: 0` 是正确决策，重试补在 harness（仅首 delta 之前、幂等）；不用 `AbortSignal.any`（node>=20 但 20.3 才稳定），自写 `linkSignals`；`sanitizeHistory` 的 started 证据跟着 JSONL 事件流一起做（单独做等于改两次存储）；压缩摘要消息不能用 `user` 角色（重蹈 L2）；`plan/subAgentPlan-*.md` 排在本 plan 之后。
- 步骤 10 有明确前置：先用真实长任务（DPAIA 用例）确认真的被上下文卡住，否则只做可观测性。**已按该门槛执行**：只做 10a，10b/10c 挂起（观测证据见上一节）。

## 已完成：Harness 加固 plan 步骤 1–9 + 10a（2026-09-15）

- 依据 `plan/harness_hardening_plan.md`，步骤 1–9 各一个 commit（`4dddc0d` → `d69d891`），步骤 10 只做了 10a（`ffcabe5`）。全程 `npm run typecheck` + `smoke:reliability`（现 32 组）+ `smoke`/`smoke:openai`/`smoke:mcp`/`smoke:skill`/`smoke:tui` 全绿。
- 关键实现点（改动别退化）：
  - 占位文案**两档**：`sanitizeHistory(messages, startedToolCalls)`；启动过或**无任何 started 证据**（空集合，旧日志）→「结果未知…先核实外部状态」，有证据但未启动 →「未执行…可以安全重试」。turn 内取消路径仍是"未执行"。
  - `persistence.ts` 改为 **JSONL 事件流**：`meta` / `message` / `reset` / `tool_started` / `tool_finished` / `mode` / `model`；`persistSession` 是唯一写入口，内部只追加增量（进程内 `tracked` 记账；首次写盘时先 `readMessageCount` 采纳已有长度，避免重复追加）。`tool_started` 必须在 `tool.run` **之前**写。旧 `.json` 在首次 `loadSession` 时迁移成 `.jsonl` 并删除原文件。
  - 工具 deadline：`Promise.race([tool.run(...), deadline])`——只 abort signal **不够**（工具不理会就永久 await，冒烟直接挂死，实测踩过）；兜底常量 `DEFAULT_TOOL_TIMEOUT_MS=300_000` 防止 config 字面量缺字段时 `setTimeout(fn, undefined)` 立即触发。
  - `linkSignals(a,b)` 自写替代 `AbortSignal.any`（node 20.3 才稳定）；`finally` 里 `dispose()` 摘监听。
  - bash 本地路径 `spawn(..., {detached:true})` + `process.kill(-pid, "SIGKILL")` 杀整组（catch 回退单进程，Windows）；超时输出改 `Error: 命令执行超时（Xms）…` 且 `isError=true`。客户端终端路径也受 `timeout` 约束（race + `terminal.kill()`）。
  - LLM 重试只在**首个 delta 之前**（`AttemptState.yieldedAnything`），不动 `maxRetries: 0`，不重试 `StreamTimeoutError`；`sleep` 可被 signal 打断；`Retry-After` 用 SDK 的 `Headers` 对象读（`error.headers.get("retry-after")`，直接下标取不到——踩过）。
  - 估算：`harness/context.ts` 的 `estimateTokens` / `calibrateEstimate`（比例夹在 0.5×–2×）/ `shouldCompact`（10b 用）；`OpenAIProvider.lastPromptTokens` 供校准；日志 `estimatedPromptTokens=… rawEstimate=… lastPromptTokens=…`。

## 观测结论：上下文压缩（10b/10c）暂不做（2026-09-15）

- 证据来源：`~/Library/Logs/JetBrains/IntelliJIdea2026.2/*.log` 全部 `LLM request end` 行（1511 次真实请求）+ `~/.config/zhente/sessions/*.json`（245 个会话）。
- 结论：
  - **实测最大 prompt 182,506 tokens / 789 条消息**，后端正常返回；**从来没有任何一次 `context_length_exceeded`**（grep 全日志 0 命中）。
  - 延迟与 prompt 体积无明显相关：`prompt>100k` 平均 4.1s（最大 24.5s），`prompt<20k` 平均 3.1s——长上下文还没到"变慢"的程度。
  - 本地会话文件里按估算最大的一个（`664ab557`）约 34.6 万 token / 790 条消息，也从未触发过服务端上下文错误。
  - 观测到的真实失败全是瞬时连接问题（`TypeError: terminated` ×6、`APIConnectionError` ×2、`APIConnectionTimeoutError` ×1），正是步骤 7 现在会重试的那一类；自己 watchdog 的超时记录为 0。
- 因此按 plan §10 的前置门槛：**只做 10a**，压缩留到确有 `context_length_exceeded` 或明显变慢时再做。届时阈值建议按模型实际窗口设（不要用 128k 默认，实测已稳定跑到 182k）。

## 实施计划：plan/harness_hardening_plan.md（2026-09-15；步骤 1–9 + 10a 已完成，见上两节）

## maxTokens（输出上限）调参与按模型覆盖（2026-09-15）

- 症状：使用中频繁出现 `[输出被截断]`。实测证据（`~/Library/Logs/JetBrains/IntelliJIdea2026.2/*.log`）：1375 次真实请求中 **18 次 `finishReason=length`**，`completion_tokens` 精确等于 8191/8192 → 是本地 `provider.maxTokens: 8192` 卡住，不是后端限制。
- 根因：`max_tokens` 是**单次回复**的上限，由「reasoning + 正文 + 工具调用参数」**共用**。三次有字符计数的截断：`reasoningChars=28987/contentChars=0`（8K 全烧在思考上、正文一个字没出 → 表现为「模型响应为空」）、`reasoningChars=20134/contentChars=15/toolArgumentChars=7793`、`reasoningChars=108/contentChars=8/toolArgumentChars=18844`（写 1.9 万字符文件的参数就约 5k tokens）。撞顶时本次响应的工具调用被整体拒绝，回合以 `max_tokens` 结束。
- 代码改动（commit `b750b59`）：`provider.models[].maxTokens` 可按模型覆盖全局（`OpenAIProvider` 构造时 `modelConfig?.maxTokens ?? cfg.maxTokens`）；`LLMProvider.maxTokens` 暴露给 harness，截断提示改为 `[输出被截断] 模型达到输出 Token 上限（maxTokens=32768）。该额度由「思考过程 + 正文 + 工具参数」共用…`，并新增 `logger.warn(... maxTokens= textChars= reasoningChars= toolCalls=)`。
- 本机配置：`zhente.config.json` 的 `maxTokens` 8192 → **32768**（全局 + `deepseek-flash` 各一份，便于以后给 pro 单独调大）。该文件被 gitignore，不进仓库。
- 取值依据：`max_tokens` 常被计入上下文预算（`prompt + max_tokens ≤ 窗口`）。实测**最大 prompt 182,506 tokens 且从未溢出**，故 32768 在窗口 ≥256K 时安全；**不要**用文档上限 393,216（长会话会被 400 顶掉）。若确认窗口 ≥256K 且很少跑到 180k+ prompt，可提到 65536（对齐推理模型默认输出）；`reasoning_effort=max`→128K 那一档需要额外支持 `reasoning_effort` 参数（当前未实现，属可选扩展）。
- 调大不额外花钱（按实际输出计费），只放宽单轮最坏延迟。

## 待办：Harness 加固 plan 剩余项

- 10b/10c 上下文压缩：按实测证据**挂起**（同上文"观测结论"节）。重启前先看有无新的 `context_length_exceeded` 证据，不要用 128k 之类的默认窗口猜阈值。
- `reasoning_effort` / `extraBody` 透传（本轮派生的可选项）：若想把思考预算与输出预算分开控制（如 `reasoning_effort=max` 换取 128K 默认输出，或反向压低思考开销），需要在 provider 请求体里透传该参数。当前实现只发 `max_tokens`。

## 技能：deepseek-usage（余额 + 本地 token 用量，2026-09-20）

- 位置 `skills/deepseek-usage/`（`SKILL.md` + `scripts/deepseek-usage.mjs`，零依赖，Node ≥ 20）。`skills/` 是默认技能目录且在 `skills.dirs` 里，**新会话才生效**。
- `balance`：官方 `GET <base>/user/balance`（DeepSeek 唯一公开的账户级接口）。凭证顺序 `--api-key` → `$DEEPSEEK_API_KEY` → `$OPENAI_API_KEY`（本项目配置用这个）→ 配置 `provider.apiKey`；只打印来源、绝不打印 key；base 结尾 `/v1` 时自动回退到不带 `/v1` 的端点；401 / 超时 / 非 JSON 有专门报错。
- `usage`：**官方没有账户级用量 API**，改为聚合本地日志里 `LLM request end … usage={…}` 行的 token，按日期与模型汇总。来源顺序 `--log` → `$ZHENTE_LOG_DIR`/`$ZHENTE_LOG_FILE` → `~/.config/zhente/logs` → 兜底 JetBrains IDE 日志（按 mtime 取最近 15 个，跨平台根目录）。去重键 = agent 时间戳 + 剥掉 IDE 前缀的整行，所以同一行同时出现在 `zhente-acp.log` 和 `idea*.log` 只算一次（实测 21 条而非 41 条）。
- 关键前提写进了 SKILL.md：只有 `provider.streamIncludeUsage=true` 的请求才带 usage，否则日志里是 `usage=undefined`（只能统计请求数）。报告会显式提示"无 usage 记录"的条数。
- 刻意未做：成本换算（DeepSeek 定价区分缓存命中，日志里没有该信息 → 误导风险）、余额快照/差额（需状态文件，用户未要求）。需要就去 https://platform.deepseek.com 核对。
- 校验：`discoverSkills` 能发现（frontmatter 块标量正常解析进目录）；`balance` 实测返回 CNY 48.05；`usage` 实测 4MB 日志 0.07s、IDE 兜底 0.12s；非法参数统一 `error: …` + exit 2；`npm run typecheck` 通过。
- Code review 修复（三处，均实测复现后再改）：
  1. `resolveBaseURL` 空串绕过默认值——`"" ?? "https://api.deepseek.com"` 返回 `""`，`balanceEndpoints("")` 生成相对 URL `/user/balance` → `fetch` 抛 `TypeError: Invalid URL`（只在「无配置文件 且 无 `$DEEPSEEK_BASE_URL`」时命中，正是默认值该生效的场景）。现在每一级都用 `.trim() || undefined` 归一化空串，并加 `^https?://` 校验，非法就 `error: base URL 必须是 http(s) 绝对地址` + exit 2。
  2. IDE 日志兜底的 `statSync(file)` 调了两次（`.isFile()` 与 `.mtimeMs`），两次之间文件被删会抛出 catch 覆盖不到的异常；改为只 stat 一次存 `stats`。
  3. `--json` 输出漏了 `unreadableFiles`：`scanLogFile` 写进 `state.unreadable` 后只有人类可读分支会渲染，JSON 消费方无法察觉有文件读不到。已补（实测 chmod 000 的文件出现在两个输出里）。
- 顺带保留的行为：`--base-url https://api.deepseek.com/v1` 也返回 200（`/v1/user/balance` 可用），`/v1` 回退分支目前用不到但无害。
- 待办（若要扩展）：`--price-in/--price-out` 成本估算、`balance --compare`（存上次余额算消耗）、把 usage 统计做成 ZhenTe 的一个内置命令而不是技能。

## 技能跨项目共享：install-skills.sh（2026-09-20）

- 需求：把 `skills/deepseek-usage` 给其他项目的 ZhenTe session 用。技能发现是**按 session cwd** 扫描的，与 agent 安装位置无关（全局 npm link 的 `eye-zhen-te@0.1.0` 仍是同一份代码），所以三条路：① 拷进目标项目 `<cwd>/skills`（默认目录，零配置）；② 装到全局 `~/.config/zhente/skills`（默认目录之一，**只对未设置 `skills.dirs` 的项目生效**）；③ 目标项目设 `skills.dirs` 并把自己那份目录列进去。**符号链接不可用**（`discoverSkills` 用 `ent.isDirectory()` 过滤，symlink 被跳过）。
- 实测确认的发现语义（`discoverSkills`）：`skills.dirs=[]` → `<cwd>/skills` + `~/.config/zhente/skills` 都扫；`skills.dirs=["skills"]` → **只**扫这一个（全局技能消失）；`["skills", "<HOME>/.config/zhente/skills"]` → 两个都扫。
- 新增 `scripts/install-skills.sh`（`--dry-run`/`--force`/`--skill NAME`/`--target DIR`，env `ZHENTE_SKILLS_DIR`）：把 `skills/*/`（须有 SKILL.md）拷到目标全局目录，已存在的同名技能默认跳过、`--force` 才覆盖；结尾打印三条「装了还看不见」的检查项（`skills.dirs` 覆盖 / 需新开会话 / `skills.enabled`）。**退出码：所有错误一律 `exit 1`**（`die()` 就是 `exit 1`，含未知参数、`--skill` 找不到、`--skill` 缺 SKILL.md）；只有 `-h/--help` 是 `exit 0`。别按「参数错误 → 2」的通用直觉写检查脚本。（`skills/deepseek-usage/scripts/deepseek-usage.mjs` 的「非法参数 `exit 2`、`--help` `exit 0`」是**另一个脚本**的约定，两者不要混写。）
- **bash 坑（踩过并修）**：`echo "… $dest（要覆盖加 --force）"` 里 `$dest` 紧挨全角括号，bash 会把 `（` 的字节并进变量名 → `dest<乱码>: unbound variable`（只在幂等分支触发，首跑不报）。规则：`$var` 后面紧跟非 ASCII 字符时一律写 `${var}`。已全文件扫过并修正。
- 脚本侧的跨项目防护：`resolveBaseURL` 现在返回 `{base, source}`，`balance` 会打印「端点（base URL 来自 config …/provider.baseURL）」；若 base 来自**配置文件**且 host 不是 `*.deepseek.com`，向 stderr 打一行 warning 提示改用 `--base-url` / `$DEEPSEEK_BASE_URL`（否则会静默拿别的厂商端点去查余额 → 404/401）。`--json` 增加 `baseUrlSource`。推荐跨项目姿势：`DEEPSEEK_API_KEY=… DEEPSEEK_BASE_URL=https://api.deepseek.com`（优先级高于配置文件，不会被别的项目盖掉）。
- SKILL.md：定位脚本改为候选路径循环（`<cwd>/skills` → `<cwd>/.claude/skills` → `$ZHENTE_CONFIG` 同级 → `~/.config/zhente/skills`），不再用 `find .`（全局安装时它在 cwd 里找不到）；新增"跨项目使用"章节说明配置发现/日志发现/账户共享三点；排查表补 404-借用了别项目 baseURL 一行。
- 顺手更新 AGENTS.md：`scripts/` 目录说明、技能章节补共享方式、常用命令加 `scripts/install-skills.sh`。
- 二轮 review 修复（三处，均先复现/实测再改）：
  1. `install-skills.sh` 的 `--skill <name>` 指向缺 SKILL.md 的目录时**静默成功**：SKILL.md 检查排在 `$ONLY` 过滤**之前**，坏目录走"跳过"分支（skipped=1），末尾 `installed=0 且 skipped=0` 的 die 条件不再成立 → 打印"安装 0 个，跳过 1 个"、exit 0。实测复现（exit=0）。修法：`$ONLY` 过滤提到 SKILL.md 检查之前，并在命中 ONLY 但缺 SKILL.md 时直接 `die "技能 'X' 存在（路径）但缺少 SKILL.md，无法安装"`（exit 1）。附带好处：指定单个技能时不再打印无关目录的"跳过"噪声。
  2. `usage` 的 total 用 `??` 回落：`total_tokens ?? prompt+completion` 在 `total_tokens: 0`（占位/异常响应）时照抄 0。抽出 `usageTotal(usage)` 统一成 `num(usage.total_tokens || prompt+completion)`，两处调用点（addUsage 与 state.total 的 mergeBucket 入参）都换掉——单一实现避免漂移。夹具验证：4 条 usage（150 / 0 / 缺字段 / 全 0）合计 450，修复前为 300。
  3. `createReadStream` 外层 `catch { return; }` 是死代码且会静默丢文件：实测确认 ENOENT / EACCES / EISDIR 都由**异步 error 事件**触发、在 `for await` 里被外层 try 捕获（EACCES 用例正是走这条路记录进 `state.unreadable` 的），只有非法 encoding 之类才同步抛出（encoding 是字面量 "utf8"，不可达）。改成把捕获到的错误也记入 `state.unreadable`，不再无声 return。
- **bash 坑（第二次踩，same root cause）**：新加的 `die "技能 '$ONLY' 存在（$src）但缺少 SKILL.md"` 里 `$src）` 的全角括号再次被并进变量名。规则重申：`$var` 紧跟非 ASCII 字符一律写 `${var}`；可用 `perl -ne 'print if /\$[a-zA-Z_][a-zA-Z0-9_]*[^\x00-\x7F]/'` 全文件扫（macOS 的 grep 没有 `-P`）。
- 用例矩阵实测（install-skills.sh）：`--skill` 有效+force→0；`--skill` 缺 SKILL.md→1（含明确报错）；`--skill` 不存在→1；`--skill` 已存在不加 force→0 且提示"已存在，未覆盖"；dry-run→0；未知参数→1；全量（有/无坏目录）→0。

## 踩坑：长文档用 edit_file 连改可能被写成"拼接文件"（2026-09-21，根因未定）

- 现象：同一 session 内用 `edit_file` 连续改 `plan/hooks_support.md`（长文档，user 用 `@` 引用过、很可能在编辑器里打开）时，**两次**出现文件变成「前半截（在某行中途被截断）+ 紧接着整篇全文」的拼接内容（1087 行 / 86KB，`## 1. 背景与问题`、`修订` 标记各有两份），`edit_file` 因 `old_string` 不再唯一而报错，实际是被污染了。
- 复现尝试（都正常，未能复现）：随后用 `edit_file` 单次改同一文件、新建 3 行探针文件改一行（走的是客户端 `writeTextFile` 路径）→ 内容均正确。因此根因未定，**怀疑**是编辑器文档缓冲与客户端写盘之间的竞态（`src/tools/fs-tools.ts` 的 `writeText` 优先走 `clientCaps.writeTextFile`，即写盘经过 ACP 客户端，而不是 agent 进程直接落盘）。
- **恢复手段（本次有效，但有前提——先读下面两条限制）**：`plan/` 在 `.gitignore` 里，git 救不了。思路是从该 session 的 JSONL 恢复原文——取首个 `read_file` 的 tool result（`~/.config/zhente/sessions/<id>.jsonl`，用 python 解析取 `message.role == "tool"` 且以文档首行开头的 `content`），再把该 session 里所有 `edit_file` 的 `old_string`/`new_string`（在 assistant 消息的 `tool_calls[].arguments` 里）按顺序重放（每条先断言 `old_string` 唯一，出现 0 或 >1 次立即中止——0 次说明重建基线已不对）。之后用 `bash`（python/`cp`）直接落盘，不要再走 `edit_file`。
  - **前提 A（不是"必然完整"）**：tool result 在落盘前经过 `truncateMiddle(s, MAX_TOOL_OUTPUT)`（`src/harness/loop.ts:446`，`MAX_TOOL_OUTPUT = 100_000` 字符，`:18`），JSONL 里存的是**截断后**的内容——文件本身 ≥100K 字符时重建结果会**静默缺中间段**；另外 `read_file` 带 `line`/`limit` 时只存切片（`src/tools/fs-tools.ts:31-35`），必须用**不带 line/limit 的首次读取**。本次的 tool result 是 **22,913 字符**（33,380 字节），远低于 100,000 字符阈值，故侥幸完整——注意别拿「污染后 86KB」当参照（那是重复拼接后的字节数）。
  - **前提 B（重建后必须校验）**：① `content` 里不含截断标记 `…(输出过长，已省略中间`（`src/harness/truncate.ts:16` 的 `truncationMarker`）；② 长度与预期一致（重放后可 `wc -c` 比对，若原文曾是 `read_file` 的完整输出则两者应当相等）；③ 重放结束时最后一条 `edit_file` 也成功匹配。任一不满足 ⇒ **不要**用这份重建结果覆盖磁盘文件。
  - 不满足前提 A 时改用**编辑器 Local History**（IDEA 右键文件 → Local History → Show History；底层存在 `~/Library/Caches/JetBrains/<IDE><版本>/LocalHistory/`，本机已确认多个 IDE 都有该目录）/ macOS Time Machine 恢复；这两条才是"无条件完整"的来源。
- 纪律：改这类长文档前先 `cp` 到 `/tmp` 备份；改完用 `wc -l` + 每个 `## 标题` 的 `grep -c`（应恰好 1）校验，别等下一处 `edit_file` 报"出现 2 次"才发现。
