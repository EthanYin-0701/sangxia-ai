# ZhenTe 项目记忆

## 维护方式

- 这里保存跨 ACP session 的项目背景、重要决策和未完成事项。
- 完成较大的任务后，请让 agent 更新本文件；不要把临时命令输出长期堆在这里。

## 当前项目

- 项目是基于 Node.js/TypeScript 的 ACP coding agent。
- LLM 使用 OpenAI-compatible `/chat/completions` 接口。
- 构建产物输出到 `dist/`，主要开发命令是 `npm run typecheck` 和 `npm run build`。

## 已修复：tool_calls 历史不一致导致 400

- 症状：`400 An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'`。
- 根因：turn 被取消/中断时（用户取消、权限流程异常、多工具中途 abort），assistant 消息（含 tool_calls）已 push 并持久化，但未执行的 tool_call 没有对应 tool 响应消息，下一轮把坏历史发给 API 即报 400。MCP 工具（needsPermission=true）多调用场景最容易触发。
- 修复（src/harness/loop.ts）：
  1. `sanitizeHistory()`：每次 runTurn 开头修复历史——为缺失响应的 tool_call_id 补占位 tool 消息、丢弃孤儿 tool 消息，回写并持久化。
  2. `executeToolCall` 全部 `conn.sessionUpdate` 改走 `safeSessionUpdate`（try/catch），`ensurePermission` 抛错按拒绝处理——任何异常路径都保证 `pushToolResult` 执行。
  3. abort 时给剩余未执行 tool_calls 补齐占位 tool 响应再返回。
- 注意：不要删掉 runTurn 开头的 sanitize，它是崩溃/进程被杀场景的最后兜底。

## 初始化范围

- 首次初始化项目记忆前，通过 ACP 权限请求让用户选择仅读取当前工作目录，或同时读取其上层目录；无论选择哪种范围，初始化只写入当前目录下缺失的记忆文件。
- 如果首次用户 prompt 明确提到一个已存在的目录，初始化确认会额外提供在该目录下初始化的选项，并按确认后的目录检查和写入项目记忆。

## LLM 等待反馈与超时

- OpenAI-compatible provider 支持 `provider.requestTimeoutMs`，默认 120 秒，避免模型请求无限等待。
- 每次请求记录 start、首个流 chunk 延迟、总耗时和 `finish_reason`；turn 在等待模型期间向 ACP 客户端发送“模型处理中…”思考状态。
- 若请求完成但没有正文和工具调用，记录空可见内容告警，便于识别 reasoning-only、过滤或后端兼容性问题。

## DPAIA Benchmark（dpaia-benchmark/）

- 用途：用真实 Java 开源 issue 评测 agent 的 bug 修复能力；每个用例目录含 TASK.md / solution.patch / repo/（base_commit 快照）。
- 评测结果必须持久化到 `dpaia-benchmark/RESULTS.md`（baseline 两步 + eval 两步 + 结论），不要只留在终端。
- 本地跑法：run.sh 依赖容器路径（/evaluation-project），直接按 TASK.md 的 mvn/gradle 命令验证；跑完把结果记入 RESULTS.md。
- 环境：gson/jackson 老 pom 用 source/target 6，JDK 21 会编译失败，需 JDK 11（本机 Temurin 11）；jib 是 Gradle + JVM 8。
- 跑完一个用例记得 `git checkout -- . && git clean -fdx` 把 repo/ 恢复 base 干净状态再跑下一个。
