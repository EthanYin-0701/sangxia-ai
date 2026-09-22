import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const entry = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
export const registryInitialize = {
  protocolVersion: 1,
  clientInfo: { name: "ACP Registry Validator" },
  clientCapabilities: {
    terminal: true, fs: { readTextFile: true, writeTextFile: true },
    _meta: { terminal_output: true, "terminal-auth": true },
  },
};

/** Raw JSON-RPC also verifies stdout contains only protocol messages. */
export function startAgent({ cwd, env, args = [] }) {
  const child = spawn(process.execPath, [entry, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "", nextId = 0, protocolError;
  const pending = new Map();
  child.stderr.on("data", chunk => { stderr += chunk; });
  const fail = error => {
    protocolError = error;
    for (const task of pending.values()) task.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  const exited = new Promise(resolve => child.once("exit", (code, signal) => {
    fail(new Error(`Agent exited (${code}, ${signal})`));
    resolve({ code, signal });
  }));
  createInterface({ input: child.stdout }).on("line", line => {
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined && ("result" in message || "error" in message)) {
        const task = pending.get(message.id);
        assert.ok(task, `Unexpected response id: ${message.id}`);
        pending.delete(message.id);
        task.resolve(message);
      }
    } catch (error) { fail(error); }
  });
  return {
    child,
    get stderr() { return stderr; },
    async request(method, params) {
      if (protocolError) throw protocolError;
      const id = ++nextId;
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 10_000);
          pending.set(id, { resolve, reject });
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
      } finally { clearTimeout(timer); pending.delete(id); }
    },
    async close() {
      if (protocolError && child.exitCode === null) throw protocolError;
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        const result = await exited;
        assert.deepEqual(result, { code: 0, signal: null });
      } finally { clearTimeout(timer); }
    },
  };
}
