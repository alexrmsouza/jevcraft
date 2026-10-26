'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { createSessionCompanion } = require('../src/session-companion');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-companion-'));
  const state = { now: Date.parse('2026-10-26T12:00:00.000Z'), ready: true, working: false,
    goal: { memoryId: 'task-1', from: 'Alex', kind: 'obtain', item: 'oak_log', count: 4, request: 'Get four oak logs', status: 'running' },
    stock: { oak_log: 4 }, discoveries: options.discoveries || [],
    settings: { language: 'en-US', narration: 'full', initiative: 'full', personality: 'companion', ...options.settings } };
  const lines = [], blocked = [], bot = new EventEmitter();
  Object.assign(bot, {
    username: 'Jev', health: 20, food: 20, oxygenLevel: 20, isAlive: true,
    players: { Jev: {}, Alex: {}, Sam: {} }, entities: {}, time: { timeOfDay: 1000 },
    entity: { id: 1, position: new Vec3(0, 64, 0), equipment: [] },
    game: { dimension: 'overworld', gameMode: 'survival' },
    blockAt: () => ({ name: 'air', type: 0, boundingBox: 'empty', skyLight: 15, light: 15 }),
    inventory: { slots: [], items: () => Object.entries(state.stock).map(([name, count]) => ({ name, count })) },
    chat: message => lines.push(message),
  });
  const companion = createSessionCompanion({ bot, file: path.join(directory, 'conversation.json'), dialogueFile: path.join(directory, 'dialogue.json'),
    settings: () => state.settings, getGoal: () => state.goal, getDiscoveries: () => state.discoveries,
    isReady: () => state.ready, isWorking: () => state.working, onBlocked: (goal, reason) => blocked.push({ goal, reason }), now: () => state.now });
  t.after(() => { companion.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { state, bot, lines, blocked, companion };
}

test('existing discoveries are not replayed, while a newly observed place is remembered and mentioned once', t => {
  const oldPlace = { kind: 'village', label: 'Old village', position: { x: 20, y: 64, z: 20 }, dimension: 'overworld' };
  const { state, companion, lines } = fixture(t, { discoveries: [oldPlace] });
  companion.tick(); assert.deepEqual(lines, []);
  state.discoveries.push({ kind: 'village', label: 'River village', position: { x: 80, y: 64, z: 30 }, dimension: 'overworld' });
  companion.tick();
  assert.equal(lines.length, 1); assert.match(lines[0], /village/);
  const discoveries = companion.context('Alex').conversation.recentEvents.filter(event => event.type === 'discovery');
  assert.equal(discoveries.length, 1); assert.equal(discoveries[0].text, 'River village');
  state.now += 60000; companion.tick();
  assert.equal(lines.length, 1);
  assert.equal(companion.dialogue.pending('Alex'), null, 'a discovery comment does not request action or wait for approval');
});

test('danger, low health and recent player speech defer optional discoveries until safe and quiet', t => {
  const { state, bot, companion, lines } = fixture(t);
  state.discoveries.push({ kind: 'village', label: 'Village', position: { x: 10, y: 64, z: 10 } });
  bot._alightUntil = Date.now() + 60000;
  companion.tick(); assert.deepEqual(lines, []);
  bot._alightUntil = 0; bot.health = 8;
  companion.tick(); assert.deepEqual(lines, []);
  bot.health = 20; companion.heard();
  companion.tick(); assert.deepEqual(lines, []);
  state.now += 5001; companion.tick();
  assert.equal(lines.length, 1);
});

test('important narration and help-only initiative retain discoveries without optional chatter', t => {
  const { state, companion, lines } = fixture(t, { settings: { narration: 'important', initiative: 'help' } });
  state.discoveries.push({ kind: 'village', label: 'Quiet discovery', position: { x: 30, y: 64, z: 30 } });
  companion.tick();
  assert.deepEqual(lines, []);
  assert(companion.context('Alex').conversation.recentEvents.some(event => event.type === 'discovery'));
  state.settings.narration = 'full'; state.settings.initiative = 'full';
  state.now += 60000; companion.tick();
  assert.deepEqual(lines, [], 'enabling optional speech does not replay a suppressed discovery');
});

test('equipment context includes actual worn slots and held items without duplicate names', t => {
  const { bot, companion } = fixture(t);
  bot.entity.equipment = [{ name: 'iron_helmet' }, null];
  bot.inventory.slots[5] = { name: 'iron_helmet' };
  bot.inventory.slots[6] = { name: 'iron_chestplate' };
  bot.inventory.slots[45] = { name: 'shield' };
  bot.heldItem = { name: 'iron_pickaxe' };
  assert.deepEqual(companion.context('Alex').equipment, ['iron_helmet', 'iron_chestplate', 'shield', 'iron_pickaxe']);
});

test('direct replies are stored for their recipient while task narration belongs to the task owner', t => {
  const { bot, companion } = fixture(t);
  companion.received('Sam', 'How are you?');
  companion.sayTo('Sam', 'Still helping Alex with the logs.');
  bot.chat('The logs are ready.');
  bot.chat('/time set day');
  const alex = companion.context('Alex').conversation.recentMessages.map(message => message.text);
  const sam = companion.context('Sam').conversation.recentMessages.map(message => message.text);
  assert.deepEqual(alex, ['The logs are ready.']);
  assert.deepEqual(sam, ['How are you?', 'Still helping Alex with the logs.']);
  assert(![...alex, ...sam].some(message => message.startsWith('/')));
});

test('a stale help question cannot resume a task that has already completed', t => {
  const { state, companion } = fixture(t);
  state.goal.status = 'blocked'; state.goal.lastError = 'No safe route';
  companion.blocked(state.goal);
  assert.equal(companion.dialogue.pending('Alex').kind, 'help');
  state.goal.status = 'complete';
  assert.equal(companion.reply('Alex', 'resume', false), null);
  assert.equal(companion.dialogue.pending('Alex'), null);
});

test('replacing the task invalidates a pending delivery suggestion even when the items are still carried', t => {
  const { state, companion } = fixture(t);
  state.goal.status = 'complete'; companion.completed(state.goal); companion.tick();
  assert.equal(companion.dialogue.pending('Alex').kind, 'suggestion');
  state.goal = { ...state.goal, memoryId: 'task-2', status: 'running' };
  assert.equal(companion.reply('Alex', 'yes', false), null);
  assert.equal(companion.dialogue.pending('Alex'), null);
});

test('delivery suggestions require the same completed task, its items and acceptance by its owner', t => {
  const { state, companion } = fixture(t);
  state.goal.status = 'complete'; companion.completed(state.goal); companion.tick();
  assert.equal(companion.dialogue.pending('Alex').kind, 'suggestion');
  assert.equal(companion.reply('Sam', 'yes', false), null);
  state.stock.oak_log = 0;
  assert.equal(companion.reply('Alex', 'yes', false), null, 'lost possessions invalidate the offered delivery');
  assert.equal(companion.dialogue.pending('Alex'), null);
  state.stock.oak_log = 4; state.goal = { ...state.goal, memoryId: 'task-2' };
  state.now += 30001; companion.completed(state.goal); companion.tick();
  const accepted = companion.reply('Alex', 'pode trazer', false);
  assert.equal(accepted.action, 'request');
  assert.equal(accepted.request, 'Bring me 4 oak_log');
  assert.equal(state.goal.status, 'complete', 'the adapter returns an authorized request instead of executing it');
});

test('an active task without measurable progress requests a pause, while current inventory changes count as progress', t => {
  const { state, companion, blocked } = fixture(t);
  state.working = true;
  companion.started(state.goal);
  state.now += 170000; state.stock.oak_log = 5; companion.tick();
  assert.deepEqual(blocked, []);
  state.now += 170000; companion.tick();
  assert.deepEqual(blocked, []);
  state.now += 10001; companion.tick();
  assert.equal(blocked.at(-1).goal, state.goal);
  assert.equal(blocked.at(-1).reason, 'no_progress');
});
