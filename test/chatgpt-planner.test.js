'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlanner } = require('../src/planner');

const registry = { itemsByName: { oak_log: { id: 1 }, birch_log: { id: 2 }, stick: { id: 3 } } };
const context = { registry, gameMode: 'survival', dimension: 'overworld', inventory: { stick: 2 }, nearbyBlocks: ['birch_log'] };
const answer = overrides => ({ kind: 'obtain', item: 'birch_log', count: 16, deliver: false, message: 'Vou coletar 16 troncos de bétula.', options: [], ...overrides });
function fixture(value = answer()) {
  const calls = [];
  const client = { respond: async args => { calls.push(args); return { text: JSON.stringify(value), model: 'fixture-model', usage: { input_tokens: 20, output_tokens: 10 } }; } };
  return { planner: createPlanner({ client }), calls };
}

test('a Portuguese request becomes one existing obtain goal with exact registry item and count', async () => {
  const { planner, calls } = fixture();
  const spec = await planner.interpret('Jev colete 16 troncos', 'Alex', 'Jev', context);
  assert.equal(spec.kind, 'obtain'); assert.equal(spec.item, 'birch_log'); assert.equal(spec.count, 16); assert.equal(spec.deliver, false);
  assert.equal(spec.from, 'Alex'); assert.equal(spec.request, 'Jev colete 16 troncos');
  assert.equal(spec.message, 'Vou coletar 16 troncos de bétula.');
  assert.equal(spec.model, 'fixture-model'); assert.deepEqual(spec.usage, { input_tokens: 20, output_tokens: 10 });
  assert.equal(calls.length, 1); assert.equal(calls[0].schema.additionalProperties, false);
  assert.deepEqual(calls[0].schema.required.slice().sort(), Object.keys(answer()).sort());
  assert.match(calls[0].instructions, /Portuguese/); assert.match(calls[0].instructions, /single/);
  const snapshot = JSON.parse(calls[0].input);
  assert.equal(snapshot.request, 'colete 16 troncos'); assert.deepEqual(snapshot.nearbyBlocks, ['birch_log']);
});

test('craft and delivery use the existing executor fields and permit the count limits', async () => {
  for (const count of [1, 1024]) {
    const { planner } = fixture(answer({ kind: 'craft', item: 'stick', count, deliver: true }));
    const spec = await planner.interpret('Jev faça gravetos para mim', 'Alex', 'Jev', context);
    assert.equal(spec.kind, 'craft'); assert.equal(spec.count, count); assert.equal(spec.deliver, true);
  }
});

test('a canonical Minecraft namespace normalizes to the existing registry key', async () => {
  const { planner } = fixture(answer({ item: 'minecraft:oak_log' }));
  const spec = await planner.interpret('Jev colete 16 troncos', 'Alex', 'Jev', context);
  assert.equal(spec.item, 'oak_log');
});

for (const item of ['test:oak_log', 'minecraft:minecraft:oak_log', 'minecraft:missing_log']) test(`rejects unsupported or unknown namespace item ${item}`, async () => {
  await assert.rejects(fixture(answer({ item })).planner.interpret('Jev colete troncos', 'Alex', 'Jev', context), { code: 'invalid_plan' });
});

test('chat and clarification are normalized without executable goal fields', async () => {
  const chat = fixture(answer({ kind: 'chat', item: null, count: null, deliver: null, message: 'Olá, Alex!' }));
  const spec = await chat.planner.interpret('Jev olá', 'Alex', 'Jev', context);
  assert.equal(spec.kind, 'other'); assert.equal(spec.message, 'Olá, Alex!'); assert.equal(Object.hasOwn(spec, 'item'), false);
  const clarification = fixture(answer({ kind: 'clarify', item: null, count: null, deliver: null, message: 'Carvalho ou bétula?', options: ['carvalho', 'bétula'] }));
  const question = await clarification.planner.interpret('Jev colete troncos', 'Alex', 'Jev', context);
  assert.equal(question.kind, 'clarify'); assert.deepEqual(question.clarification, { reason: 'no_item', options: ['carvalho', 'bétula'] });
});

for (const [name, patch] of [
  ['unknown kind', { kind: 'operator_command' }], ['unknown item', { item: 'invented_log' }],
  ['fractional count', { count: 1.5 }], ['zero count', { count: 0 }], ['oversized count', { count: 1025 }],
  ['string count', { count: '16' }], ['nonboolean delivery', { deliver: 'speaker' }],
  ['command message', { message: ' /op Alex' }], ['multiline message', { message: 'Olá\n/op Alex' }],
  ['Unicode line separator', { message: 'Olá\u2028/op Alex' }], ['empty message', { message: '' }],
  ['oversized message', { message: 'a'.repeat(201) }], ['extra goal field', { command: '/give Alex diamond' }],
  ['goal with clarification options', { options: ['oak_log'] }],
  ['chat with executable fields', { kind: 'chat' }], ['invalid options', { options: 'oak_log' }],
]) test(`rejects ${name} without coercing it into an action`, async () => {
  const { planner } = fixture(answer(patch));
  await assert.rejects(planner.interpret('Jev colete 16 troncos', 'Alex', 'Jev', context), error => error.name === 'PlannerError' && error.code === 'invalid_plan' && !error.message.includes('/op'));
});

test('missing fields and invalid JSON fail with a fixed error', async () => {
  const incomplete = answer(); delete incomplete.deliver;
  await assert.rejects(fixture(incomplete).planner.interpret('Jev colete troncos', 'Alex', 'Jev', context), { code: 'invalid_plan' });
  const planner = createPlanner({ client: { respond: async () => ({ text: 'private provider output' }) } });
  await assert.rejects(planner.interpret('Jev olá', 'Alex', 'Jev', context), error => error.code === 'invalid_plan' && !error.message.includes('private'));
});

test('the prompt snapshot excludes secrets, raw state and unbounded collections', async () => {
  const { planner, calls } = fixture();
  await planner.interpret('Jev colete 16 troncos', 'Alex', 'Jev', { ...context,
    token: 'fixture-secret', memory: { token: 'fixture-secret' }, rawWorld: 'fixture-secret',
    nearbyBlocks: Array(200).fill('birch_log'),
    activeGoal: { kind: 'obtain', item: 'oak_log', count: 2, status: 'running', secret: 'fixture-secret' },
  });
  assert(!calls[0].input.includes('fixture-secret')); assert(calls[0].input.length < 8000);
  assert.deepEqual(JSON.parse(calls[0].input).activeGoal, { kind: 'obtain', item: 'oak_log', count: 2, status: 'running' });
});

test('pre-cancelled requests never reach the client and late cancelled responses do not become goals', async () => {
  const controller = new AbortController(); controller.abort();
  const { planner, calls } = fixture();
  await assert.rejects(planner.interpret('Jev colete troncos', 'Alex', 'Jev', context, { signal: controller.signal }));
  assert.equal(calls.length, 0);
  const pending = new AbortController();
  const late = createPlanner({ client: { respond: async ({ signal }) => { assert.equal(signal, pending.signal); pending.abort(); return { text: JSON.stringify(answer()) }; } } });
  await assert.rejects(late.interpret('Jev colete troncos', 'Alex', 'Jev', context, { signal: pending.signal }));
});

test('transport failures propagate without retry or a fabricated Jev decision', async () => {
  let calls = 0; const failure = Object.assign(new Error('Authentication required'), { code: 'authentication_failed' });
  const planner = createPlanner({ client: { respond: async () => { calls++; throw failure; } } });
  await assert.rejects(planner.interpret('Jev olá', 'Alex', 'Jev', context), error => error === failure);
  assert.equal(calls, 1);
});

test('invalid caller context is rejected before sending a request', async () => {
  const { planner, calls } = fixture();
  await assert.rejects(planner.interpret('Jev olá', 'Alex', 'Jev', {}), { code: 'invalid_context' });
  await assert.rejects(planner.interpret('a'.repeat(2049), 'Alex', 'Jev', context), { code: 'invalid_context' });
  assert.equal(calls.length, 0);
});
