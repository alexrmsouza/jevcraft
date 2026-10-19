'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { Task } = require('../src/skills');

for (const narration of ['off', 'important', 'full']) test(`reactive outage and recovery announcements follow Portuguese ${narration} policy`, async () => {
  const said = [], bot = { _jevLanguage: 'pt-BR', _jevNarration: narration, chat: message => said.push(message),
    entity: { position: new Vec3(.5, 64, .5) }, game: { dimension: 'overworld', gameMode: 'survival' }, health: 20, food: 20,
    inventory: { items: () => [] }, blockAt: () => ({ name: 'air', boundingBox: 'empty' }) };
  const outage = require('../src/jev-down');
  outage.down(bot, {}, 'fixture', Error('No answer'), { log() {} }); outage.back(bot, {}, 'fixture', { log() {} });
  const recovery = { status: 'pending', inventoryBeforeDeath: {} };
  await require('../src/recovery').recoverItems(bot, new Task('recover'), recovery, () => {}, () => assert.fail('No trip for missing inventory'));
  assert.equal(recovery.status, 'finished'); assert.equal(recovery.reason, 'no items were recorded in my inventory at death');
  if (narration === 'off') assert.deepEqual(said, []);
  else { assert.equal(said.length, 3); assert.match(said[0], /não está respondendo/); assert.match(said[1], /voltou/); assert.match(said[2], /Após renascer/); assert(!said.join(' ').includes('no items were recorded')); }
});

test('a failed corpse retrieval announces its Portuguese outcome only when allowed', () => {
  for (const narration of ['off', 'important']) {
    const said = [], bot = { _jevLanguage: 'pt-BR', _jevNarration: narration, game: { dimension: 'the_nether' }, inventory: { slots: {} }, chat: line => said.push(line) }, goal = {};
    assert.equal(require('../src/corpse-run').tripCameToNothing(bot, goal, { dimension: 'nether' }, () => {}), true);
    assert.equal(goal.errand.dimension, 'overworld');
    if (narration === 'off') assert.deepEqual(said, []); else assert.match(said[0], /equipamento/);
  }
});
