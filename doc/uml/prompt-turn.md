# ZhenTe ACP Agent —— newSession 装配 + 一次 prompt 的处理流程

本图描述 **会话建立（`newSession` 装配工具集）** 与 **一次 prompt（`session/prompt` → `PromptResponse`）** 的完整时序，
**★ 高亮 Harness 负责的环节**，并含 **MCP 工具** 与 **技能(Skills)** 的接入与执行。

源码位置：`src/agent.ts`（ACP 接口 / 会话装配） → `src/harness/`（**★ Harness**） →
`src/llm/openai.ts`（模型流式） → `src/tools/*`（内置工具） → `src/mcp/client.ts`（MCP） → `src/skills/index.ts`（技能）。

> 同目录下的 `prompt-turn.puml` 是等价的 PlantUML 版本（用彩色泳道圈出各层，信息更细）。

## 什么是 Harness

`package.json` 对本项目的定义就是 “a Node.js coding AI agent speaking ACP, **with a tool harness**”。
Harness = 夹在 **ACP 协议接口层** 与 **可插拔的 LLM / 工具** 之间的**编排层**，
就是 `src/harness/` 这一个目录，四个文件：

| 文件 | 职责 |
|------|------|
| `harness/loop.ts` (`runTurn`) | 一次 prompt turn 的主循环：迭代控制、调模型、转发流事件、维护历史、调度工具、判定 stopReason |
| `harness/validation.ts` | 权限前统一校验工具 JSON object 与 JSON Schema |
| `harness/permissions.ts` (`ensurePermission`) | 工具执行前的权限门，含 “总是允许/拒绝” 的记忆 |
| `harness/tool.ts` (`ToolRegistry` / `Tool` / `ToolContext`) | 工具抽象：向模型通告 schema、按名解析、派发执行 |

**内置工具、MCP 工具、`use_skill` 都被包成统一的 `Tool`，走同一套调度 / 权限 / 回喂路径**——Harness 对它们一视同仁。

## 哪些环节是 Harness 在起作用

| 流程环节 | 归属层 | 是否 Harness |
|----------|--------|:---:|
| 会话查找、`promptToText` 展平、建 `AbortController`、最终把 `stopReason` 回给客户端 | ACP 接口层 `agent.ts` | ✗ |
| **newSession 装配**：发现技能 + 连接 MCP + 组装 `session.tools` | ACP 接口层 `agent.ts` | ✗ |
| **迭代循环控制**（`maxIterations`）、`cancelled` 判定 | `harness/loop.ts` | **★** |
| **调 `streamChat` 并把模型流事件转成 `sessionUpdate`**（正文/思考/工具分片） | `harness/loop.ts` | **★** |
| **stopReason 判定**：异常/过滤→`refusal`、截断→`max_tokens`、有效 stop→`end_turn`、超限→`max_turn_requests` | `harness/loop.ts` | **★** |
| **维护消息历史**（回填 assistant / tool 消息） | `harness/loop.ts` | **★** |
| **工具调度**：`tools.schemas()` 通告、`tools.get(name)` 解析、`run()` 派发、`truncate(100k)`（内置 / MCP / use_skill 统一） | `harness/loop.ts` + `harness/tool.ts` | **★** |
| **权限门**：`ensurePermission` + `session/request_permission` + 决定记忆（MCP 工具默认命中） | `harness/permissions.ts` | **★** |
| 实际 HTTP 流式请求、SSE 解析、tool_calls 分片聚合 | LLM Provider `llm/openai.ts` | ✗ |
| 具体工具动作（读写文件 / 跑命令 / glob / grep） | Tools `tools/*` | ✗ |
| MCP 工具执行体（`tools/call` 到外部 server） | `mcp/client.ts` + 外部 server | ✗ |
| 技能发现、`use_skill` 正文加载 | `skills/index.ts` | ✗ |
| 弹权限窗、editor 侧读写文件、展示增量输出 | 客户端 / 编辑器 | ✗ |

一句话：**黄色泳道里的 `runTurn` 和 权限门 发出的每个动作，都是 Harness。** MCP 与技能只是往它调度的
工具集里“多放了几把工具”——连接/发现是 `agent.ts` 的活，工具执行体在 `mcp/*` 与 `skills/*`，而**调度它们的是 Harness**。

## 时序图（★ = Harness）

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant Client as 编辑器/客户端<br/>ACP Client
    participant Agent as ZhenTeAgent<br/>agent.ts
    participant Session as Session<br/>历史/工具集/技能
    participant Loop as ★Harness·runTurn<br/>loop.ts
    participant Perm as ★Harness·权限门<br/>permissions.ts
    participant Skills as 技能<br/>skills/index.ts
    participant Mcp as MCP客户端<br/>mcp/client.ts
    participant McpSrv as 外部 MCP Server
    participant LLM as LLMProvider<br/>llm/openai.ts
    participant API as OpenRouter/OpenAI
    participant Tool as 内置工具<br/>tools/*

    Note over Loop,Perm: ★ Harness：循环控制 / 流事件转发 / 维护历史 / 工具调度 /<br/>权限门 / 截断 / stopReason。MCP 工具与 use_skill 都是统一的 Tool。

    rect rgb(237,231,246)
        Note over Agent,McpSrv: 会话建立 newSession（每会话一次，装配 session.tools）
        Client->>Agent: session/new(cwd, mcpServers)
        Agent->>Skills: discoverSkills(cwd, dirs)
        Skills-->>Agent: Skill[]{name,description,path}
        Agent->>Session: 存 session.skills；system prompt 追加技能清单
        loop 每个 mcpServer（失败隔离）
            Agent->>Mcp: connectMcpServer(server, timeout)
            Mcp->>McpSrv: transport + initialize + tools/list
            McpSrv-->>Mcp: tools[]
            Mcp-->>Agent: 包成 Tool[]（mcp__server__tool, 需权限）
        end
        Agent->>Session: session.tools = ToolRegistry(内置 + use_skill? + MCP)
        Agent-->>Client: { sessionId }
    end

    User->>Client: 输入 prompt
    Client->>Agent: session/prompt(sessionId, 内容块)
    Agent->>Session: 查会话 + push(user)；建 AbortController
    Agent->>Loop: runTurn(tools = session.tools) —— 交给 Harness

    loop 最多 maxIterations(=120) 轮 · Harness 循环控制
        Note over Loop: signal.aborted → return "cancelled"（Harness 判定）
        Loop->>LLM: streamChat(messages, tools.schemas, signal)
        Note over Loop: tools.schemas = 内置 + MCP(mcp__*) + use_skill（Harness 通告）
        LLM->>API: POST chat/completions（stream, tool_choice=auto）
        rect rgb(255,249,230)
            API-->>LLM: text-delta / reasoning-delta / tool_calls / done
            LLM-->>Loop: 聚合后的流事件
            Loop->>Client: sessionUpdate(message_chunk / thought_chunk)
        end
        alt 流式请求异常（如 404）
            Loop->>Client: sessionUpdate("[错误]…")
            Loop-->>Agent: return "refusal"（Harness 判定）
        end
        Loop->>Session: push(assistant 正文 + tool_calls)（Harness 维护历史）
        alt length / content_filter / 未知结束原因
            Loop->>Session: 所有工具补失败结果，不执行
            Loop->>Client: 截断或异常提示
            Loop-->>Agent: max_tokens / refusal
        else stop 且无正文、无工具
            Note over Loop: 通用提示补偿一次，仍为空则 refusal
        else stop 且有正文、没有 tool_calls
            Loop-->>Agent: return "end_turn"（Harness 判定）
        else 有 tool_calls —— Harness 逐个调度
            loop 遍历每个 tool call
                Loop->>Loop: parse args + tools.get(name) + JSON Schema 校验
                Note over Loop: 参数无效则补失败结果，跳过权限及执行
                Loop->>Client: sessionUpdate(tool_call, in_progress)
                opt needsPermission 且 permissionMode 非 auto（Harness 权限门）
                    Note over Loop,Perm: 写/改类内置工具 + 全部 MCP 工具命中；use_skill/只读跳过
                    Loop->>Perm: ensurePermission(tool)
                    Perm->>Client: session/request_permission
                    Client->>User: 弹窗询问
                    User-->>Client: 选择
                    Client-->>Perm: outcome
                    Perm-->>Loop: allow / reject（reject 回填错误并跳过）
                end
                alt 内置工具 tools/*
                    Loop->>Tool: run(args, ctx)
                    opt 文件类且客户端支持 fs
                        Tool->>Client: readTextFile / writeTextFile
                        Client-->>Tool: 内容 / 完成
                    end
                    Tool-->>Loop: ToolResult
                else use_skill（skills/index.ts）
                    Loop->>Skills: run({name}, ctx)
                    Skills-->>Loop: ToolResult{ SKILL.md 正文 }
                    Note over Skills: 正文回喂进上下文（渐进式披露）
                else MCP 工具 mcp__*（mcp/client.ts）
                    Loop->>Mcp: run(args, ctx)
                    Mcp->>McpSrv: tools/call(name, args)
                    McpSrv-->>Mcp: CallToolResult(content[])
                    Mcp-->>Loop: ToolResult{ 文本拼接, isError }
                end
                Loop->>Loop: truncate 至 100k（Harness）
                Loop->>Client: sessionUpdate(tool_call_update, completed/failed)
                Loop->>Session: push tool 结果（Harness 维护历史）
            end
            Note over Loop,Session: 回到循环顶部让模型继续（Harness）
        end
    end
    Note over Loop: 超过 maxIterations → return "max_turn_requests"（Harness 判定）

    Agent->>Agent: logger.info(prompt id 与 stopReason)
    Agent-->>Client: PromptResponse{ stopReason }
    Client->>User: 展示最终结果
    Note over Agent,McpSrv: 进程退出：agent.shutdown() → abort 全部活跃 turn → session.dispose() 关闭 MCP 连接
```

## 如何查看

- **Mermaid（本文件）**：JetBrains 打开 `.md` 点右上角预览即可渲染；GitHub 上也直接显示。
  名字带 `★Harness` 前缀的两条泳道即 Harness；`技能`(skills)、`MCP客户端`、`外部 MCP Server` 为新增能力层；
  `Note` 里标了 “（Harness …）” 的步骤是纯 Harness 逻辑。
- **PlantUML（`prompt-turn.puml`）**：用彩色 `box` 泳道把各层圈成分组，
  需 “PlantUML Integration” 插件（依赖 Graphviz），或粘贴到 <https://www.plantuml.com/plantuml> 在线渲染。
