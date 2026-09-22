#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@zed-industries/agent-client-protocol";
import { SangxiaAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { VERSION } from "./version.js";

/**
 * Entry point: bridge stdio <-> ACP.
 *
 * stdout carries the JSON-RPC message stream and must stay clean — all logging
 * goes to stderr (see logger.ts).
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // `sangxia tui` — interactive terminal UI. It fully owns stdio/lifecycle, so
  // the ACP-mode signal handling below must NOT be registered (B6).
  if (argv[0] === "tui") {
    const { runTui } = await import("./tui/index.js");
    process.exitCode = await runTui(argv.slice(1));
    return;
  }

  if (argv[0] === "setup") {
    const { runSetup } = await import("./setup.js");
    process.exitCode = await runSetup(argv.slice(1));
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`Sangxia.ai ${VERSION}
Usage: sangxia [--config PATH] [--permission-mode confirm|auto]
       sangxia tui [options]
       sangxia setup [options]
       sangxia --version

Without a subcommand, runs the ACP agent over stdio.
Run sangxia setup --help for provider configuration options.
`);
    return;
  }

  let config = null;
  let configError: string | null = null;
  try {
    config = loadConfig(argv);
  } catch (e) {
    configError = e instanceof Error ? e.message : String(e);
    logger.warn(`配置加载失败，继续以未配置模式启动: ${configError}`);
    logger.info("凭据来源: 无（unconfigured）");
  }

  const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);

  // The connection begins reading immediately and drives the Agent handlers.
  let agent: SangxiaAgent | undefined;
  new AgentSideConnection((conn) => {
    agent = new SangxiaAgent(conn, config, configError);
    return agent;
  }, stream);

  logger.info(config
    ? `Sangxia ACP agent 就绪 · provider=${config.provider.type} · model=${config.provider.model}`
    : "Sangxia ACP agent 就绪 · unconfigured");

  // Stay alive until the client disconnects (stdin closes) or we're signaled.
  await new Promise<void>((resolve) => {
    process.stdin.once("end", () => resolve());
    process.stdin.once("close", () => resolve());
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  await agent?.shutdown();
  process.stdin.destroy();
  logger.info("连接关闭，退出。");
}

main().catch((e) => {
  logger.error("致命错误:", e);
  process.exitCode = 1;
});
