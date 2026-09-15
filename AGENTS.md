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
npm run smoke:skill   # 技能层冒烟（skills.dirs 发现 + 目录注入 + use_skill 加载/未知名称报错）
npm run smoke:tui     # TUI 层 headless 冒烟（命令/主题/输入/通知映射/内存配对/取消）
npm run smoke:reliability # 截断/空响应/参数校验/流式超时/取消与断连回归
```

## 目录约定

```
src/
  acp/         ACP 侧内容处理（content.ts）
  agent.ts     主 Agent：initialize / newSession / prompt / cancel；组装会话工具集
  config.ts    配置加载（--config → $ZHENTE_CONFIG → ./zhente.config.json → ~/.config/zhente/config.json，支持 ${ENV} 插值）
  harness/     主循环 loop.ts、权限 permissions.ts、工具抽象 tool.ts、统一参数校验 validation.ts
  llm/         LLMProvider 接口（types.ts）+ OpenAI（openai.ts）/ mock（mock.ts）+ factory.ts
  mcp/         MCP client（client.ts）
  skills/      技能发现与 use_skill（index.ts）
  tools/       内置工具：fs-tools.ts（read/write/edit/list/glob/grep）、bash.ts、plan.ts
  tui/         终端 UI（`zhente tui`）：index.ts 主循环 / bridge.ts 进程内 ACP 配对
               / ui.ts 备用屏渲染 / keys.ts raw 键盘解析 / input.ts 行编辑
               / model.ts ACP 通知→聊天条目映射 / commands.ts 斜杠命令
               / theme.ts 红绿白主题 / wcwidth.ts 最小 CJK 宽度（零依赖）
  index.ts     入口（stdio JSON-RPC；argv[0]==="tui" 时转 TUI 分支）
  logger.ts    日志（stdout 是协议通道，日志一律走 stderr；可选 ZHENTE_LOG_FILE 单文件或 ZHENTE_LOG_DIR 按 session 分文件；logger.configure 支持运行时改 stderr/level/dir，TUI 用它把日志只进文件）
  persistence.ts  会话历史持久化（~/.config/zhente/sessions/）
  project-memory.ts  AGENTS.md / .zhente/memory.md 的发现与加载
doc/uml/       时序图（prompt-turn）
scripts/       冒烟测试脚本（*.mjs）
.claude/skills/ 本地安装的第三方技能（Claude Code 布局；analyze 来自 jet-desk，见 .zhente/memory.md）
```

## 技能（Skills）

- 发现目录：配置 `skills.dirs`（相对路径按 session cwd 解析）优先；未配置时回退 `<cwd>/skills` + `~/.config/zhente/skills`。同名先到先得（项目技能盖过全局）。
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
6. **记忆维护**：跨 session 的项目背景、重要决策、待办事项写入 `.zhente/memory.md`（每次 session 自动加载）；涉及架构/决策/未完成事项时，任务完成后更新。
7. **新增 LLM 后端**：实现 `LLMProvider` 接口，在 `llm/factory.ts` 注册即可。
8. **权限模型**：变更类工具（write/edit/bash/MCP 工具）执行前走 `session/request_permission`；读类工具免权限；`update_plan`/`use_skill` 免权限。
   所有工具先过 JSON object / JSON Schema 校验；非法参数不得进入权限确认，截断响应中的工具调用一律拒绝执行，并补齐失败 tool result。
9. **会话隔离**：工具集按会话组装（内置 + 技能 + MCP）；MCP server 连接失败只告警跳过，不影响其他工具。
10. **TUI 纪律**：`zhente tui` 分支完全接管进程生命周期（stdio/TTY/信号），不注册 ACP 模式的 SIGINT 逻辑；TUI 下日志必须 `logger.configure({ stderr:false, dir })` 只进文件，严禁把日志写进备用屏。输入层是自研 raw 键盘解析（keys.ts），不要换回 readline——`rl.pause()` 无法隔离 raw 弹窗（按键会漏进行输入行，spike 已验证）。
11. **SDK 陷阱**：`@zed-industries/agent-client-protocol@0.4.5` 的 `ClientSideConnection.setSessionModel` 会错发 `session/set_mode`；绕行 `extMethod("zhente.set_model")`（agent.ts 已登记，转发到标准 setSessionModel）。不要"修" SDK 里那两处辅助方法（node_modules 是产物）。

## 已知扩展点（勿破坏预留接口）

- Anthropic 原生 provider（接口已就绪，未实现）。
- 图片/音频输入、多模式（`session/set_mode`）。
- MCP 连接按会话回收（当前进程退出时统一关闭，受 ACP 0.4.5 无会话结束事件限制）。
- TUI v2：`/resume`（session/load 续持久化会话）、权限弹窗内实时 bash 输出（客户端 createTerminal，terminal:true）、多行输入。
