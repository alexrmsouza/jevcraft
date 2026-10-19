'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const intention = require('../src/intention');
const { designProgress } = require('../src/designer');

function bot(mode = 'full', language = 'pt-BR') {
  const said = [];
  return { said, _jevNarration: mode, _jevLanguage: language, health: 20, food: 20,
    game: { dimension: 'the_nether' }, entity: { position: new Vec3(0, 70, 0) },
    inventory: { items: () => [] }, blockAt: () => null, chat: line => said.push(line) };
}

test('intention notices use the selected language and retain the committed goal', () => {
  const actor = bot(), goal = { kind: 'craft', item: 'diamond_pickaxe' };
  const selected = intention.after(actor, goal, 'fortress_visit', ['go_in'], { target: { x: 40, y: 70, z: 0 } });
  assert.equal(goal.intention, selected);
  assert.match(actor.said[0], /Vou entrar na fortaleza/);
  assert.match(actor.said[0], /40, 70, 0/);
});

test('intention progress is silent in off and important modes without affecting execution state', () => {
  for (const mode of ['off', 'important']) {
    const actor = bot(mode), goal = { kind: 'craft' };
    intention.after(actor, goal, 'fortress_visit', ['go_in']);
    assert.equal(goal.intention.choice, 'go_in');
    assert.deepEqual(actor.said, []);
  }
});

test('streamed design notices are localized and verbosity does not alter design processing', () => {
  for (const mode of ['off', 'important', 'full']) {
    const actor = bot(mode), report = designProgress(line => actor.chat(line), false, actor);
    report('{"name":"Castle","size":[10,12,8],"regions":[]}');
    if (mode === 'full') {
      assert(actor.said.some(line => /Vou chamar de Castle/.test(line)));
      assert(actor.said.some(line => /10 por 8.*12 de altura/.test(line)));
    } else assert.deepEqual(actor.said, []);
  }
});

test('intention sub-needs translate their notice and keep the original intention', () => {
  for (const mode of ['full', 'important', 'off']) {
    const actor = bot(mode), goal = { kind: 'craft' };
    const held = intention.after(actor, goal, 'fortress_visit', ['go_in'], { now: 1000 });
    actor.said.length = 0;
    const current = intention.after(actor, goal, 'nether_gather', ['portal_trip'], { now: 2000 });
    assert.equal(current, held);
    assert.equal(goal.intention.choice, 'go_in');
    assert.equal(goal.intention.way, 'nether_gather/portal_trip');
    if (mode === 'full') {
      assert.match(actor.said[0], /portal.*madeira/i);
      assert.match(actor.said[0], /parte da tarefa/);
      assert.doesNotMatch(actor.said[0], /nether gather|portal trip|back to it after/);
    } else assert.deepEqual(actor.said, []);
  }
});

test('intention translates requirements, carried supplies and ready-to-return reasons', () => {
  const actor = bot();
  assert.match(intention.startSays(actor, {}, { q: 'fortress_visit', choice: 'heal_first' }), /vida 20/);
  assert.match(intention.startSays(actor, {}, { q: 'fortress_leg', choice: 'return_for_blocks' }), /picareta.*blocos.*madeira/);
  assert.match(intention.startSays(actor, {}, { q: 'nether_gather', choice: 'walk_to_1' }, { for: 'diamond_pickaxe' }), /picareta de diamante/i);
  const ready = intention.startSays(actor, {}, { q: 'leave_nether', choice: 'go_back', target: { x: 1, y: 2, z: 3 } }, { ready: true });
  assert.match(ready, /varas.*1, 2, 3.*objetivo/);
  assert.doesNotMatch(ready, /carried|goal has|hunger|health/);
});

test('design editing, quiet updates and drawing counts translate locally without renaming structures', t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const actor = bot(), report = designProgress(line => actor.chat(line), true, actor);
  now += 45000; report('');
  report('{"name":"My English Castle","size":[3,4,5]}');
  now += 45000; report('{"block":"stone"}');
  assert.match(actor.said[0], /Ainda estou/);
  assert.match(actor.said[1], /My English Castle/);
  assert.match(actor.said[2], /3 por 5.*4 de altura/);
  assert.match(actor.said[3], /1 parte/);
  actor._jevNarration = 'off'; now += 45000; report('{"block":"stone"}');
  assert.equal(actor.said.length, 4);
});

test('lava travel progress is localized and filtered without translating its internal record', () => {
  for (const mode of ['off', 'important', 'full']) {
    const actor = bot(mode), goal = {};
    require('../src/obsidian').holdLava(actor, goal, () => {}, { way: 'pool', lava: { x: 20, y: 65, z: 0 } });
    assert.equal(goal.lavaFetch.way, 'pool');
    assert.match(goal.lavaFetch.says, /^Walking to the lava pool/);
    if (mode === 'full') assert.match(actor.said[0], /lava.*20, 65, 0.*20 blocos.*5 blocos abaixo/);
    else assert.deepEqual(actor.said, []);
  }
});

test('leaving an unsuccessful fortress search is important and preserves the leave state', () => {
  for (const mode of ['off', 'important', 'full']) {
    const actor = bot(mode), state = {};
    require('../src/fortress-hold').leave(actor, state, { anchor: { x: 10, y: 70, z: 20 }, now: 1000 });
    assert.equal(state.shunned.length, 1);
    assert.equal(state.shunned[0].why, 'Jev chose to leave it and search on');
    if (mode === 'off') assert.deepEqual(actor.said, []);
    else assert.match(actor.said[0], /fortaleza.*10, 70, 20.*outra/);
  }
});

test('successful chest storage announces an important localized outcome and preserves English callbacks', async t => {
  const chest = require('../src/chest-delivery');
  for (const mode of ['off', 'important', 'full']) {
    const actor = bot(mode), held = [{ name: 'blaze_rod', count: 2 }], contents = {};
    actor.inventory.items = () => held;
    actor.registry = { itemsByName: { blaze_rod: { id: 1 } } };
    actor.blockAt = p => ({ name: 'chest', position: p });
    const window = { containerItems: () => Object.entries(contents).map(([name, count]) => ({ name, count })),
      deposit: async (id, metadata, count) => { contents.blaze_rod = count; held[0].count = 0; }, close() {} };
    t.mock.method(chest, 'openChest', async () => window);
    const entry = { position: { x: 0, y: 70, z: 1 }, contents: {}, dimension: 'nether' };
    const goal = { rodStashes: [entry] };
    assert.equal(await require('../src/rod-stash').stashRods(actor, { check() {} }, goal, () => {}, {},
      { existing: entry, what: [{ item: 'blaze_rod', count: 2 }] }, { chat: list => `Original callback: ${list}` }), true);
    assert.equal(entry.contents.blaze_rod, 2);
    if (mode === 'off') assert.deepEqual(actor.said, []);
    else { assert.match(actor.said[0], /2.*vara de blaze.*baú/i); assert.doesNotMatch(actor.said[0], /Original callback/); }
  }
});
