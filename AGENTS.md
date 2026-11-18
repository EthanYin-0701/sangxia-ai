# AGENTS.md — Sangxia 项目工作规则

## 项目简介

Sangxia（sangxia-ai）是 Node.js/TypeScript 写的 ACP（Agent Client Protocol）编程 agent：经 stdio JSON-RPC 与 Zed 等客户端通信，自带工具 harness（流式输出 → 工具调用 → 权限确认 → 执行 → 回喂 → 收敛），LLM 走任意 OpenAI 兼容 `/chat/completions` 端点；支持 MCP、本地技能（Skills）与本地配置驱动的生命周期钩子（Hooks），另有终端 UI（`sangxia tui`）。用户文档见 `INSTRUCTIONS.md`。

Issue tracker（YouTrack，`SA` 项目）：https://yt-air-demo.youtrack.cloud/issues/SA —— 代码评审发现、待办缺陷一律提在这里，不要只写在本地记忆里。

## 技术栈

- TypeScript 5.6+、Node.js >= 20、ESM + `NodeNext`（相对导入带 `.js`），`strict` + `noUncheckedIndexedAccess`。
- 依赖：`@agentclientprotocol/sdk@2.7.0`（固定版本；只在 `src/acp/agent-app.ts` 用 `agent()` 路由，2.x 强制先 `initialize`）、`@modelcontextprotocol/sdk`、`openai`、`zod@4`、`ajv` + `ajv-formats`（`harness/validation.ts` 的工具参数 JSON Schema 校验）、`tinyglobby`。
- `src/config.ts` 用 `zod/v3`（依赖 v3 嵌套 `.default({})` 语义）；改用 v4 API 前须迁移 `.prefault({})` / `z.record(k, v)` 并对比解析结果。
- 单元测试：`test/unit/*.test.ts`（`node:test`，经 tsx 直接导入 `src/`，无需 build）；冒烟：`scripts/smoke-*.mjs`（作为 ACP 客户端跑 `dist/`，先 build）。CI 见 `.github/workflows/ci.yml`。

## 常用命令

```bash
npm run typecheck     # 提交前必跑（含 test/）
npm run lint          # ESLint
npm test              # 单元测试（无需 build）
npm run build         # 编译到 dist/
npm run check:docs    # 文档一致性：路径/脚本存在、CLAUDE.md 的 harness 覆盖与 TODO 标记、本文件体积预算
npm run smoke         # 离线 E2E：ACP 握手 + 工具 + 权限流（mock provider）
# 其余冒烟：smoke:openai / smoke:mcp / smoke:skill / smoke:tui / smoke:hooks /
#           smoke:reliability / smoke:permissions / smoke:setup / smoke:auth /
#           smoke:model-config / smoke:check-docs（CI 用 glob 跑全部 scripts/smoke*.mjs）
```

## 目录约定

```
src/agent.ts       ACP 入口（initialize/newSession/loadSession/prompt/cancel/模式/模型），组装会话工具集
src/acp/content.ts prompt content blocks → 纯文本（图片/音频只留说明，能力位仍为 false）
src/session.ts     单会话状态；src/persistence.ts 会话持久化（JSONL 事件流）
src/harness/       loop.ts 主循环、permissions.ts 权限门、tool.ts 工具契约、validation.ts 参数校验、
                   truncate.ts 头尾截断、context.ts prompt token 估算
src/llm/           LLMProvider 接口 + openai/mock 实现 + factory.ts
src/tools/         内置工具（fs-tools/bash/plan/ask-user/fetch-url）+ scope.ts（工作区边界、命令前缀、
                   高危命令、内网目标判定）
src/mcp/ src/skills/ src/hooks/ src/tui/   MCP client、技能、生命周期钩子、终端 UI
src/config.ts      配置加载与校验；src/setup.ts 配置向导；src/logger.ts 日志；src/version.ts 版本（agentInfo）
src/project-memory.ts  加载 AGENTS.md / .sangxia/memory.md（+ ~/.config/sangxia/AGENTS.md）
scripts/           冒烟测试、check-docs.mjs、install-skills.sh、prepare-registry.mjs；skills/ 本项目自有技能
```

## 工作规则

1. **先读后改**：先用 `read_file`/`list_dir`/`glob`/`grep` 确认内容，再用 `edit_file` 做最小精确改动。构建/测试/git 走 `bash`。
2. **stdout 是协议通道**：严禁 `console.log`；日志一律走 `logger`（stderr / `SANGXIA_LOG_FILE` / `SANGXIA_LOG_DIR`）。新 ACP handler 用 `logger.withSession(id, ...)` 包裹，否则日志落入 `global.log`。
3. **密钥与产物**：`sangxia.config.json` 与 `dist/` 已 gitignore，不提交、不手改；密钥用 `${ENV_VAR}` 引用。
4. **记忆维护**：项目背景、决策、待办写 `.sangxia/memory.md`（本地文件，不入库）；本文件只放长期有效的规则，保持精简（每次请求都会全文进入 system prompt，`check:docs` 设有体积上限）。
5. **`tool_calls` 必须配对**：每个 assistant `tool_calls` 都要有对应 tool 结果，`executeToolCall` 的每条路径（含权限拒绝、取消、超时、hook deny）都要回填；`runTurn` 开头的 `sanitizeHistory` 是兜底，不可删。
6. **权限**：变更类工具（write/edit/bash/MCP）执行前走 `session/request_permission`，只读工具和 `update_plan`/`use_skill`/`ask_user` 免权限；`fetch_url` 需权限、按源站记忆、只跟随同源重定向。所有工具参数先过 JSON Schema 校验，非法参数和截断响应里的工具调用不执行。"总是允许/拒绝"按 `Tool.permissionScope` 的范围记忆（bash 按命令前缀、文件按目录、`fetch_url` 按源站）；工作区外路径、高危命令、`fetch_url` 的内网/回环/云元数据目标强制弹窗（`forceAsk`：即便 auto 模式、即便只读工具也弹窗；高危命令与内网目标还忽略已记住的决策）。新增碰文件/跑命令的工具必须实现 `permissionScope`（复用 `tools/scope.ts`），并优先用客户端能力（`readTextFile`/`writeTextFile`/`createTerminal`），无能力时回退 Node。
7. **会话隔离**：工具集按会话组装（内置 + 技能 + MCP）；MCP server 失败只告警跳过，远程工具命名 `mcp__<server>__<tool>`。
8. **持久化**：`persistence.ts` 是唯一写入口，append-only JSONL，不要退回全量重写快照；`tool_started` 必须在 `tool.run` 之前落盘。来自客户端的 session ID 拼路径前必过 `/^[a-zA-Z0-9-]+$/`。
9. **超时与重试**：工具 deadline 必须 race 工具 promise（只 abort 不够），用户取消优先于超时；deadline 只从声明了 `timeoutFromArgs` 的工具参数推导（MCP 的 `timeout` 语义不可假定），其余走 `timeoutMs`/`toolTimeoutMs` 静态默认。LLM 只重试首个 delta 之前的瞬时失败（网络/408/409/429/5xx，尊重 `Retry-After`），SDK `maxRetries` 保持 0。
10. **Hooks**：`pre_tool_use` 在 `tool_call` 通知与权限弹窗之前运行，之后一律用改写后的参数（并重新校验）；`ask` 无条件弹窗（含 auto 模式与只读工具）；配置级 hook 命令路径以声明它的配置文件所在目录为基准，绝不用 session cwd；项目级 `.sangxia/hooks.json` 本身在会话建立时按 session cwd（项目根）查找，其内命令路径相对项目根；hook 失败不得影响 turn 收敛；全局配置是 base，`hooks.events.*` 追加合并，不要改成覆盖或去重；`hooks.enabled` 与 `projectFile.enabled` 默认关闭（打开仓库即执行任意命令 = 供应链风险），不要改成默认开启。
11. **ACP SDK**：同时支持 `configOptions` 与旧式 `models`；各模型/模式切换入口共用校验、持久化与 `config_option_update` 通知。升级 SDK 前验证新旧方法实际经过 stdio，勿改 `node_modules`。
12. **配置缺失**：ACP 进程仍完成握手，new/load/prompt 返回 `AUTH_REQUIRED`（-32000）并提示 `sangxia setup`；setup 只写全局配置、先验证后原子替换（0600）。
13. **TUI**：`sangxia tui` 接管进程生命周期，日志只进文件；键盘解析用自研 `tui/keys.ts`，不要换回 readline；每帧把真光标放回输入 caret（IME 依赖它）。
14. **新增 LLM 后端**：实现 `LLMProvider`，在 `llm/factory.ts` 注册，并扩展 `config.ts` 的 `provider.type`。

## 预留扩展点（勿破坏接口）

Anthropic 原生 provider、图片/音频输入、子代理、按会话回收 MCP 连接（尚未实现 `session/close`）、上下文压缩（`harness/context.ts` 已有估算，暂无溢出证据故未启用）。
