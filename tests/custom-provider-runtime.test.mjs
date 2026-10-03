import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import Credentials from '../plugins/credentials/index.mjs';
import * as Custom from '../plugins/custom/index.mjs';
import { keyRef } from '../plugins/custom/config.mjs';
import { loadModelDirectory } from '../packages/tui/src/models.ts';

test('real Harness registry, native credentials and model directory survive custom save, rename, resume and remove', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dscode-custom-runtime-'));
  const roots = [];
  const open = async () => {
    const ctx = new Context(); roots.push(ctx);
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]));
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(Credentials, { path: join(home, 'shared', 'credentials.yaml'), dshHome: home, watch: false });
    await ctx.plugin(Custom, { path: join(home, 'providers.yaml') });
    return ctx;
  };
  try {
    const ctx = await open(), service = Custom.getCustomProviders(ctx);
    const p = { ...service.newProfile(), name: 'Studio', baseURL: 'http://localhost:8000/v1', models: [{ id: 'qwen', contextWindow: 32768, maxTokens: 4096 }] };
    let snapshot = await service.save(p, 'synthetic-runtime-key', (await service.list()).revision);
    assert.equal((await ctx.credentials.resolve(keyRef(p.id))).value, 'synthetic-runtime-key');
    assert(!/synthetic-runtime-key/.test(await readFile(join(home, 'providers.yaml'), 'utf8')));
    let rows = (await loadModelDirectory(ctx)).rows;
    assert.equal(rows.find(r => r.provider === p.id).model, 'qwen');
    snapshot = await service.save({ ...p, name: 'Renamed Studio' }, '', snapshot.revision);
    rows = (await loadModelDirectory(ctx)).rows;
    assert.equal(rows.find(r => r.provider === p.id).providerName, 'Renamed Studio');
    const resumed = await open();
    assert.equal((await resumed.llm.resolveModelInfo(p.id, 'qwen')).context.contextWindow, 32768);
    assert.equal((await resumed.credentials.resolve(keyRef(p.id))).value, 'synthetic-runtime-key');
    const resumedService = Custom.getCustomProviders(resumed);
    resumedService.adapter.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"runtime ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    const chunks = [];
    for await (const chunk of resumed.llm.stream({ provider: p.id, model: 'qwen', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })) chunks.push(chunk);
    assert.equal(chunks.find(c => c.type === 'block-end').block.text, 'runtime ok');
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    await service.remove(p.id, snapshot.revision);
    assert(!ctx.llm.listProviders().some(r => r.id === p.id));
    assert.equal(await ctx.credentials.resolve(keyRef(p.id)), undefined);
  } finally { for (const ctx of roots) await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); }
});
