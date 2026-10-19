'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createReactiveWait } = require('../src/reactive-wait');
const danger = require('../src/danger'), vitals = require('../src/vitals');

function fixture(t) {
  let threat = null; const calls = [], bot = {
    _waitingForRequest: true, _requestActivityEpoch: 1, isAlive: true, health: 20, food: 2,
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true, metadata: {} },
    game: { gameMode: 'survival' }, inventory: { items: () => [] }, entities: {},
    blockAt: p => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty', position: p }),
    pathfinder: { setGoal() {} }, clearControlStates() {}, deactivateItem() {},
  };
  t.mock.method(danger, 'immediateThreat', () => threat);
  t.mock.method(danger, 'threats', () => threat ? [threat] : []);
  const survival = { state: { paused: true }, client: { systemOne: () => { throw new Error('Unexpected direct call'); } },
    decide: async (task, goal, save, options) => { calls.push('decide'); assert.deepEqual(Object.keys(options.tree), ['retreat', 'fight']); assert.equal(options.id, 'encounter_stance'); return { path: ['retreat'], action: options.tree.retreat }; },
    runAway: async () => { calls.push('retreat'); threat = null; }, swingFor: async () => { calls.push('fight'); threat = null; },
    step: () => { throw new Error('No full survival step'); }, flee: () => { throw new Error('No broad flee'); },
    actions: { acquireStep: () => { throw new Error('No acquisition'); }, explore: () => { throw new Error('No exploration'); } },
  };
  const reactive = createReactiveWait({ bot, survival, save() {} });
  return { bot, survival, reactive, calls, threaten: () => { threat = { entity: { id: 1, name: 'zombie', position: new Vec3(1.5, 64, 0.5) }, distance: 1, visible: true }; }, clear: () => { threat = null; } };
}

test('a quiet hungry bot waits without decisions, food, crafting or preparation', async t => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) assert.equal(await f.reactive.tick(), false);
  assert.deepEqual(f.calls, []); assert.equal(f.bot._waitingForRequest, true); assert.equal(f.bot._reactiveWaitActive, false);
});

test('an immediate hostile permits one existing defense and then returns to quiet waiting', async t => {
  const f = fixture(t); f.threaten();
  assert.equal(await f.reactive.tick(), true); assert.deepEqual(f.calls, ['decide', 'retreat']);
  assert.equal(f.bot._waitingForRequest, true); assert.equal(f.bot._reactiveWaitActive, false);
  assert.equal(await f.reactive.tick(), false); assert.deepEqual(f.calls, ['decide', 'retreat']);
});

test('the existing danger detector recognizes an observed hostile without a synthetic danger flag', async t => {
  const immediateThreat = danger.immediateThreat; const f = fixture(t);
  t.mock.method(danger, 'immediateThreat', immediateThreat);
  f.bot.registry = require('minecraft-data')('26.1');
  f.bot.world = { raycast: () => null }; f.bot.time = { timeOfDay: 13000 };
  f.bot.entities = { 1: { id: 1, name: 'zombie', type: 'hostile', isValid: true, width: 0.6, height: 1.95, position: new Vec3(1.5, 64, 0.5), metadata: [] } };
  f.survival.runAway = async () => { f.calls.push('retreat'); f.bot.entities = {}; };
  await f.reactive.tick(); assert.deepEqual(f.calls, ['decide', 'retreat']);
  assert.equal(await f.reactive.tick(), false);
});

test('the fight leaf uses only the existing short defensive swing skill', async t => {
  const f = fixture(t); f.threaten();
  f.survival.decide = async (task, goal, save, { tree }) => ({ path: ['fight'], action: tree.fight });
  f.survival.swingFor = async (task, goal, save, duration) => { task.check(); assert.equal(duration, 1000); f.calls.push('fight'); f.clear(); };
  await f.reactive.tick(); assert.deepEqual(f.calls, ['fight']);
});

test('a real body hazard calls its existing body response without opening food priorities', async t => {
  const f = fixture(t); let burning = true;
  t.mock.method(vitals, 'inFire', () => burning);
  t.mock.method(vitals, 'fireWays', () => ({ out_of_fire: { description: 'Leave the observed fire', run: async () => { f.calls.push('out_of_fire'); burning = false; } } }));
  t.mock.method(require('../src/body'), 'answer', async (bot, task, key, ways) => { assert.equal(key, 'fire'); task.check(); await ways.out_of_fire.run(); });
  await f.reactive.tick(); assert.deepEqual(f.calls, ['out_of_fire']); assert.equal(await f.reactive.tick(), false);
});

for (const change of ['epoch', 'cleared', 'cancelled']) test(`a late real body response cannot act after its hazard is ${change}`, async t => {
  const f = fixture(t); let hot = true, release;
  t.mock.method(vitals, 'onHotFloor', () => hot ? { name: 'magma_block' } : null);
  t.mock.method(vitals, 'hotFloorWays', () => ({ crouch: { description: 'Crouch on the hot floor', run: async () => { f.calls.push('crouch'); } } }));
  t.mock.method(require('../src/decisions'), 'decide', async () => new Promise(resolve => { release = () => resolve({ path: ['crouch'] }); }));
  const pending = f.reactive.tick(); await Promise.resolve(); assert(release);
  let cancelled;
  if (change === 'epoch') f.bot._requestActivityEpoch++;
  if (change === 'cleared') hot = false;
  if (change === 'cancelled') cancelled = f.reactive.cancel();
  release(); await pending; await cancelled;
  assert.deepEqual(f.calls, []); assert.equal(f.bot._reactiveWaitActive, false);
});

test('a late defense decision cannot act after its activity epoch changes', async t => {
  const f = fixture(t); f.threaten(); let release;
  f.survival.decide = async (task, goal, save, { tree }) => new Promise(resolve => { release = () => resolve({ path: ['retreat'], action: tree.retreat }); });
  const pending = f.reactive.tick(); await Promise.resolve(); assert(release);
  f.bot._requestActivityEpoch++; f.bot._waitingForRequest = false;
  release(); await pending; assert.deepEqual(f.calls, []); assert.equal(f.bot._reactiveWaitActive, false);
});

test('a threat that clears while Jev answers cannot start a stale defensive action', async t => {
  const f = fixture(t); f.threaten(); let release;
  f.survival.decide = async (task, goal, save, { tree }) => new Promise(resolve => { release = () => resolve({ path: ['retreat'], action: tree.retreat }); });
  const pending = f.reactive.tick(); await Promise.resolve();
  f.clear(); release(); await pending;
  assert.deepEqual(f.calls, []); assert.equal(f.bot._reactiveWaitActive, false);
});

test('cancel unwinds a pending response before handing off to requested work', async t => {
  const f = fixture(t); f.threaten(); let release, taskSeen;
  f.survival.decide = async (task, goal, save, { tree }) => { taskSeen = task; return new Promise(resolve => { release = () => resolve({ action: tree.retreat, path: ['retreat'] }); }); };
  const pending = f.reactive.tick(); await Promise.resolve();
  const cancelled = f.reactive.cancel(); assert.equal(taskSeen.cancelled, true);
  release(); await cancelled; await pending;
  assert.deepEqual(f.calls, []); assert.equal(f.bot._reactiveWaitActive, false);
});

test('active requested work and unready connections do not launch a reactive task', async t => {
  const f = fixture(t); f.threaten(); f.bot._waitingForRequest = false;
  assert.equal(await f.reactive.tick(), false);
  const unready = createReactiveWait({ bot: f.bot, survival: f.survival, isReady: () => false });
  f.bot._waitingForRequest = true; assert.equal(await unready.tick(), false); assert.deepEqual(f.calls, []);
});

test('single-flight defense never asks twice while a previous answer is pending', async t => {
  const f = fixture(t); f.threaten(); let release;
  f.survival.decide = async (task, goal, save, { tree }) => { f.calls.push('decide'); return new Promise(resolve => { release = () => resolve({ action: tree.retreat, path: ['retreat'] }); }); };
  const pending = f.reactive.tick(); await Promise.resolve();
  assert.equal(await f.reactive.tick(), false); assert.deepEqual(f.calls, ['decide']);
  release(); await pending;
});
