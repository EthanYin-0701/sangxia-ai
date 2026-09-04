#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@zed-industries/agent-client-protocol";
import { ZhenTeAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";

/**
 * Entry point: bridge stdio <-> ACP.
 *
 * stdout carries the JSON-RPC message stream and must stay clean — all logging
 * goes to stderr (see logger.ts).
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // `zhente tui` — interactive terminal UI. It fully owns stdio/lifecycle, so
  // the ACP-mode signal handling below must NOT be registered (B6).
  if (argv[0] === "tui") {
    const { runTui } = await import("./tui/index.js");
    process.exitCode = await runTui(argv.slice(1));
    return;
  }

  // TODO(acpreg): CLI 参数分发 —— 新增 `setup` / `--non-interactive` / `--api-key-env`
  //   / `--version` / `--help` 入口（见 plan/acpreg.md §3 阶段 1）；当前所有 argv 都被
  //   当作 ACP 正常启动忽略。
  // TODO(acpreg): loadConfig() 失败时应降级为 unconfigured 模式（仍完成 ACP 握手、
  //   声明 authMethods，但 prompt 返回 AUTH_REQUIRED），而不是直接崩溃（见 plan/acpreg.md §2.1）。
  const config = loadConfig(argv);

  const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);

  // The connection begins reading immediately and drives the Agent handlers.
  let agent: ZhenTeAgent | undefined;
  new AgentSideConnection((conn) => {
    agent = new ZhenTeAgent(conn, config);
    return agent;
  }, stream);

  logger.info(`ZhenTe ACP agent 就绪 · provider=${config.provider.type} · model=${config.provider.model}`);

  // Stay alive until the client disconnects (stdin closes) or we're signaled.
  await new Promise<void>((resolve) => {
    process.stdin.once("close", () => resolve());
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  await agent?.shutdown();
  logger.info("连接关闭，退出。");
}

main().catch((e) => {
  logger.error("致命错误:", e);
  process.exitCode = 1;
});
