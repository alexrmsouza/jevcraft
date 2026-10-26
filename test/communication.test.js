'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCommunicationPolicy, shouldNarrate, announce, notify } = require('../src/communication');

const player = { from: 'Alex', username: 'Jev', players: { Alex: {}, Jev: {} } };
function settings(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-language-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'communication.json');
  return { file, policy: createCommunicationPolicy({ host: 'localhost', file, ...options }) };
}

test('default communication settings preserve English and full narration', t => {
  const { policy } = settings(t);
  assert.equal(policy.language, 'en-US');
  assert.equal(policy.narration, 'full');
  assert.equal(policy.handleCommand('Jev collect some wood', player), null);
  assert.equal(policy.handleCommand('!jev language', player).changed, false);
  assert.match(policy.handleCommand('!jev language', player).message, /en-US/);
});

test('local English commands persist both settings and override environment defaults', t => {
  const { policy, file } = settings(t, { language: 'en-US', narration: 'full' });
  const changed = policy.handleCommand('!jev language pt-BR', player);
  assert.equal(changed.changed, true);
  assert.equal(changed.language, 'pt-BR');
  assert.match(changed.message, /Idioma/);
  assert.equal(policy.handleCommand('!jev narration important', player).changed, true);
  assert.equal(policy.narration, 'important');
  const restored = createCommunicationPolicy({ host: 'localhost', file, language: 'en-US', narration: 'off' });
  assert.equal(restored.language, 'pt-BR');
  assert.equal(restored.narration, 'important');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, language: 'pt-BR', narration: 'important' });
});

test('queries and invalid options never write settings', t => {
  const { policy, file } = settings(t);
  for (const text of ['!jev language', '!jev narration', '!jev language fr-FR', '!jev narration noisy', '!jev language pt-BR extra']) {
    const response = policy.handleCommand(text, player);
    assert.equal(response.handled, true);
    assert.equal(response.changed, false);
  }
  assert.equal(fs.existsSync(file), false);
  assert.equal(policy.language, 'en-US');
  assert.equal(policy.narration, 'full');
});

test('only known players may query, and changes require local sole-player or administrator permission', t => {
  const { policy } = settings(t);
  const many = { ...player, players: { Alex: {}, Sam: {}, Jev: {} } };
  assert.equal(policy.handleCommand('!jev narration off', many).changed, false);
  assert.equal(policy.handleCommand('!jev narration off', { ...player, from: 'Jev' }).message, null);
  assert.equal(policy.handleCommand('!jev language', { ...player, from: 'Unknown' }).message, null);
  const remote = createCommunicationPolicy({ host: 'example.test' });
  assert.equal(remote.handleCommand('!jev narration off', player).changed, false);
  const admin = createCommunicationPolicy({ host: 'example.test', admins: 'aLeX' });
  assert.equal(admin.handleCommand('!jev narration off', many).changed, true);
  assert.equal(admin.narration, 'off');
  assert.equal(admin.handleCommand('!jev narration full', { ...many, from: 'Sam' }).changed, false);
});

test('changing language produces confirmations in the new language and keeps verbosity', t => {
  const { policy } = settings(t, { narration: 'off' });
  assert.match(policy.handleCommand('!jev language pt-BR', player).message, /Idioma/);
  assert.match(policy.handleCommand('!jev language en-US', player).message, /Language/);
  assert.equal(policy.narration, 'off');
});

test('saving one preference leaves the other environment default configurable', t => {
  const { policy, file } = settings(t, { narration: 'full' });
  policy.handleCommand('!jev language pt-BR', player);
  const restored = createCommunicationPolicy({ file, narration: 'important' });
  assert.equal(restored.language, 'pt-BR');
  assert.equal(restored.narration, 'important');
});

test('bad environment defaults are rejected even when a saved setting exists', t => {
  const { file } = settings(t);
  fs.writeFileSync(file, JSON.stringify({ language: 'pt-BR', narration: 'full' }));
  assert.throws(() => createCommunicationPolicy({ file, language: 'xx' }), /JEV_LANGUAGE/);
  assert.throws(() => createCommunicationPolicy({ file, narration: 'noisy' }), /JEV_NARRATION/);
});

test('corrupt saved values fall back by field without overwriting the original file', t => {
  const { file } = settings(t);
  const raw = JSON.stringify({ language: '__proto__', narration: 'important' });
  fs.writeFileSync(file, raw);
  const policy = createCommunicationPolicy({ file, language: 'pt-BR' });
  assert.equal(policy.language, 'pt-BR');
  assert.equal(policy.narration, 'important');
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

test('failed persistence keeps both current settings and removes the temporary file', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-setting-fail-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'occupied'); fs.mkdirSync(file);
  const policy = createCommunicationPolicy({ host: 'localhost', file });
  assert.equal(policy.handleCommand('!jev language pt-BR', player).changed, false);
  assert.equal(policy.language, 'en-US');
  assert.equal(policy.narration, 'full');
  assert.deepEqual(fs.readdirSync(directory), ['occupied']);
});

test('off suppresses all automatic notices, important selects critical notices, full permits progress', () => {
  for (const [mode, progress, important] of [['off', false, false], ['important', false, true], ['full', true, true]]) {
    const lines = [], bot = { _jevNarration: mode, chat: text => lines.push(text) };
    assert.equal(shouldNarrate(bot, 'progress'), progress);
    assert.equal(shouldNarrate(bot, 'important'), important);
    announce(bot, 'Gathering wood.');
    announce(bot, 'Task complete.', 'important');
    assert.deepEqual(lines, [...(progress ? ['Gathering wood.'] : []), ...(important ? ['Task complete.'] : [])]);
    bot.chat('Your requested status.');
    assert.equal(lines.at(-1), 'Your requested status.');
  }
  assert.equal(shouldNarrate({}), true);
});

test('localized notifications honor the selected language and importance filter', () => {
  const lines = [], bot = { _jevLanguage: 'pt-BR', _jevNarration: 'important', chat: text => lines.push(text) };
  notify(bot, 'Gathering.', 'Coletando.');
  notify(bot, 'Blocked.', 'Bloqueado.', 'important');
  assert.deepEqual(lines, ['Bloqueado.']);
  bot._jevLanguage = 'en-US'; bot._jevNarration = 'full';
  notify(bot, 'Gathering.', 'Coletando.');
  assert.equal(lines.at(-1), 'Gathering.');
});

test('personality and initiative use English commands and persist only explicitly selected fields', t => {
  const { policy, file } = settings(t, { personality: 'companion', initiative: 'help', language: 'pt-BR' });
  assert.equal(policy.personality, 'companion'); assert.equal(policy.initiative, 'help');
  assert.match(policy.handleCommand('!jev personality', player).message, /companion/);
  assert.equal(policy.handleCommand('!jev personality playful', player).changed, true);
  assert.equal(policy.handleCommand('!jev initiative full', player).changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, personality: 'playful', initiative: 'full' });
  const restored = createCommunicationPolicy({ file, language: 'en-US', narration: 'important', personality: 'reserved', initiative: 'off' });
  assert.equal(restored.personality, 'playful'); assert.equal(restored.initiative, 'full');
  assert.equal(restored.language, 'en-US'); assert.equal(restored.narration, 'important');
});

test('invalid personality and initiative never write, bypass permissions or replace defaults', t => {
  const { policy, file } = settings(t);
  for (const command of ['!jev personality brave', '!jev initiative always', '!jev personality playful extra']) {
    assert.equal(policy.handleCommand(command, player).changed, false);
  }
  const many = { ...player, players: { Alex: {}, Sam: {}, Jev: {} } };
  assert.equal(policy.handleCommand('!jev personality playful', many).changed, false);
  assert.equal(policy.handleCommand('!jev initiative full', many).changed, false);
  assert.equal(policy.personality, 'companion'); assert.equal(policy.initiative, 'help');
  assert.equal(fs.existsSync(file), false);
  assert.throws(() => createCommunicationPolicy({ personality: 'unknown' }), /JEV_PERSONALITY/);
  assert.throws(() => createCommunicationPolicy({ initiative: 'unknown' }), /JEV_INITIATIVE/);
});

test('corrupt saved personality falls back without losing a valid saved initiative', t => {
  const { file } = settings(t);
  fs.writeFileSync(file, JSON.stringify({ personality: '__proto__', initiative: 'full' }));
  const policy = createCommunicationPolicy({ file, personality: 'reserved', initiative: 'help' });
  assert.equal(policy.personality, 'reserved'); assert.equal(policy.initiative, 'full');
});
