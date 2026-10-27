'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { createCooperation, CooperationRequired } = require('../src/cooperation');

function fixture() {
  const bot = new EventEmitter(), opened = [];
  const state = { now: 1000000, generation: 1, goal: { from: 'Alex', request: 'get iron', createdAt: 'task-1', status: 'running' } };
  const policy = { language: 'en-US', cooperation: 'ask', coordinates: 'hud' };
  bot.game = { dimension: 'minecraft:overworld' };
  bot.players = {};
  bot.inventory = { items: () => [{ name: 'iron_ingot', count: 4 }] };
  bot.openContainer = target => { opened.push(target); return 'window'; };
  bot.openBlock = target => { opened.push(target); return 'window'; };
  bot.activateBlock = target => { opened.push(target); };
  bot.perception = { visibleEntity: entity => entity?.visible === true, lastSeenPlayer: () => null };
  const cooperation = createCooperation({ bot, now: () => state.now, settings: () => policy,
    getGeneration: () => state.generation, getGoal: () => state.goal });
  return { bot, cooperation, opened, state, policy, chest: { name: 'chest', position: new Vec3(1, 60, 2) } };
}

test('switching another player work requires the existing task owner confirmation', () => {
  const f = fixture(); f.state.goal.from = 'Bob';
  const spec = { kind: 'craft', item: 'chest', count: 1, request: 'make a chest', from: 'Alex' };
  const result = f.cooperation.propose(spec);
  assert.equal(result.question.from, 'Bob'); assert.equal(result.question.requestedBy, 'Alex');
  assert.equal(f.cooperation.reply('Alex', 'yes'), null);
  assert.equal(f.cooperation.reply('Other', 'yes'), null);
  assert.equal(f.cooperation.reply('Bob', 'yes').spec.from, 'Alex');
  assert.equal(f.cooperation.propose(spec).spec.item, 'chest');
});

test('a new request from the same owner and ordinary chat do not ask redundant permission', () => {
  const f = fixture();
  assert.ok(f.cooperation.propose({ kind: 'craft', request: 'make a chest', from: 'Alex' }).spec);
  f.state.goal.from = 'Bob';
  assert.ok(f.cooperation.propose({ kind: 'other', request: 'hello', from: 'Alex' }).spec);
  assert.equal(f.cooperation.pending('Bob'), null);
});

test('exploration cannot silently replace another player work', () => {
  const f = fixture(); f.state.goal.from = 'Bob';
  assert.equal(f.cooperation.propose({ kind: 'explore', request: 'explore nearby', from: 'Alex' }).question.type, 'replace_task');
});

test('confirmation is bound to the request, goal, generation and responder', () => {
  const f = fixture(); f.state.goal.from = 'Bob';
  const spec = { kind: 'craft', request: 'make a chest', from: 'Alex' };
  f.cooperation.propose(spec);
  f.state.generation++;
  assert.equal(f.cooperation.reply('Bob', 'sim').action, 'stale');
  assert.ok(f.cooperation.propose(spec).question);
  f.state.goal.createdAt = 'task-2';
  assert.equal(f.cooperation.reply('Bob', 'yes').action, 'stale');
});

test('destructive build edit uses actual continuation mode and saved build ownership', () => {
  const f = fixture();
  const build = { id: 'house-1', name: 'House', from: 'Bob' };
  const spec = { kind: 'build', request: 'change the house', from: 'Alex', buildContinuation: { mode: 'edit', target: 'house-1', name: 'House' } };
  const result = f.cooperation.propose(spec, { builds: { all: () => [build] } });
  assert.equal(result.question.type, 'construction_edit'); assert.equal(result.question.from, 'Bob');
  assert.equal(f.cooperation.reply('Alex', 'yes'), null);
  assert.equal(f.cooperation.reply('Bob', 'pode alterar').action, 'accept');
  assert.ok(f.cooperation.propose(spec, { builds: [build] }).spec);
});

test('described build rows fall back to registry ownership, while finish preserves the plan', () => {
  const f = fixture();
  f.bot.buildRegistry = { find: id => id === 'house-1' ? { id, from: 'Bob', name: 'House' } : null };
  const base = { kind: 'build', request: 'edit house', from: 'Alex', buildContinuation: { mode: 'edit', target: 'house-1' } };
  assert.equal(f.cooperation.propose(base, { builds: [{ id: 'house-1', name: 'House' }] }).question.from, 'Bob');
  f.cooperation.clearAll();
  assert.ok(f.cooperation.propose({ ...base, buildContinuation: { mode: 'finish', target: 'house-1' } }).spec);
});

test('unknown chests require explicit scoped consent before any open is sent', () => {
  const f = fixture(); f.cooperation.installGuards();
  let permission;
  assert.throws(() => f.bot.openContainer(f.chest), error => {
    assert.ok(error instanceof CooperationRequired); assert.equal(error.needsPlayer, true);
    permission = error.permissionRequest; return true;
  });
  assert.equal(f.opened.length, 0);
  assert.equal(f.state.goal.cooperationRequest.key, permission.key);
  const question = f.cooperation.proposePermission(permission).question;
  assert.equal(question.from, 'Alex');
  assert.equal(f.cooperation.reply('Other', 'yes'), null);
  assert.equal(f.cooperation.reply('Alex', 'pode usar').action, 'accept');
  assert.equal(f.bot.openContainer(f.chest), 'window');
  assert.equal(f.opened.length, 1);
  assert.throws(() => f.bot.openContainer({ ...f.chest, position: new Vec3(2, 60, 2) }), { code: 'COOPERATION_REQUIRED' });
});

test('container approval expires and does not survive another task or request generation', () => {
  const f = fixture(); f.cooperation.installGuards();
  try { f.bot.openContainer(f.chest); } catch (error) { f.cooperation.proposePermission(error.permissionRequest); }
  f.cooperation.reply('Alex', 'yes');
  assert.equal(f.cooperation.canUseContainer(f.chest), true);
  f.state.generation++; assert.equal(f.cooperation.canUseContainer(f.chest), false);
  f.state.generation--; f.state.goal.createdAt = 'task-2'; assert.equal(f.cooperation.canUseContainer(f.chest), false);
  f.state.goal.createdAt = 'task-1'; f.state.now += 300001; assert.equal(f.cooperation.canUseContainer(f.chest), false);
});

test('home proximity and an unverified old stash do not establish chest ownership', () => {
  const f = fixture();
  f.state.goal.survival = { home: { origin: { x: 1, y: 60, z: 2 }, stash: { position: { x: 1, y: 60, z: 2 } } } };
  assert.equal(f.cooperation.isOwned(f.chest), false);
  assert.equal(f.cooperation.canUseContainer(f.chest), false);
  f.cooperation.markOwned(f.chest);
  assert.equal(f.cooperation.canUseContainer(f.chest), true);
  assert.deepEqual(f.state.goal.cooperationOwnedContainers, ['overworld:1,60,2']);
  f.bot.game.dimension = 'minecraft:the_nether'; assert.equal(f.cooperation.canUseContainer(f.chest), false);
});

test('only a server-observed placed container gains ownership', async () => {
  const f = fixture();
  f.bot.heldItem = { name: 'chest' };
  f.bot.placeBlock = () => Promise.resolve();
  let observed = false;
  f.bot.blockAt = () => observed ? f.chest : null;
  f.cooperation.installGuards();
  await f.bot.placeBlock({ position: new Vec3(1, 59, 2) }, new Vec3(0, 1, 0));
  assert.equal(f.cooperation.isOwned(f.chest), false);
  observed = true;
  await f.bot.placeBlock({ position: new Vec3(1, 59, 2) }, new Vec3(0, 1, 0));
  assert.equal(f.cooperation.isOwned(f.chest), true);
});

test('guarded direct block activation cannot bypass shared chest consent', () => {
  const f = fixture(); f.cooperation.installGuards();
  assert.throws(() => f.bot.activateBlock(f.chest), { code: 'COOPERATION_REQUIRED' });
  assert.throws(() => f.bot.openBlock(f.chest), { code: 'COOPERATION_REQUIRED' });
  assert.equal(f.opened.length, 0);
  assert.equal(f.bot.openBlock({ name: 'crafting_table', position: new Vec3(1, 60, 2) }), 'window');
});

test('cooperation off bypasses consent gates, while private ender chests need no shared permission', () => {
  const f = fixture(); f.state.goal.from = 'Bob';
  assert.equal(f.cooperation.canUseContainer({ ...f.chest, name: 'ender_chest' }), true);
  f.policy.cooperation = 'off'; f.cooperation.installGuards();
  assert.ok(f.cooperation.propose({ kind: 'craft', request: 'make a chest', from: 'Alex' }).spec);
  assert.equal(f.bot.openContainer(f.chest), 'window');
});

test('relative and off coordinate modes omit exact chest coordinates from the permission question', () => {
  for (const coordinates of ['relative', 'off']) {
    const f = fixture(); f.policy.coordinates = coordinates; f.cooperation.installGuards();
    let permission;
    try { f.bot.openContainer(f.chest); } catch (error) { permission = error.permissionRequest; }
    const result = f.cooperation.proposePermission(permission);
    assert.doesNotMatch(result.question.message, /1, 60, 2/);
    assert.equal(result.question.permission.key, 'overworld:1,60,2');
  }
});

test('following never reads a hidden live position and stops chasing immediately', () => {
  const f = fixture();
  const entity = { visible: true, position: new Vec3(2, 60, 0) };
  f.bot.players.Alex = { entity };
  f.bot.perception.lastSeenPlayer = () => ({ name: 'Alex', position: new Vec3(2, 60, 0), dimension: 'overworld', observedAt: f.state.now - 1000 });
  assert.equal(f.cooperation.player('Alex').status, 'visible');
  entity.visible = false; entity.position = new Vec3(1000, 60, 1000);
  const lost = f.cooperation.player('Alex');
  assert.equal(lost.pause, true); assert.equal(lost.status, 'lost');
  assert.deepEqual(lost.lastSeen.position, { x: 2, y: 60, z: 0 });
  assert.equal(lost.entity, undefined);
  f.state.now += 15000;
  assert.equal(f.cooperation.player('Alex').status, 'expired');
  delete f.bot.players.Alex;
  assert.equal(f.cooperation.player('Alex', { goalId: 'task-2' }).status, 'offline');
});

test('visible following resumes local observation and sharing uses actual current inventory', () => {
  const f = fixture();
  f.bot.players.Alex = { entity: { visible: false, position: new Vec3(20, 60, 0) } };
  assert.equal(f.cooperation.player('Alex').pause, true);
  f.bot.players.Alex.entity.visible = true;
  assert.equal(f.cooperation.player('Alex').pause, false);
  assert.equal(f.cooperation.canShare('iron_ingot', 4), true);
  assert.equal(f.cooperation.canShare('iron_ingot', 5), false);
  f.bot.inventory.items = () => [];
  assert.equal(f.cooperation.canShare('iron_ingot', 1), false);
});

test('permission questions expire without treating unrelated chat as consent', () => {
  const f = fixture(); f.state.goal.from = 'Bob';
  f.cooperation.propose({ kind: 'craft', request: 'make a chest', from: 'Alex' });
  assert.equal(f.cooperation.reply('Bob', 'nice weather'), null);
  f.state.now += 90001;
  assert.equal(f.cooperation.reply('Bob', 'yes'), null);
});

test('late plugins receive container guards once and closing restores only this coordinator wrappers', () => {
  const f = fixture(); delete f.bot.openContainer;
  const original = target => target.name; f.bot.openContainer = original;
  f.bot.emit('inject_allowed'); const guarded = f.bot.openContainer;
  f.bot.emit('spawn'); assert.equal(f.bot.openContainer, guarded);
  assert.throws(() => f.bot.openContainer(f.chest), { code: 'COOPERATION_REQUIRED' });
  f.cooperation.close(); assert.equal(f.bot.openContainer, original);
  assert.equal(f.bot.listenerCount('spawn'), 0); assert.equal(f.bot.listenerCount('inject_allowed'), 0);
});
