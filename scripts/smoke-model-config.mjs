// Exercise the actual stdio wire so SDK schema stripping cannot hide regressions.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
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
function configure(list = models, permissionMode = 'auto') {
  writeFileSync(config, JSON.stringify({ provider: { type: 'mock', model: 'fast', ...(list ? { models: list } : {}) }, agent: { permissionMode }, skills: { enabled: false } }));
}
function start() {
  const child = spawn(process.execPath, [root, '--config', config], { env: { ...process.env, HOME: join(dir, 'home'), SANGXIA_LOG_FILE: '', SANGXIA_LOG_DIR: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let id = 0;
  const pending = new Map();
  const updates = [];
  const permissions = [];
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'session/request_permission') {
      permissions.push(message.params);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: 'allow_always' } } }) + '\n');
    } else if (message.method === 'session/update') updates.push(message.params);
    else if (message.id !== undefined) {
      const resolve = pending.get(message.id);
      assert.ok(resolve, `Unexpected response: ${line}`);
      pending.delete(message.id);
      resolve(message);
    }
  });
  return {
    updates,
    permissions,
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
const modeOption = value => ({ id: 'mode', name: 'Access and mode', category: 'mode', type: 'select', currentValue: value, options: [{ value: 'confirm', name: 'Standard Access', description: '变更操作执行前请求确认' }, { value: 'auto', name: 'Full Access', description: '自动批准常规变更；Hook 强制确认仍生效' }] });
const options = (value, mode = 'auto') => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: value, options: models.map(({modelId, ...rest}) => ({value: modelId, ...rest})) }, modeOption(mode)];
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
  for (const mode of ['confirm', 'auto']) {
    const before = wire.updates.length;
    const changed = await wire.request('session/set_config_option', { sessionId, configId: 'mode', value: mode });
    assert.deepEqual(changed.result.configOptions, options('pro', mode));
    assert.deepEqual(wire.updates.slice(before), [
      { sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: mode } },
      { sessionId, update: { sessionUpdate: 'config_option_update', configOptions: options('pro', mode) } },
    ]);
  }
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
  for (const params of [{ sessionId: 'missing', configId: 'model', value: 'fast' }, { sessionId, configId: 'unknown', value: 'fast' }, { sessionId, configId: 'model', value: 'missing' }, { sessionId, configId: 'mode', value: 'missing' }, { sessionId: 'missing', configId: 'mode', value: 'auto' }]) {
    const before = wire.updates.length;
    assert.equal((await wire.request('session/set_config_option', params)).error.code, -32602);
    assert.equal(wire.updates.length, before);
  }
  assert.equal((await wire.request('session/set_model', { sessionId, modelId: 'missing' })).error.code, -32602);
  await wire.request('session/set_mode', { sessionId, modeId: 'confirm' });
  assert.deepEqual(wire.updates.at(-1).update.configOptions, options('pro', 'confirm'));
  await wire.stop(); wire = start(); await initialize();
  const restored = (await load(sessionId)).result;
  assert.deepEqual(restored.configOptions, options('pro', 'confirm'));
  assert.equal(restored.models.currentModelId, 'pro');
  await wire.stop(); configure(null); wire = start(); await initialize();
  const fallback = (await load(sessionId)).result;
  assert.equal(fallback.configOptions[0].currentValue, 'fast');
  assert.deepEqual(fallback.configOptions[0].options, [{value: 'fast', name: 'fast'}]);
  assert.equal(fallback.models.currentModelId, 'fast');
  const single = (await wire.request('session/new', { cwd: dir, mcpServers: [] })).result;
  assert.deepEqual(single.configOptions, [fallback.configOptions[0], modeOption('auto')]);
  assert.deepEqual(fallback.configOptions[1], modeOption('confirm'));
  assert.equal(restored.modes.currentModeId, 'confirm');
  // Real permission behavior: invalid modes preserve memory; valid switches clear it.
  await wire.stop();
  const permissionModels = ['fast', 'pro', 'third', 'fourth'].map(modelId => ({ modelId, name: modelId }));
  configure(permissionModels, 'confirm'); wire = start(); await initialize();
  const permissionSession = (await wire.request('session/new', { cwd: dir, mcpServers: [] })).result;
  assert.deepEqual(permissionSession.configOptions[1], modeOption('confirm'));
  const pid = permissionSession.sessionId;
  const prompt = async () => {
    const response = await wire.request('session/prompt', { sessionId: pid, prompt: [{ type: 'text', text: 'create hello.txt' }] });
    assert.equal(response.result.stopReason, 'end_turn');
    assert.equal(readFileSync(join(dir, 'hello.txt'), 'utf8'), 'hello from sangxia\n');
  };
  await prompt();
  assert.equal(wire.permissions.length, 1, 'confirm asks for write; read stays permission-free');
  const savedPath = join(dir, 'home', '.config', 'sangxia', 'sessions', `${pid}.jsonl`);
  const savedBefore = readFileSync(savedPath, 'utf8');
  const updatesBefore = wire.updates.length;
  for (const method of ['session/set_config_option', 'session/set_mode']) {
    const response = await wire.request(method, { sessionId: pid, configId: 'mode', value: 'bad', modeId: 'bad' });
    assert.equal(response.error.code, -32602);
  }
  assert.equal(wire.updates.length, updatesBefore);
  assert.equal(readFileSync(savedPath, 'utf8'), savedBefore, 'invalid modes must not persist');
  await wire.request('session/set_model', { sessionId: pid, modelId: 'pro' });
  assert.equal(wire.updates.at(-1).update.configOptions[1].currentValue, 'confirm');
  await prompt();
  assert.equal(wire.permissions.length, 1, 'invalid mode preserves allow_always memory');
  await wire.request('session/set_config_option', { sessionId: pid, configId: 'mode', value: 'confirm' });
  await wire.request('session/set_model', { sessionId: pid, modelId: 'third' });
  await prompt();
  assert.equal(wire.permissions.length, 2, 'successful mode switch clears remembered approval');
  await wire.request('session/set_config_option', { sessionId: pid, configId: 'mode', value: 'auto' });
  await wire.request('_sangxia.set_model', { sessionId: pid, modelId: 'fourth' });
  assert.equal(wire.updates.at(-1).update.configOptions[1].currentValue, 'auto');
  await prompt();
  assert.equal(wire.permissions.length, 2, 'auto executes ordinary writes without permission');
  await wire.stop(); wire = start(); await initialize();
  const restoredAuto = (await load(pid)).result;
  assert.equal(restoredAuto.modes.currentModeId, 'auto', 'saved auto overrides default confirm');
  assert.equal(restoredAuto.configOptions[1].currentValue, 'auto');
  assert.equal(restoredAuto.configOptions[0].currentValue, 'fourth');
  console.error('MODEL CONFIG SMOKE OK');
} finally {
  clearTimeout(deadline);
  await wire?.stop();
  rmSync(dir, { recursive: true, force: true });
}
