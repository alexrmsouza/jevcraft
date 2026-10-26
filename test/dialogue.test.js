'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDialogue, NO_PROGRESS_MS } = require('../src/dialogue');

function fixture(options = {}) {
  let time = 1000000, safe = true;
  const messages = [], policy = { language: 'pt-BR', narration: 'full', initiative: 'full' };
  const dialogue = createDialogue({ now: () => time, emit: (message, detail) => { messages.push({ message, ...detail }); return true; },
    isSafe: () => safe, settings: () => policy, ...options });
  return { dialogue, messages, policy, advance: ms => { time += ms; }, danger: value => { safe = !value; } };
}

const help = { kind: 'help', message: 'Preciso de ajuda. Diga retomar quando estiver pronto, ou depois.',
  goalId: 'task-1', request: 'get diamond', options: ['resume', 'later', 'cancel'] };
const goal = overrides => ({ from: 'Alex', createdAt: 'task-1', request: 'get diamond', status: 'running', item: 'diamond', count: 1,
  step: { action: 'mine', item: 'diamond', target: { x: 10, y: 60, z: 0 } }, ...overrides });

test('help remembers the owner and acknowledgement waits for actual assistance', () => {
  const { dialogue, messages } = fixture();
  dialogue.ask('Alex', help);
  assert.equal(dialogue.reply('Other', 'retomar', { goalId: 'task-1' }), null);
  assert.equal(dialogue.reply('Alex', 'sim', { goalId: 'task-1' }).action, 'acknowledge');
  assert.ok(dialogue.pending('Alex'));
  assert.equal(dialogue.reply('alex', 'pode continuar', { goalId: 'task-1' }).action, 'resume');
  assert.equal(dialogue.pending('Alex'), null);
  assert.equal(messages.length, 1);
});

test('a pending question cannot resume a replaced task', () => {
  const { dialogue } = fixture();
  dialogue.ask('Alex', help);
  assert.equal(dialogue.reply('Alex', 'retomar', { goalId: 'task-2' }), null);
  assert.equal(dialogue.pending('Alex'), null);
});

test('help supports postponement, cancellation and unrelated conversation', () => {
  for (const [text, action] of [['deixa para depois', 'defer'], ['cancel it', 'cancel'], ['legal esse lugar', null]]) {
    const { dialogue } = fixture();
    dialogue.ask('Alex', help);
    assert.equal(dialogue.reply('Alex', text, { goalId: 'task-1' })?.action || null, action);
    assert.equal(Boolean(dialogue.pending('Alex')), action === null);
  }
});

test('short ordinal answers retain the complete original clarification request', () => {
  const { dialogue } = fixture();
  dialogue.ask('Alex', { kind: 'clarify', request: 'Traga 8 troncos para mim', message: 'Carvalho ou bétula?', options: ['carvalho', 'bétula'] });
  assert.equal(dialogue.reply('Alex', 'a segunda').request, 'Traga 8 troncos para mim (bétula)');
  dialogue.ask('Alex', { kind: 'clarify', request: 'get 8 logs', message: 'Oak or birch?', options: ['oak log', 'birch log'] });
  assert.equal(dialogue.reply('Alex', 'oak_log').request, 'get 8 logs (oak log)');
});

test('unrelated or new addressed messages are not invented clarification answers', () => {
  const { dialogue } = fixture();
  dialogue.ask('Alex', { kind: 'clarify', request: 'get logs', message: 'Oak or birch?', options: ['oak', 'birch'] });
  assert.equal(dialogue.reply('Alex', 'brb'), null);
  assert.equal(dialogue.reply('Alex', 'make a sword', { explicit: true }), null);
  assert.ok(dialogue.pending('Alex'));
});

test('a suggestion only becomes a request after its owner accepts it', () => {
  const { dialogue } = fixture();
  dialogue.offer('Alex', { key: 'completed-task-1', message: 'Quer que eu traga os troncos?', proposal: 'bring me 4 oak logs', goalId: 'task-1' });
  assert.equal(dialogue.reply('Other', 'sim'), null);
  assert.equal(dialogue.reply('Alex', 'beautiful day'), null);
  assert.equal(dialogue.reply('Alex', 'pode fazer', { goalId: 'task-1' }).request, 'bring me 4 oak logs');
});

test('contextual delivery acceptance only applies to a pending suggestion', () => {
  for (const answer of ['pode trazer', 'traga', 'pode levar', 'pode sim']) {
    const f = fixture();
    assert.equal(f.dialogue.reply('Alex', answer), null);
    f.dialogue.offer('Alex', { key: 'delivery', message: 'Quer que eu traga os troncos?', proposal: 'bring me 4 oak logs', goalId: 'task-1' });
    assert.equal(f.dialogue.reply('Alex', answer, { goalId: 'task-1' }).request, 'bring me 4 oak logs');
  }
  const f = fixture(); f.dialogue.ask('Alex', help);
  assert.equal(f.dialogue.reply('Alex', 'pode trazer', { goalId: 'task-1' }), null);
});

test('narration, initiative, safety and conversational quiet govern automatic questions', () => {
  for (const change of [{ narration: 'off' }, { initiative: 'off' }]) {
    const f = fixture(); Object.assign(f.policy, change);
    assert.equal(f.dialogue.ask('Alex', help), null);
    assert.ok(f.dialogue.ask('Alex', { kind: 'clarify', message: 'Qual madeira?', request: 'get logs', options: ['oak'] }));
  }
  const f = fixture();
  f.policy.initiative = 'help';
  assert.equal(f.dialogue.offer('Alex', { key: 'one', message: 'Make a tool?', proposal: 'craft pickaxe' }), null);
  f.danger(true); assert.equal(f.dialogue.ask('Alex', help), null);
  f.danger(false); f.dialogue.playerSpoke(); assert.equal(f.dialogue.ask('Alex', help), null);
  f.advance(5000); assert.ok(f.dialogue.ask('Alex', help));
  f.dialogue.clear('Alex'); assert.equal(f.dialogue.ask('Other', help), null);
  f.advance(30000); assert.ok(f.dialogue.ask('Other', help));
});

test('important narration permits help but suppresses optional suggestions', () => {
  const f = fixture(); f.policy.narration = 'important';
  assert.equal(f.dialogue.offer('Alex', { key: 'one', message: 'Make a tool?', proposal: 'craft pickaxe' }), null);
  assert.ok(f.dialogue.ask('Alex', help));
  assert.equal(f.messages[0].level, 'important');
});

test('discovery notices are event-driven, deduplicated and do not open a question', () => {
  const f = fixture();
  assert.equal(f.dialogue.notice('Alex', { key: 'village:10:20', message: 'Encontrei uma vila por aqui.' }), true);
  assert.equal(f.dialogue.pending('Alex'), null);
  f.advance(30000);
  assert.equal(f.dialogue.notice('Alex', { key: 'village:10:20', message: 'Encontrei uma vila por aqui.' }), false);
  assert.deepEqual(f.messages.map(item => [item.level, item.kind]), [['progress', 'notice']]);
});

test('optional discovery comments respect quiet, danger, communication modes and pending questions', () => {
  const f = fixture(), event = { key: 'village', message: 'Found a village.' };
  f.dialogue.playerSpoke(); assert.equal(f.dialogue.notice('Alex', event), false);
  f.advance(5000); f.danger(true); assert.equal(f.dialogue.notice('Alex', event), false);
  f.danger(false); f.policy.initiative = 'help'; assert.equal(f.dialogue.notice('Alex', event), false);
  f.policy.initiative = 'full'; f.policy.narration = 'important'; assert.equal(f.dialogue.notice('Alex', event), false);
  f.policy.narration = 'off'; assert.equal(f.dialogue.notice('Alex', event), false);
  f.policy.narration = 'full'; f.dialogue.ask('Alex', { kind: 'clarify', message: 'Oak or birch?', request: 'get logs', options: ['oak', 'birch'] });
  f.advance(30000); assert.equal(f.dialogue.notice('Alex', event), false);
  f.dialogue.clear('Alex'); assert.equal(f.dialogue.notice('Alex', event), true);
});

test('expiry does not send a reminder or repeat a keyed question', () => {
  const f = fixture();
  f.dialogue.ask('Alex', { ...help, key: 'help:task-1:0' });
  f.advance(300001); f.dialogue.tick();
  assert.equal(f.dialogue.pending('Alex'), null);
  assert.equal(f.dialogue.ask('Alex', { ...help, key: 'help:task-1:0' }), null);
  assert.equal(f.messages.length, 1);
  assert.ok(f.dialogue.ask('Alex', { ...help, key: 'help:task-1:1' }));
});

test('questions and event deduplication survive restart with player isolation', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-dialogue-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'world-one.json');
  const first = fixture({ file });
  first.dialogue.ask('Alex', { ...help, key: 'help:task-1:0' });
  const second = fixture({ file });
  assert.equal(second.messages.length, 0);
  assert.equal(second.dialogue.pending('alex').request, 'get diamond');
  assert.equal(second.dialogue.pending('other'), null);
  assert.equal(second.dialogue.reply('Alex', 'retry', { goalId: 'task-1' }).action, 'resume');
  second.advance(40000);
  assert.equal(second.dialogue.ask('Alex', { ...help, key: 'help:task-1:0' }), null);
  assert.equal(fixture({ file: path.join(directory, 'world-two.json') }).dialogue.pending('Alex'), null);
});

test('damaged persisted questions are ignored without interrupting the session', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-dialogue-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json'); fs.writeFileSync(file, '{bad');
  const f = fixture({ file });
  assert.equal(f.dialogue.pending('Alex'), null);
  assert.equal(f.dialogue.persistenceError, 'invalid_state');
  assert.ok(f.dialogue.ask('Alex', help));
  assert.equal(f.dialogue.persistenceError, null);
});

test('identical timer polls do not manufacture repeated failures', () => {
  const f = fixture(), g = goal({ lastError: 'No path', updatedAt: 'once', failures: 1 });
  for (let i = 0; i < 6; i++) assert.equal(f.dialogue.observeTask('Alex', g).blocked, false);
  g.updatedAt = 'twice'; g.failures = 2; assert.equal(f.dialogue.observeTask('Alex', g).blocked, false);
  g.updatedAt = 'third'; g.failures = 3;
  assert.deepEqual(f.dialogue.observeTask('Alex', g), { blocked: true, reason: 'repeated_error' });
});

test('timestamp and decision changes alone cannot manufacture repeated failures', () => {
  const f = fixture(), g = goal({ lastError: 'No path', failures: 1 });
  for (let i = 0; i < 6; i++) {
    g.updatedAt = `save-${i}`;
    g.decisions = [{ at: `decision-${i}` }];
    assert.equal(f.dialogue.observeTask('Alex', g).blocked, false);
  }
});

test('cumulative slow walking counts progress without rewarding oscillation', () => {
  const f = fixture(), g = goal();
  f.dialogue.observeTask('Alex', g, { position: { x: 0, y: 60, z: 0 } });
  for (const x of [0.8, 1.5, 2.1]) {
    f.advance(60000);
    assert.equal(f.dialogue.observeTask('Alex', g, { position: { x, y: 60, z: 0 } }).blocked, false);
  }
  for (const x of [1, 2.1]) {
    f.advance(60000);
    assert.equal(f.dialogue.observeTask('Alex', g, { position: { x, y: 60, z: 0 } }).blocked, false);
  }
  f.advance(60000);
  assert.equal(f.dialogue.observeTask('Alex', g, { position: { x: 2.1, y: 60, z: 0 } }).reason, 'no_progress');
});

test('changing step labels or wandering does not hide lack of progress', () => {
  const f = fixture(), g = goal();
  f.dialogue.observeTask('Alex', g, { inventory: { diamond: 0 }, position: { x: 0, y: 60, z: 0 } });
  f.advance(NO_PROGRESS_MS);
  g.step = { action: 'trying_again' };
  assert.deepEqual(f.dialogue.observeTask('Alex', g, { inventory: { diamond: 0 }, position: { x: 100, y: 60, z: 100 } }),
    { blocked: true, reason: 'no_progress' });
});

test('actual relevant acquisition and improved target distance reset progress time', () => {
  const f = fixture(), g = goal();
  f.dialogue.observeTask('Alex', g, { inventory: { diamond: 0 }, position: { x: 0, y: 60, z: 0 } });
  f.advance(NO_PROGRESS_MS - 1);
  assert.equal(f.dialogue.observeTask('Alex', g, { inventory: { diamond: 0 }, position: { x: 3, y: 60, z: 0 } }).blocked, false);
  f.advance(NO_PROGRESS_MS - 1);
  assert.equal(f.dialogue.observeTask('Alex', g, { inventory: { diamond: 1 } }).blocked, false);
  f.advance(NO_PROGRESS_MS - 1);
  assert.equal(f.dialogue.observeTask('Alex', g, { inventory: { diamond: 0 } }).blocked, false);
  f.advance(1);
  assert.equal(f.dialogue.observeTask('Alex', g, { inventory: { diamond: 1 } }).reason, 'no_progress');
});

test('explicit retry resets the watchdog and a new task starts its own budget', () => {
  const f = fixture(), g = goal();
  f.dialogue.observeTask('Alex', g); f.advance(NO_PROGRESS_MS);
  assert.equal(f.dialogue.observeTask('Alex', g).blocked, true);
  f.dialogue.resetTask('Alex');
  assert.equal(f.dialogue.observeTask('Alex', g).blocked, false);
  f.advance(NO_PROGRESS_MS - 1);
  assert.equal(f.dialogue.observeTask('Alex', goal({ createdAt: 'task-2' })).blocked, false);
});

test('known waiting deadlines do not trigger spurious no-progress help', () => {
  const f = fixture(), g = goal({ step: { action: 'wait_for_dawn', until: 1300000 } });
  f.dialogue.observeTask('Alex', g); f.advance(NO_PROGRESS_MS);
  assert.equal(f.dialogue.observeTask('Alex', g).blocked, false);
  f.advance(300001);
  assert.equal(f.dialogue.observeTask('Alex', g).reason, 'no_progress');
});

test('task progress tracking cannot bleed across players', () => {
  const f = fixture(), g = goal();
  f.dialogue.observeTask('Alex', g); f.advance(NO_PROGRESS_MS);
  assert.equal(f.dialogue.observeTask('Other', g).blocked, false);
  assert.equal(f.dialogue.observeTask('Alex', g).blocked, true);
});
