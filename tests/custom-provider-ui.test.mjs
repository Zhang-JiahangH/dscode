import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomProviderPanel, clearReportedLimits } from '../packages/tui/src/custom-provider-panel.ts';
import { DscodeProviderPanel } from '../packages/tui/src/app.ts';
import { mount, assertFits } from './fixtures/tui-mount.mjs';

const p = { id: 'custom-ui', name: 'Studio', baseURL: 'http://studio:8000/v1', api: 'chat-completions', auth: 'bearer', backend: 'omlx', timeoutMs: 180000, models: [{ id: 'qwen', contextWindow: 32768, maxTokens: 4096, contextSource: 'server', thinking: 'default' }] };
const fake = extra => ({ list: async () => ({ providers: [structuredClone(p)], revision: 'v1' }), newProfile: () => ({ ...p, models: [] }), ...extra });
const down = async (ui, n) => { for (let i = 0; i < n; i++) await ui.write('\x1b[B'); };

test('changing endpoint or model drops old server facts while retaining explicit overrides', () => {
  assert.equal(clearReportedLimits(p.models[0]).contextWindow, undefined);
  assert.equal(clearReportedLimits({ ...p.models[0], contextSource: 'user' }).contextWindow, 32768);
  assert.equal(clearReportedLimits({ ...p.models[0], outputSource: 'server' }).maxTokens, undefined);
});

test('/provider has a Custom entry and focuses it for a custom session', async () => {
  const choices = [];
  const ui = await mount(DscodeProviderPanel, { current: 'custom-ui', load: async () => ({ rows: [] }), choose: p => choices.push(p), back() {} });
  try { assert.match(ui.frame(), /› Custom/); await ui.write('\r'); assert.deepEqual(choices, ['custom']); }
  finally { ui.close(); }
});

test('/provider lists saved services as switch targets separately from Custom setup', async () => {
  const choices = [];
  const ui = await mount(DscodeProviderPanel, {
    current: 'deepseek-official', load: async () => ({ rows: [] }), loadCustom: fake({}).list,
    choose: id => choices.push(id), back() {},
  });
  try {
    assert.match(ui.frame(), /Studio · 1 model\(s\)/);
    assert.match(ui.frame(), /Custom · add \/ edit/);
    await ui.write('\x1b[A'); await ui.write('\x1b[A'); await ui.write('\r');
    assert.deepEqual(choices, ['custom-ui']);
    await down(ui, 1); await ui.write('\r');
    assert.deepEqual(choices, ['custom-ui', 'custom']);
    assertFits(ui);
  } finally { ui.close(); }
});

test('/provider focuses the actual saved custom service when reopening', async () => {
  const choices = [];
  const ui = await mount(DscodeProviderPanel, {
    current: 'custom-second', load: async () => ({ rows: [] }),
    loadCustom: async () => ({ providers: [p, { ...p, id: 'custom-second', name: 'Second Studio' }], revision: 'v1' }),
    choose: id => choices.push(id), back() {},
  });
  try {
    assert.match(ui.frame(), /› ● Second Studio/);
    await ui.write('\r'); assert.deepEqual(choices, ['custom-second']);
  } finally { ui.close(); }
});

test('custom editor masks pasted keys, accepts q in fields, preserves metadata and saves before switching', async () => {
  const saves = [], choices = [];
  const ui = await mount(CustomProviderPanel, { initialId: p.id, client: fake({ save: async (...args) => { saves.push(args); return { providers: [args[0]], revision: 'v2' }; } }), select: (...args) => choices.push(args), back() {} }, { columns: 60, rows: 26 });
  try {
    await ui.write('\r'); await ui.write('\x15'); await ui.write('q Studio'); await ui.write('\r');
    assert.match(ui.frame(), /q Studio/);
    await down(ui, 4); await ui.write('\r'); await ui.write('synthetic-secret-q');
    assert(!ui.frame().includes('synthetic-secret-q')); await ui.write('\r');
    await down(ui, 3); await ui.write('\r');
    assert.match(ui.frame(), /Context \(server\)/);
    await down(ui, 1); await ui.write('\r'); await ui.write('\x15'); await ui.write('65536'); await ui.write('\r');
    assert.match(ui.frame(), /Context \(user\): 65536/);
    await down(ui, 4); await ui.write('\r');
    assert.equal(saves.length, 1);
    assert.equal(saves[0][0].models[0].contextWindow, 65536);
    assert.equal(saves[0][1], 'synthetic-secret-q');
    assert.equal(saves[0][2], 'v1');
    assert.deepEqual(choices, [['custom-ui', 'qwen']]);
    assertFits(ui);
  } finally { ui.close(); }
});

test('discovery cancellation aborts the pending HTTP operation and does not save', async () => {
  let signal, saves = 0;
  const ui = await mount(CustomProviderPanel, { initialId: p.id, client: fake({ save: async () => { saves++; }, discover: async (_profile, _key, s) => {
    signal = s; return new Promise((_resolve, reject) => s.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
  } }), select() {}, back() {} });
  try { await down(ui, 6); await ui.write('\r'); assert.match(ui.frame(), /Working/); await ui.write('\x1b'); assert.equal(signal.aborted, true); assert.equal(saves, 0); }
  finally { ui.close(); }
});

test('bracketed URL and key pastes strip terminal markers and do not submit newline chunks', async () => {
  const saves = [];
  const ui = await mount(CustomProviderPanel, { initialId: p.id, client: fake({ save: async (...args) => { saves.push(args); return { providers: [args[0]], revision: 'v2' }; } }), select() {}, back() { assert.fail('paste must not exit'); } });
  try {
    await down(ui, 1); await ui.write('\r'); await ui.write('\x15');
    await ui.write('\x1b[200~http://new-studio:8000/v1\r\n\x1b[201~');
    assert.match(ui.frame(), /Enter apply/);
    assert.doesNotMatch(ui.frame(), /20[01]~/);
    await ui.write('\r');
    await down(ui, 3); await ui.write('\r');
    await ui.write('[200~'); await ui.write('synthetic-'); await ui.write('\r');
    assert.match(ui.frame(), /Enter apply/);
    await ui.write('secret'); await ui.write('[201~');
    assert(!ui.frame().includes('synthetic-'));
    await ui.write('\r'); await down(ui, 5); await ui.write('\r');
    assert.equal(saves.length, 1);
    assert.equal(saves[0][0].baseURL, 'http://new-studio:8000/v1');
    assert.equal(saves[0][1], 'synthetic-secret');
  } finally { ui.close(); }
});

test('Esc cancels the protocol picker without leaving the provider or changing its format', async () => {
  const saves = [];
  const ui = await mount(CustomProviderPanel, { initialId: p.id, client: fake({ save: async (...args) => { saves.push(args); return { providers: [args[0]], revision: 'v2' }; } }), select() {}, back() { assert.fail('picker must not exit'); } });
  try {
    await down(ui, 2); await ui.write('\r'); await down(ui, 1);
    assert.match(ui.frame(), /API format: responses/);
    await ui.write('\x1b');
    assert.match(ui.frame(), /API format: chat-completions/);
    assert.match(ui.frame(), /Base URL/);
    await ui.write('\r'); await down(ui, 2); await ui.write('\r');
    assert.match(ui.frame(), /API format: anthropic/);
    assert.match(ui.frame(), /Authentication: x-api-key/);
    await down(ui, 7); await ui.write('\r');
    assert.equal(saves.length, 1);
    assert.equal(saves[0][0].api, 'anthropic');
    assert.equal(saves[0][0].auth, 'x-api-key');
    assertFits(ui);
  } finally { ui.close(); }
});
