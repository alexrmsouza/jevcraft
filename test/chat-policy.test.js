'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChatPolicy } = require('../src/chat-policy');

const context = (names = ['Jev', 'Alex'], from = 'Alex') => ({
  username: 'Jev', from, players: Object.fromEntries(names.map(name => [name, { username: name }])),
});
function fileFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev chat política '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'identity-chat-policy.json');
}

test('loopback defaults open; remote defaults auto without network calls', () => {
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]']) {
    const policy = createChatPolicy({ host });
    assert.equal(policy.status(context()).mode, 'open');
    assert.equal(policy.accept(context(['Jev', 'Alex', 'Sam'])), true);
  }
  const policy = createChatPolicy({ host: 'minecraft.example' });
  assert.equal(policy.status(context()).mode, 'auto');
  assert.equal(policy.accept(context()), true);
});

test('auto follows joins and departures and counts every other online player', () => {
  const policy = createChatPolicy({ host: 'remote.example' });
  assert.equal(policy.accept(context()), true);
  assert.equal(policy.accept(context(['Jev', 'Alex', 'OtherBot'])), false);
  assert.equal(policy.accept({ ...context(['Jev', 'Alex', 'OtherBot']), addressed: true }), true);
  assert.equal(policy.accept(context()), true);
  assert.equal(policy.status(context(['Jev', 'Alex', 'OtherBot'])).effective, 'named');
});

test('named preserves addressed messages, existing controls and clarification replies', () => {
  const policy = createChatPolicy({ host: 'localhost', mode: 'named' });
  assert.equal(policy.accept(context()), false);
  for (const key of ['addressed', 'control', 'clarification']) assert.equal(policy.accept({ ...context(), [key]: true }), true);
  for (const from of ['Jev', 'Unknown', '', null]) assert.equal(policy.accept({ ...context(), from, addressed: true, control: true, clarification: true }), false);
});

test('open still rejects the bot and speakers absent from the player list', () => {
  const policy = createChatPolicy({ host: 'localhost' });
  assert.equal(policy.accept(context()), true);
  assert.equal(policy.accept(context(['Jev', 'Alex'], 'Jev')), false);
  assert.equal(policy.accept(context(['Jev', 'Alex'], 'Server')), false);
  assert.equal(policy.accept({ ...context(), players: undefined }), false);
});

test('local commands change mode, query state and persist atomically', t => {
  const file = fileFixture(t), policy = createChatPolicy({ host: 'localhost', file });
  assert.equal(policy.handleCommand('hi Jev', context()), null);
  assert.equal(policy.handleCommand('!jev chat named', context()).changed, true);
  assert.equal(policy.status(context()).mode, 'named');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mode, 'named');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
  assert.equal(createChatPolicy({ host: 'localhost', file }).accept(context()), false);
  assert.match(policy.handleCommand('!jev chat', context()).message, /named/);
  assert.equal(policy.handleCommand('!jev chat open', context()).mode, 'open');
  assert.equal(policy.handleCommand('!jev chat auto', context()).mode, 'auto');
  assert.equal(policy.handleCommand('!jev chat named', context()).mode, 'named');
  assert.equal(policy.handleCommand('!jev chat open', context()).mode, 'open');
});

test('mutations require configured admins or the sole other player on loopback', () => {
  const local = createChatPolicy({ host: 'localhost' });
  assert.equal(local.handleCommand('!jev chat named', context(['Jev', 'Alex', 'Sam'])).changed, false);
  assert.equal(local.status(context()).mode, 'open');
  const remote = createChatPolicy({ host: 'remote.example' });
  assert.equal(remote.handleCommand('!jev chat open', context()).changed, false);
  assert.equal(remote.handleCommand('!jev chat', context()).handled, true);
  const admins = createChatPolicy({ host: 'localhost', admins: ' Sam, Admin ' });
  assert.equal(admins.handleCommand('!jev chat named', context()).changed, false);
  assert.equal(admins.handleCommand('!jev chat named', context(['Jev', 'Sam'], 'Sam')).changed, true);
  const array = createChatPolicy({ host: 'remote.example', admins: ['Alex'] });
  assert.equal(array.handleCommand('!jev chat open', context()).changed, true);
});

test('commands from own bot or unknown speakers are consumed without a reply', () => {
  const policy = createChatPolicy({ host: 'localhost', admins: ['Unknown', 'Jev'] });
  for (const from of ['Unknown', 'Jev']) {
    assert.deepEqual(policy.handleCommand('!jev chat named', context(['Jev', 'Alex'], from)), {
      handled: true, changed: false, message: null, ...policy.status(context()),
    });
  }
  assert.equal(policy.status(context()).mode, 'open');
});

test('invalid commands do not change mode or persistence', t => {
  const file = fileFixture(t), policy = createChatPolicy({ host: 'localhost', file });
  for (const text of ['!jev chat nonsense', '!jev chat open extra', '!jev chat open agora', '!jev chat constructor', '!jev chat __proto__']) {
    assert.equal(policy.handleCommand(text, context()).changed, false);
    assert.equal(policy.status(context()).mode, 'open');
    assert.equal(fs.existsSync(file), false);
  }
  assert.equal(policy.handleCommand('!jev chatter named', context()), null);
  assert.throws(() => createChatPolicy({ host: 'localhost', mode: 'typo' }), /JEV_CHAT_MODE/);
});

test('explicit deployment mode wins persisted settings and command mutation', t => {
  const file = fileFixture(t);
  fs.writeFileSync(file, JSON.stringify({ mode: 'named' }));
  const policy = createChatPolicy({ host: 'remote.example', file, mode: 'open', admins: ['Alex'] });
  assert.equal(policy.status(context()).source, 'env');
  assert.equal(policy.accept(context(['Jev', 'Alex', 'Sam'])), true);
  const result = policy.handleCommand('!jev chat auto', context());
  assert.equal(result.changed, false);
  assert.match(result.message, /JEV_CHAT_MODE/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mode, 'named');
});

test('invalid saved state is ignored without overwriting it; failed save keeps active mode', t => {
  const file = fileFixture(t);
  fs.writeFileSync(file, '{broken');
  const policy = createChatPolicy({ host: 'localhost', file });
  assert.equal(policy.status(context()).mode, 'open');
  fs.mkdirSync(`${file}.directory`);
  const failed = createChatPolicy({ host: 'localhost', file: `${file}.directory` });
  const result = failed.handleCommand('!jev chat named', context());
  assert.equal(result.changed, false);
  assert.equal(failed.status(context()).mode, 'open');
  assert.match(result.message, /save/i);
});

test('chat command names stay English while replies follow the selected language', () => {
  const policy = createChatPolicy({ host: 'localhost' });
  const english = context(), portuguese = { ...context(), language: 'pt-BR' };
  assert.match(policy.handleCommand('!jev chat', english).message, /effective: open/);
  assert.match(policy.handleCommand('!jev chat', portuguese).message, /efetivo: open/);
  assert.match(policy.handleCommand('!jev chat named', portuguese).message, /configurado/);
  for (const mode of ['nome', 'aberto']) {
    const result = policy.handleCommand(`!jev chat ${mode}`, portuguese);
    assert.equal(result.changed, false); assert.equal(result.mode, 'named'); assert.match(result.message, /open\|named\|auto/);
  }
  assert.match(policy.handleCommand('!jev chat open', english).message, /configured/);
});
