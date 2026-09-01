# ZhenTe · 基于 Node.js 的 ACP Coding AI Agent

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
```

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
    "requestTimeoutMs": 120000,           // 模型请求超时（毫秒）
    "extraHeaders": {}                     // 可选附加请求头
  },
  "agent": {
    "maxIterations": 40,                   // 单轮最多迭代次数
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

### 兼容的端点

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
stdio (JSON-RPC / ACP)
        │
   AgentSideConnection            ← @zed-industries/agent-client-protocol
        │
   ZhenTeAgent (src/agent.ts)     ← initialize / newSession / prompt / cancel
        │                            newSession: 连接 MCP + 发现技能 → 组装本会话工具集
   harness/loop.ts  ──►  LLMProvider (llm/*)      OpenAI 兼容 / mock
        │            └─►  ToolRegistry(每会话)     内置(tools/*) + MCP(mcp/*) + use_skill(skills/*)
        │            └─►  permissions.ts           session/request_permission
   Session (src/session.ts)       ← 每会话历史 / cwd / 权限记忆 / 取消 / MCP 连接 / 技能
```

- **stdout 是协议通道**，所有日志走 stderr（`ZHENTE_LOG_FILE` 可另存文件，`ZHENTE_LOG_LEVEL` 调级别）。日志默认使用运行进程的本地时区，并在时间戳中包含 UTC 偏移量；如 ACP 宿主时区不正确，可设置 `ZHENTE_LOG_TIMEZONE=Asia/Shanghai`。
- Provider 是接口，新增后端（如 Anthropic 原生）只需实现 `LLMProvider` 再在 `llm/factory.ts` 注册。
- 会话工具集在 `newSession`/`loadSession` 组装：内置工具 + `use_skill`（若发现技能）+ 已连接的 MCP 工具（`src/agent.ts`）。
- 会话历史默认持久化到 `~/.config/zhente/sessions/<sessionId>.json`，可用 `ZHENTE_SESSION_DIR` 修改目录；支持 ACP `session/load` 恢复历史。
- 新会话会自动加载项目根目录的 `AGENTS.md` 和 `.zhente/memory.md`，用于保存跨 session 的项目约定与进度。
- 如果上述任一文件缺失，第一次正式 prompt 前会请求用户确认；确认后 agent 会先扫描项目并只补齐缺失的记忆文件，再执行原始任务。
- 一次 prompt 的完整时序见 [`doc/uml/prompt-turn.md`](doc/uml/prompt-turn.md)。

## 开发

```bash
npm run dev         # tsx 直跑 src/index.ts
npm run typecheck   # 仅类型检查
npm run build       # 编译到 dist/
```

## 目前未覆盖（预留扩展点）

- Anthropic 原生 provider（接口已就绪）。
- 图片/音频输入、多模式（`session/set_mode`）。
- MCP 连接的按会话回收（当前在进程退出时统一关闭；ACP 0.4.5 无会话结束事件）。
