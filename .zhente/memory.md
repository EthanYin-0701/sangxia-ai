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

## 待办：Sub Agent 工作模式（设计已完成，未实现）

- 设计文档：`plan/subAgentPlan-ds4flash.md`（spawn_subagent 工具、独立子上下文循环、权限模型、配置 schema、实施步骤）。
- 核心思路：工具层实现 `spawn_subagent`，进程内开独立 LLM 上下文；ACP 协议层零改动；子代理无权限通道，未授权变更工具默认拒绝。
- 实现时建议：先独立轻量循环，验证后再把 runTurn 抽成 runToolLoop 复用；跑完冒烟记得更新 AGENTS.md 目录约定与扩展点。

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

- OpenAI-compatible provider 支持 `provider.requestTimeoutMs`，默认 120 秒，避免模型请求无限等待。
- 每次请求记录 start、首个流 chunk 延迟、总耗时和 `finish_reason`；turn 在等待模型期间向 ACP 客户端发送“模型处理中…”思考状态。
- 若请求完成但没有正文和工具调用，记录空可见内容告警，便于识别 reasoning-only、过滤或后端兼容性问题。

## ACP 会话模型选择

- `provider.models` 可配置 ACP 模型目录（`modelId` / `name` / 可选 `description`）；`provider.model` 是新会话默认模型，配置目录时默认模型必须包含在目录中。
- `session/new`、`session/load` 返回 `models`，`session/set_model` 按会话切换；当前 `modelId` 随会话持久化，prompt 和项目初始化均使用所选模型。
- 本地 DeepSeek 配置当前开放 `deepseek-v4-flash` 和 `deepseek-v4-pro`，默认 `deepseek-v4-flash`。
- ACP TypeScript SDK 0.4.5 的 `ClientSideConnection.setSessionModel` 错误发送 `session/set_mode`，但 Agent 服务端 `session/set_model` 路由正确；Zed 直接发协议请求不受该辅助方法 bug 影响。

## TUI 支持（已实现，feature-tui 分支）

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

## TUI 代码 review 修复（P0/P1，已合入 feature-tui）

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
