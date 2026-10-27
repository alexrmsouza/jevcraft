'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { explorationRequestStep } = require('../src/player-exploration');

test('exploration counts only areas the body actually visited', async () => {
  const b = { entity: { position: new Vec3(1, 64, 1) }, game: { dimension: 'overworld' }, blockAt: () => null }, goal = { count: 2 };
  const task = { check() {} }, save = () => {}, options = { now: () => 1000, explore: async () => {} };
  assert.equal(await explorationRequestStep(b, task, goal, save, options), false);
  assert.deepEqual(goal.playerExploration.visited, []);
  options.explore = async () => { b.entity.position.x += 64; };
  assert.equal(await explorationRequestStep(b, task, goal, save, options), false);
  assert.equal(await explorationRequestStep(b, task, goal, save, options), true);
  assert.equal(goal.playerExploration.visited.length, 2);
});
test('a bounded exploration request reports saved partial progress when time expires', async () => {
  const b = { entity: { position: new Vec3(1, 64, 1) }, game: { dimension: 'overworld' } }, goal = { count: 1,
    playerExploration: { startedAt: 1000, visited: [], origin: 'overworld:0,0' } };
  await assert.rejects(explorationRequestStep(b, {}, goal, () => {}, { now: () => 302000 }), error => error.code === 'EXPLORATION_BUDGET' && error.needsPlayer);
});
