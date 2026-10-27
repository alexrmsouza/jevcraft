'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { installPlayerActions } = require('../src/player-actions');

function fixture() {
  const bot = new EventEmitter(), calls = [];
  bot.entity = { position: new Vec3(0, 60, 0), eyeHeight: 1.62, yaw: 0, pitch: 0 };
  bot.look = (...args) => { calls.push(['look', ...args]); };
  bot.lookAt = (...args) => { calls.push(['lookAt', ...args]); };
  bot.dig = (...args) => { calls.push(['dig', ...args]); return 'dig-result'; };
  bot.placeBlock = (...args) => { calls.push(['place', ...args]); return 'place-result'; };
  bot._placeBlockWithOptions = (...args) => { calls.push(['place-options', ...args]); };
  bot.attack = (...args) => { calls.push(['attack', ...args]); return 'original-combat-timing'; };
  bot.activateEntity = (...args) => { calls.push(['use', ...args]); };
  bot.setControlState = (...args) => { calls.push(['movement', ...args]); };
  bot.players = {};
  bot.perception = { visibleEntity: entity => entity?.visible === true,
    canInteract: (target, reach) => target?.visible !== false && target?.distance <= reach };
  return { bot, calls };
}

test('ordinary looks preserve Mineflayer rotation and always disable forced look', async () => {
  const { bot, calls } = fixture(); const raw = bot.look;
  const actions = installPlayerActions(bot);
  await bot.look(20, 4, true);
  assert.equal(calls[0][3], false);
  assert.ok(Math.abs(calls[0][1]) <= Math.PI);
  assert.equal(calls[0][2], Math.PI / 2);
  actions.close(); assert.equal(bot.look, raw);
});

test('lookAt calculates angles through the wrapped look instead of a raw closure bypass', async () => {
  const { bot, calls } = fixture(); installPlayerActions(bot);
  await bot.lookAt(new Vec3(0, 61.62, -4), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'look');
  assert.equal(calls[0][3], false);
  assert.ok(Math.abs(calls[0][2]) < 1e-12);
});

test('the latest look supersedes an unfinished older request without sleeps', async () => {
  const { bot } = fixture(), pending = [];
  bot.look = () => new Promise(resolve => pending.push(resolve));
  const actions = installPlayerActions(bot);
  const first = bot.look(1, 0, true), rejected = assert.rejects(first, { name: 'Cancelled' });
  const second = bot.look(2, 0, true);
  pending[0](); pending[1]();
  await rejected; await second; actions.close();
});

test('closing cancels pending look promises and late completion cannot revive them', async () => {
  const { bot } = fixture(); let finish;
  bot.look = () => new Promise(resolve => { finish = resolve; });
  const actions = installPlayerActions(bot), look = bot.look(1, 0);
  const rejected = assert.rejects(look, { code: 'ACTION_CANCELLED' });
  actions.close(); finish(); await rejected;
});

test('late-injected plugins are wrapped once and guard teardown removes callbacks', async () => {
  const bot = new EventEmitter(), calls = [];
  bot.entity = { position: new Vec3(0, 60, 0), eyeHeight: 1.62 };
  const actions = installPlayerActions(bot, { rotationOnly: true });
  const original = (...args) => calls.push(args); bot.look = original;
  bot.lookAt = () => {};
  bot.emit('inject_allowed'); const wrapper = bot.look;
  bot.emit('spawn'); assert.equal(bot.look, wrapper);
  await bot.look(1, 0, true); assert.equal(calls.length, 1); assert.equal(calls[0][2], false);
  actions.close(); assert.equal(bot.look, original);
  assert.equal(bot.listenerCount('inject_allowed'), 0); assert.equal(bot.listenerCount('spawn'), 0);
});

test('rotation-only transport adapter does not require or bypass perception action gates', () => {
  const { bot } = fixture(); delete bot.perception;
  const originalDig = bot.dig;
  installPlayerActions(bot, { rotationOnly: true });
  assert.equal(bot.dig, originalDig);
});

test('reach and observation gate digging, placement and entity use', () => {
  const { bot, calls } = fixture(); installPlayerActions(bot);
  assert.throws(() => bot.dig({ distance: 5, visible: true }, true), { code: 'PLAYER_REACH' });
  assert.throws(() => bot.placeBlock({ distance: 2, visible: false }, new Vec3(0, 1, 0)), { code: 'PLAYER_REACH' });
  assert.throws(() => bot.activateEntity({ distance: 4, visible: true }), { code: 'PLAYER_REACH' });
  assert.equal(calls.length, 0);
  assert.equal(bot.dig({ distance: 4.4, visible: true }, true), 'dig-result');
  assert.equal(calls[0][2], false);
});

test('attacks retain the existing combat return value and cadence without packet injection', () => {
  const { bot, calls } = fixture(); installPlayerActions(bot);
  assert.throws(() => bot.attack({ visible: false, distance: 2 }), { code: 'PLAYER_REACH' });
  assert.throws(() => bot.attack({ visible: true, distance: 3.1 }), { code: 'PLAYER_REACH' });
  assert.equal(bot.attack({ visible: true, distance: 2.9 }), 'original-combat-timing');
  assert.equal(bot.attack({ visible: true, distance: 2.9 }), 'original-combat-timing');
  assert.equal(calls.filter(call => call[0] === 'attack').length, 2);
});

test('private placement options cannot re-enable forced rotation', () => {
  const { bot, calls } = fixture(); installPlayerActions(bot);
  bot._placeBlockWithOptions({ visible: true, distance: 2 }, new Vec3(0, 1, 0), { forceLook: true, swingArm: 'right' });
  assert.deepEqual(calls[0][3], { forceLook: false, swingArm: 'right' });
});

test('idle attention is visible-player-only, safe, throttled and does not press movement keys', async () => {
  const { bot, calls } = fixture(); let time = 10000, idle = false, safe = true;
  const entity = { visible: true, position: new Vec3(2, 60, 0), height: 1.8 };
  bot.players.Alex = { entity };
  const actions = installPlayerActions(bot, { now: () => time, isIdle: () => idle, isSafe: () => safe });
  assert.equal(await actions.attend('Alex'), false);
  idle = true; safe = false; assert.equal(await actions.attend('Alex'), false);
  safe = true; assert.equal(await actions.attend('Other'), false);
  assert.equal(await actions.attend('alex'), true);
  assert.equal(await actions.attend('Alex'), false);
  time += 2000; entity.visible = false; assert.equal(await actions.attend('Alex'), false);
  assert.equal(calls.some(call => call[0] === 'movement'), false);
});

test('unrestricted mode preserves existing methods and invalid modes fail before action', () => {
  const { bot } = fixture(); const look = bot.look, dig = bot.dig;
  installPlayerActions(bot, { mode: 'unrestricted' });
  assert.equal(bot.look, look); assert.equal(bot.dig, dig);
  assert.throws(() => installPlayerActions(bot, { mode: 'teleport' }), /JEV_ACTIONS/);
});

test('facade action adapter can leave privately wrapped transport rotation alone', () => {
  const { bot } = fixture(); const look = bot.look, lookAt = bot.lookAt;
  installPlayerActions(bot, { rotation: false });
  assert.equal(bot.look, look); assert.equal(bot.lookAt, lookAt);
  assert.throws(() => bot.dig({ distance: 9 }), { code: 'PLAYER_REACH' });
});
