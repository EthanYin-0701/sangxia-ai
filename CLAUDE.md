# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Sangxia (`sangxia-ai`) is a coding AI agent written in TypeScript that speaks the **Agent Client Protocol (ACP)** over stdio JSON-RPC, so editors like Zed can drive it as an external agent. It ships its own tool harness (stream → tool call → permission → execute → feed result back → converge) and talks to any OpenAI-compatible `/chat/completions` endpoint configured in JSON.

`INSTRUCTIONS.md` (user-facing docs) and `AGENTS.md` (project working rules, loaded into the agent's own system prompt) are in Chinese and are the authoritative detail; this file is the short orientation.

## Commands

```bash
npm run dev           # tsx src/index.ts (speaks ACP on stdio — not an interactive REPL)
npm run typecheck     # tsc --noEmit; run before every commit
npm run build         # compile to dist/
npm run smoke         # offline E2E: ACP handshake + tools + permission flow (mock provider)
npm run smoke:openai  # real OpenAIProvider streaming path against a fake local server
npm run smoke:mcp     # MCP client + skill layer
```

There is no unit-test framework. Tests are the three standalone `scripts/smoke-*.mjs` scripts, which act as ACP clients and spawn `dist/index.js` as a subprocess. To run one alone: `npm run build && node scripts/smoke.mjs` — they import from `dist/`, so a stale build silently tests old code.

Running the agent for real needs config: `cp sangxia.config.example.json sangxia.config.json` and `export OPENAI_API_KEY=...` (the file references it as `${OPENAI_API_KEY}`). The smoke tests need neither — they write their own `mock`-provider config to a temp dir.

## Architecture

```
stdio JSON-RPC ─ index.ts ─ SangxiaAgent (agent.ts) ─ runTurn (harness/loop.ts) ─┬─ LLMProvider (llm/*)
                                                                                ├─ ToolRegistry (tools/*, mcp/*, skills/*)
                                                                                └─ ensurePermission (harness/permissions.ts)
```

- **`agent.ts`** is the ACP surface (`initialize` / `newSession` / `loadSession` / `prompt` / `cancel` / `setSessionMode` / `setSessionModel`) and owns the `Session` map. It does no LLM work itself — it assembles a session and delegates the turn to `runTurn`.
- **`Session`** (`session.ts`) is all per-conversation state: message history, cwd, client capabilities, permission mode, selected model, remembered permission decisions, abort controller, MCP connections, discovered skills, and its own `ToolRegistry`.
- **Session tool set** is assembled per session in `prepareSession`: built-ins + `use_skill` (only if skills were found) + MCP tools from the servers the client passed in `session/new`. Built-ins, MCP tools and `use_skill` are all wrapped as the same `Tool` interface, so the harness dispatches, permission-gates and feeds them back identically.
- **`harness/`** is the whole orchestration layer, three files only: `loop.ts` (one prompt turn), `permissions.ts` (the gate, with "always allow/reject" memory), `tool.ts` (the `Tool` / `ToolContext` / `ToolRegistry` contracts). Full sequence diagram: `doc/uml/prompt-turn.md`.
- **LLM backends** go through the neutral `LLMProvider` / `ChatMessage` / `StreamEvent` types in `llm/types.ts`; nothing in the harness imports a concrete provider. Adding one = implement `LLMProvider`, register in `llm/factory.ts` (its `never` guard will flag you), and extend the `provider.type` enum in `config.ts`. Providers are cached per `modelId` in `agent.ts` so ACP `session/set_model` can switch models mid-session.
- **Client capability delegation**: `tools/fs-tools.ts` and `tools/bash.ts` prefer the client's `readTextFile` / `writeTextFile` / `createTerminal` (keeps the editor in sync) and fall back to Node `fs` / `child_process` when the client doesn't advertise them. Any new tool that touches files or runs commands must follow the same pattern.
- **Persistence**: every history mutation writes `~/.config/sangxia/sessions/<sessionId>.json` (override with `SANGXIA_SESSION_DIR`), which is what makes ACP `session/load` work.
- **Project memory**: `project-memory.ts` loads `AGENTS.md` and `.sangxia/memory.md` into the system prompt on every new/restored session. If either is missing, the first `prompt` asks the user via `session/request_permission` and then runs a preliminary initialization turn with a restricted tool set (`maybeInitializeProject` in `agent.ts`) before the user's actual task.
- **Config** (`config.ts`) is zod-validated with `${ENV_VAR}` interpolation, resolved `--config` → `$SANGXIA_CONFIG` → `./sangxia.config.json` → `~/.config/sangxia/config.json`. Permission mode precedence is CLI `--permission-mode` > `SANGXIA_PERMISSION_MODE` > config file; legacy `agent.autoApprove: true` normalizes to `"auto"`.

## Invariants that break things quietly

1. **stdout is the protocol channel.** Never `console.log`. All diagnostics go through `logger` (stderr, plus optional `SANGXIA_LOG_FILE` single file or `SANGXIA_LOG_DIR` per-session files). A stray stdout write corrupts the JSON-RPC stream.
2. **`tool_calls` must always be answered.** OpenAI-compatible endpoints 400 if an assistant message's `tool_calls` lack matching `tool` messages. Three things maintain this and none are optional: `sanitizeHistory()` at the top of `runTurn` (last-resort repair after a crash/kill), `pushToolResult` being reachable on *every* path through `executeToolCall` (including permission errors and aborts), and `safeSessionUpdate` instead of raw `conn.sessionUpdate` so a broken connection can't skip the result.
3. **Session IDs reach the filesystem.** `loadSession` IDs come from the client, so both `persistence.ts` and `logger.ts` whitelist `/^[a-zA-Z0-9-]+$/` before building a path. Keep that check on any new ID-derived path.
4. **Wrap new ACP handlers in `logger.withSession(id, ...)`** — session-scoped logging uses `AsyncLocalStorage`, and an unwrapped handler's logs fall into `global.log`.
5. **ESM + `NodeNext`**: relative imports need the `.js` extension. `strict` and `noUncheckedIndexedAccess` are on, hence the `!` assertions in existing indexed access.
6. `sangxia.config.json` (real secrets) and `dist/` are gitignored — don't commit or hand-edit them.
7. MCP failures are isolated per server (warn and skip, never sink the session); remote tools are exposed as `mcp__<server>__<tool>` and default to `needsPermission: true`. ACP 0.4.5 has no session-end event, so connections close only at process exit (`SangxiaAgent.shutdown`).

## Conventions

- Read before editing (`read_file`/`grep`/`glob`), then make minimal precise edits; the project's own agent rules in `AGENTS.md` apply to work done here too.
- After architectural changes, decisions, or leftover work, update `.sangxia/memory.md` (cross-session memory) and `AGENTS.md` (rules/layout) — this project treats those files as part of the deliverable, not documentation debt.
- `TODO(acpreg)` markers in `index.ts`, `agent.ts` and `config.ts` mark planned ACP-registry auth work; design docs live in the untracked `plan/` directory (`acpreg.md`, `subAgentPlan-*.md`). Reserved-but-unimplemented extension points: native Anthropic provider, image/audio prompts, sub-agents, per-session MCP teardown.
- Code comments and doc prose are Chinese in docs and mostly English in `src/`; user-facing strings (tool descriptions, permission options, system prompt) are Chinese.
