// Exercise the actual stdio wire so SDK schema stripping cannot hide regressions.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const root = new URL('../dist/index.js', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'sangxia-model-config-'));
writeFileSync(join(dir, 'AGENTS.md'), '# Test project');
mkdirSync(join(dir, '.sangxia'));
writeFileSync(join(dir, '.sangxia/memory.md'), '# Memory');
const config = join(dir, 'config.json');
const models = [{ modelId: 'fast', name: 'Fast', description: 'Fast model' }, { modelId: 'pro', name: 'Pro' }];
function configure(list = models) {
  writeFileSync(config, JSON.stringify({ provider: { type: 'mock', model: 'fast', ...(list ? { models: list } : {}) }, agent: { permissionMode: 'auto' }, skills: { enabled: false } }));
}
function start() {
  const child = spawn(process.execPath, [root, '--config', config], { env: { ...process.env, HOME: join(dir, 'home'), SANGXIA_LOG_FILE: '', SANGXIA_LOG_DIR: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let id = 0;
  const pending = new Map();
  const updates = [];
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'session/update') updates.push(message.params);
    else if (message.id !== undefined) {
      const resolve = pending.get(message.id);
      assert.ok(resolve, `Unexpected response: ${line}`);
      pending.delete(message.id);
      resolve(message);
    }
  });
  return {
    updates,
    async request(method, params) {
      const requestId = ++id;
      const response = new Promise(resolve => pending.set(requestId, resolve));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
      const result = await response;
      return result;
    },
    async stop() { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; lines.close(); },
    kill() { child.kill('SIGKILL'); },
    stderr: () => stderr,
  };
}
let wire;
const deadline = setTimeout(() => { wire?.kill(); console.error('Model config smoke timeout'); process.exit(1); }, 20000);
const options = value => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: value, options: models.map(({modelId, ...rest}) => ({value: modelId, ...rest})) }];
async function initialize() {
  const response = await wire.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(response.result.protocolVersion, 1);
}
async function load(sessionId) {
  return wire.request('session/load', { sessionId, cwd: dir, mcpServers: [] });
}
try {
  configure(); wire = start(); await initialize();
  const session = (await wire.request('session/new', { cwd: dir, mcpServers: [] })).result;
  const sessionId = session.sessionId;
  assert.deepEqual(session.configOptions, options('fast'));
  assert.equal(session.models.currentModelId, 'fast');
  const switched = await wire.request('session/set_config_option', { sessionId, configId: 'model', value: 'pro' });
  assert.deepEqual(switched.result.configOptions, options('pro'));
  assert.deepEqual(wire.updates.at(-1), { sessionId, update: { sessionUpdate: 'config_option_update', configOptions: options('pro') } });
  // Mock providers are cached per model. Each fresh model must run its own tool script.
  for (const modelId of ['pro', 'fast']) {
    await wire.request('session/set_model', { sessionId, modelId });
    const before = wire.updates.length;
    const prompt = await wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'create hello.txt' }] });
    assert.equal(prompt.result.stopReason, 'end_turn');
    assert.equal(wire.updates.slice(before).filter(x => x.update.sessionUpdate === 'tool_call').length, 2, `Fresh provider for ${modelId}`);
  }
  await wire.request('_sangxia.set_model', { sessionId, modelId: 'pro' });
  assert.deepEqual(wire.updates.at(-1).update.configOptions, options('pro'));
  for (const params of [{ sessionId: 'missing', configId: 'model', value: 'fast' }, { sessionId, configId: 'unknown', value: 'fast' }, { sessionId, configId: 'model', value: 'missing' }]) {
    const before = wire.updates.length;
    assert.equal((await wire.request('session/set_config_option', params)).error.code, -32602);
    assert.equal(wire.updates.length, before);
  }
  assert.equal((await wire.request('session/set_model', { sessionId, modelId: 'missing' })).error.code, -32602);
  await wire.stop(); wire = start(); await initialize();
  const restored = (await load(sessionId)).result;
  assert.deepEqual(restored.configOptions, options('pro'));
  assert.equal(restored.models.currentModelId, 'pro');
  await wire.stop(); configure(null); wire = start(); await initialize();
  const fallback = (await load(sessionId)).result;
  assert.equal(fallback.configOptions[0].currentValue, 'fast');
  assert.deepEqual(fallback.configOptions[0].options, [{value: 'fast', name: 'fast'}]);
  assert.equal(fallback.models.currentModelId, 'fast');
  const single = (await wire.request('session/new', { cwd: dir, mcpServers: [] })).result;
  assert.deepEqual(single.configOptions, fallback.configOptions);
  console.error('MODEL CONFIG SMOKE OK');
} finally {
  clearTimeout(deadline);
  await wire?.stop();
  rmSync(dir, { recursive: true, force: true });
}
