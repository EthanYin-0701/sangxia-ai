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

## 待办：TUI 支持（设计已完成，未实现）

- 设计文档：`plan/tui_support.md`（`zhente tui` 子命令、进程内 ACP 内存流配对、/model 与 /access 斜杠命令、红/绿/白三色主题）。已过两轮 review（`plan/tui_support-review.md`、`plan/tui_support-review2.md`），backlog A/B/C 组与 N1~N4 全部落地。
- 核心洞察：`/model`(session/set_model) 与 `/access`(session/set_mode) 的能力 agent 侧已就绪并随会话持久化；TUI 通过内存流配对（PassThrough + ndJsonStream + ClientSideConnection，方向见设计 §2 C6）驱动同一 ZhenTeAgent；stdio 只归 UI。agent.ts 仅两处 1~2 行小改：`setSessionMode` 里 `session.permissions.clear()`（N1：切模式即重置"总是允许/拒绝"记忆，Zed/TUI 同时受益）+ 项目记忆初始化 turn 传 `session.abort` signal（B3 既存缺陷）。
- 命令语义（最新）：`/access` 无参**只显示不切换**，进 Full Access(auto) 需 `/access full` + 二次确认（C3）；`/model` 下一轮才生效（B5），`/access` 立即生效。
- 配色：默认**不强制黑底**（撞浅色/半透明终端），`--crt` 才输出 `\x1b[40m`；颜色永不作唯一通道 + 支持 NO_COLOR（C1）；界面符号全 ASCII（B9，自 wcwidth ~30 行，零新依赖）。
- 日志：logger 无条件写 stderr（`logger.ts` emit），TUI 必须 `logger.configure({ stderr:false })` + ZHENTE_LOG_DIR 落盘；配置须运行时 configure（模块加载即固化，A2）。
- 关键坑：中文 IME → 输入行 readline cooked 而非裸 raw；TUI 分支完全接管生命周期（不注册 ACP 模式 SIGINT）；崩溃/信号恢复用幂等 `restoreTerminal()`（B8）；权限弹窗 options 动态编号、Esc 优先回 reject_once（B4/N4）；取消 turn 须 resolve 未决权限请求（A7）。
- 实现时建议按 plan/tui_support.md §13 的 0~8 步走（**步骤 0 是 cooked↔raw spike，失败直接上 ink**）；跑完冒烟记得把 src/tui/ 目录、`zhente tui` 入口与 `smoke:tui` 写进 AGENTS.md，README 加 TUI 用法章节。

## DPAIA Benchmark（dpaia-benchmark/）

- 用途：用真实 Java 开源 issue 评测 agent 的 bug 修复能力；每个用例目录含 TASK.md / solution.patch / repo/（base_commit 快照）。
- 评测结果必须持久化到 `dpaia-benchmark/RESULTS.md`（baseline 两步 + eval 两步 + 结论），不要只留在终端。
- 本地跑法：run.sh 依赖容器路径（/evaluation-project），直接按 TASK.md 的 mvn/gradle 命令验证；跑完把结果记入 RESULTS.md。
- 环境：gson/jackson 老 pom 用 source/target 6，JDK 21 会编译失败，需 JDK 11（本机 Temurin 11）；jib 是 Gradle + JVM 8。
- 跑完一个用例记得 `git checkout -- . && git clean -fdx` 把 repo/ 恢复 base 干净状态再跑下一个。
