# AGENTS.md — ZhenTe 项目工作规则

## 项目简介

ZhenTe（eye-zhen-te）是一个基于 Node.js/TypeScript 的 ACP（Agent Client Protocol）编程 AI agent：通过 stdio 上的 JSON-RPC 与 Zed 等 ACP 客户端通信，自带完整工具 harness（流式输出 → 工具调用 → 权限确认 → 执行 → 回喂 → 收敛），LLM 后端走任意 OpenAI 兼容 `/chat/completions` 端点，可通过 ACP `session/new` 接入 MCP servers，并支持本地技能（Skills）渐进式加载。

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
```

## 目录约定

```
src/
  acp/         ACP 侧内容处理（content.ts）
  agent.ts     主 Agent：initialize / newSession / prompt / cancel；组装会话工具集
  config.ts    配置加载（--config → $ZHENTE_CONFIG → ./zhente.config.json → ~/.config/zhente/config.json，支持 ${ENV} 插值）
  harness/     主循环 loop.ts、权限 permissions.ts、工具抽象 tool.ts
  llm/         LLMProvider 接口（types.ts）+ OpenAI（openai.ts）/ mock（mock.ts）+ factory.ts
  mcp/         MCP client（client.ts）
  skills/      技能发现与 use_skill（index.ts）
  tools/       内置工具：fs-tools.ts（read/write/edit/list/glob/grep）、bash.ts、plan.ts
  index.ts     入口（stdio JSON-RPC）
  logger.ts    日志（stdout 是协议通道，日志一律走 stderr；可选 ZHENTE_LOG_FILE 单文件或 ZHENTE_LOG_DIR 按 session 分文件）
  persistence.ts  会话历史持久化（~/.config/zhente/sessions/）
  project-memory.ts  AGENTS.md / .zhente/memory.md 的发现与加载
doc/uml/       时序图（prompt-turn）
scripts/       冒烟测试脚本（*.mjs）
```

## 工作规则

1. **先读后改**：不臆测文件内容，先用 `read_file`/`list_dir`/`glob`/`grep` 确认；修改用 `edit_file` 做最小化精确改动。
2. **运行命令**：构建/测试/git 等一律通过 `bash` 执行；提交前必须过 `npm run typecheck`（可再跑 `npm run build`）。
3. **日志纪律**：stdout 是 ACP 协议通道，任何调试/日志输出必须走 stderr 或 `ZHENTE_LOG_FILE`/`ZHENTE_LOG_DIR`，严禁污染 stdout。日志时间戳含本地时区 UTC 偏移；宿主时区不对时用 `ZHENTE_LOG_TIMEZONE` 修正。`ZHENTE_LOG_DIR` 按 session 分文件（`<sessionId>.log` + `global.log`），session 归属用 `AsyncLocalStorage` 实现（`logger.withSession`，见 agent.ts 的 newSession/loadSession/prompt/cancel 包裹），多 session 并发也不串文件。
4. **配置与密钥**：`zhente.config.json` 已被 gitignore，不要提交；密钥用 `${ENV_VAR}` 引用，避免落盘。
5. **产物与生成文件**：`dist/`、`node_modules/` 为构建产物，不手改、不提交。
6. **记忆维护**：跨 session 的项目背景、重要决策、待办事项写入 `.zhente/memory.md`（每次 session 自动加载）；涉及架构/决策/未完成事项时，任务完成后更新。
7. **新增 LLM 后端**：实现 `LLMProvider` 接口，在 `llm/factory.ts` 注册即可。
8. **权限模型**：变更类工具（write/edit/bash/MCP 工具）执行前走 `session/request_permission`；读类工具免权限；`update_plan`/`use_skill` 免权限。
9. **会话隔离**：工具集按会话组装（内置 + 技能 + MCP）；MCP server 连接失败只告警跳过，不影响其他工具。

## 已知扩展点（勿破坏预留接口）

- Anthropic 原生 provider（接口已就绪，未实现）。
- 图片/音频输入、多模式（`session/set_mode`）。
- MCP 连接按会话回收（当前进程退出时统一关闭，受 ACP 0.4.5 无会话结束事件限制）。
