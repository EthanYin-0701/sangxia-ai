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
  const config = loadConfig();

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
