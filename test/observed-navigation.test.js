'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { observedNavigation, nextObservedWaypoint } = require('../src/observed-navigation');

function bot(known = true) {
  return { entity: { position: new Vec3(.5, 64, .5) }, perception: { mode: 'player', refresh() {} }, lookAt: async () => {},
    blockAt: p => !known ? null : p.y === 63 ? { name: 'stone', boundingBox: 'block' } : p.y >= 64 ? { name: 'air', boundingBox: 'empty' } : null };
}
test('a long trip advances through observed legs and never fills unknown terrain with air', async () => {
  const b = bot(), calls = [], task = { check() {} }, goal = { x: 40, y: 64, z: 0 };
  await observedNavigation(b, task, goal, {}, async leg => { calls.push(leg); b.entity.position = new Vec3(leg.x, leg.y, leg.z); });
  assert(calls.length > 2); assert.equal(calls.at(-1), goal);
  assert(calls.slice(0, -1).every(leg => leg !== goal));
  assert.equal(nextObservedWaypoint(bot(false), goal), null);
});
test('an unknown route asks for player guidance without moving or consulting raw terrain', async () => {
  let moved = false;
  await assert.rejects(observedNavigation(bot(false), { check() {} }, { x: 40, y: 64, z: 0 }, {}, async () => { moved = true; }), error => error.needsPlayer && error.code === 'OBSERVED_ROUTE_REQUIRED');
  assert.equal(moved, false);
});
test('unrestricted and nearby navigation retain the original route contract', async () => {
  const b = bot(false), goal = { x: 2, y: 64, z: 0 }, options = { sprint: true };
  assert.equal(await observedNavigation(b, {}, goal, options, (g, o) => g === goal && o === options), true);
  b.perception.mode = 'unrestricted';
  assert.equal(await observedNavigation(b, {}, { x: 40, y: 64, z: 0 }, options, () => 'legacy'), 'legacy');
});
test('task cancellation aborts before revealing or starting another navigation leg', async () => {
  let looked = false; const b = bot(); b.lookAt = async () => { looked = true; };
  await assert.rejects(observedNavigation(b, { check() { throw Object.assign(new Error('stop'), { name: 'Cancelled' }); } }, { x: 40, y: 64, z: 0 }, {}, async () => {}), { name: 'Cancelled' });
  assert.equal(looked, false);
});
