'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { createPlanner } = require('../src/planner');

async function fixture(t, { planner, saved, legacy, initialPaused = true, reactive, host = 'test', chatMode, chatAdmins, language, narration, communication,
  personality, initiative, companionNow, stateDirectory } = {}) {
  for (const [key, value] of [['JEV_CHAT_MODE', chatMode], ['JEV_CHAT_ADMINS', chatAdmins], ['JEV_LANGUAGE', language], ['JEV_NARRATION', narration],
    ['JEV_PERSONALITY', personality], ['JEV_INITIATIVE', initiative]]) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const directory = stateDirectory || fs.mkdtempSync(path.join(os.tmpdir(), 'jev-planner-session-'));
  const file = path.join(directory, `${host}-1-Jev.json`), said = [], launches = [], scans = [], pluginWaitFlags = [];
  const communicationFile = path.join(directory, `${host}-1-Jev-communication.json`);
  if (communication) fs.writeFileSync(communicationFile, JSON.stringify(communication));
  if (saved) fs.writeFileSync(file, JSON.stringify({ version: 1, from: 'Alex', request: 'previous work', createdAt: new Date().toISOString(), ...saved }));
  const bot = Object.assign(new EventEmitter(), {
    username: 'Jev', version: '26.1', isAlive: true, health: 20, food: 20, oxygenLevel: 20,
    registry: require('minecraft-data')('26.1'),
    entity: { id: 1, position: new Vec3(2.5, 64, 3.5), yaw: 0, pitch: 0 }, entities: {},
    game: { dimension: 'overworld', gameMode: 'survival' }, time: { timeOfDay: 1000 },
    inventory: { items: () => [{ name: 'oak_log', count: 3 }, { name: 'oak_log', count: 4 }] },
    players: { Alex: { username: 'Alex', uuid: 'alex' }, Other: { username: 'Other', uuid: 'other' } },
    blockAt: p => ({ name: p.x === 5 ? 'birch_log' : 'air', position: p, boundingBox: p.x === 5 ? 'block' : 'empty' }),
    findBlocks: options => { scans.push(options); return [new Vec3(5, 64, 3)]; },
    loadPlugin: plugin => { pluginWaitFlags.push(bot._waitingForRequest); plugin(bot); }, waitForChunksToLoad: async () => {},
    clearControlStates() {}, swingArm() {}, stopDigging() {}, deactivateItem() {},
    pathfinder: { setMovements() {}, setGoal() {}, movements: { blocksCantBreak: new Set(), blocksToAvoid: new Set(), exclusionAreasStep: [], exclusionAreasPlace: [], exclusionAreasBreak: [] } },
    chat: message => said.push(String(message)), quit() { bot.emit('end'); },
    _client: new EventEmitter(),
  });
  const work = require('../src/work'), mineflayer = require('mineflayer');
  t.mock.method(mineflayer, 'createBot', () => bot);
  const survival = { state: { paused: initialPaused }, step: async () => {} }, completions = [], idleCalls = [], steps = [];
  t.mock.method(work, 'createSurvival', () => survival);
  t.mock.method(work, 'runGoal', (b, task, goal, store, options) => new Promise((resolve, reject) => {
    launches.push(goal); const cancel = task.cancel.bind(task); task.cancel = () => { cancel(); resolve(); };
    steps.push(patch => { Object.assign(goal, patch); store.save(goal); options?.onStep?.(goal); });
    completions.push(error => { if (error) reject(error); else { goal.status = 'complete'; store.save(goal); resolve(); } });
  }));
  t.mock.method(work, 'runIdle', async () => { idleCalls.push(true); });
  const joinReads = []; t.mock.method(require('../src/lava-escape'), 'settleAfterJoin', async () => { joinReads.push(true); });
  if (legacy) t.mock.method(require('../src/objectives'), 'interpret', legacy);
  if (reactive) t.mock.method(require('../src/reactive-wait'), 'createReactiveWait', () => reactive);
  t.mock.method(console, 'log', () => {});
  const errors = []; t.mock.method(console, 'error', error => errors.push(error));
  const key = require.resolve('../src/session'); delete require.cache[key];
  const { createSession } = require('../src/session');
  const session = createSession({ host, port: 1, username: 'Jev' }, {}, { stateDirectory: directory, runLedger: null, planner, companionNow });
  t.after(async () => { session.shutdown(); await session.closed; await new Promise(resolve => setImmediate(resolve)); delete require.cache[key]; fs.rmSync(directory, { recursive: true, force: true }); });
  bot.emit('spawn');
  await settle();
  return { bot, said, launches, scans, errors, session, survival, idleCalls, joinReads, pluginWaitFlags, directory,
    policyFile: path.join(directory, `${host}-1-Jev-chat-policy.json`), communicationFile,
    finish: error => completions.at(-1)(error),
    step: patch => steps.at(-1)(patch),
    send: (message, sender = 'alex') => bot._client.emit('playerChat', { sender, plainMessage: message }), read: () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 25));
const output = patch => ({ kind: 'obtain', item: 'birch_log', count: 16, deliver: false, message: 'Vou coletar 16 troncos.', options: [], ...patch });
function plannerFixture(value = output()) {
  const calls = []; const planner = createPlanner({ client: { respond: async request => { calls.push(request); return { text: JSON.stringify(value) }; } } });
  return { planner, calls };
}

test('planner mode waits on startup instead of running idle or join survival decisions', async t => {
  const { planner, calls } = plannerFixture(); const f = await fixture(t, { planner, initialPaused: false });
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(f.idleCalls.length, 0); assert.equal(f.joinReads.length, 0); assert.equal(calls.length, 0);
  assert.equal(f.survival.state.paused, true); assert.equal(f.launches.length, 0);
  assert.equal(f.bot._waitingForRequest, true); assert(f.pluginWaitFlags.every(value => value === true));
});

test('planner reconnect leaves saved running work parked until an explicit resume', async t => {
  const { planner } = plannerFixture(); const f = await fixture(t, { planner, initialPaused: false,
    saved: { kind: 'obtain', item: 'oak_log', count: 16, status: 'running' } });
  assert.equal(f.launches.length, 0); assert.equal(f.survival.state.paused, true);
  f.send('Jev retome'); await settle();
  assert.equal(f.launches.length, 1); assert.equal(f.survival.state.paused, false);
  assert.equal(f.bot._waitingForRequest, false);
});

for (const ending of ['complete', 'blocked']) test(`a planner task that becomes ${ending} returns to waiting instead of idle`, async t => {
  const { planner } = plannerFixture(); const f = await fixture(t, { planner, initialPaused: false });
  f.send('Jev colete 16 troncos'); await settle();
  assert.equal(f.launches.length, 1); assert.equal(f.survival.state.paused, false);
  assert.equal(f.bot._waitingForRequest, false);
  f.finish(ending === 'blocked' ? new Error('Fixture task failed') : undefined); await settle();
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(f.survival.state.paused, true); assert.equal(f.idleCalls.length, 0);
  assert.equal(f.bot._waitingForRequest, true);
  f.send('Jev colete mais troncos'); await settle();
  assert.equal(f.launches.length, 2); assert.equal(f.survival.state.paused, false);
  assert.equal(f.bot._waitingForRequest, false);
});

test('resume with no saved task keeps planner mode waiting', async t => {
  const { planner, calls } = plannerFixture(); const f = await fixture(t, { planner });
  f.send('Jev resume'); await settle();
  assert.equal(f.survival.state.paused, true); assert.equal(f.launches.length, 0); assert.equal(calls.length, 0);
  assert.equal(f.bot._waitingForRequest, true);
});

test('stop during a tactical safety retry leaves planner mode waiting', async t => {
  const { planner } = plannerFixture(); const f = await fixture(t, { planner });
  f.send('Jev colete 16 troncos'); await settle();
  f.finish(Object.assign(new Error('Fixture safety interruption'), { name: 'NeedsSafety' })); await settle();
  f.send('Jev pare');
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(f.launches.length, 1); assert.equal(f.survival.state.paused, true); assert.equal(f.idleCalls.length, 0);
  assert.equal(f.bot._waitingForRequest, true);
});

test('legacy mode still resumes running work and performs join survival handling', async t => {
  const f = await fixture(t, { initialPaused: false, saved: { kind: 'obtain', item: 'oak_log', count: 1, status: 'running' } });
  assert.equal(f.joinReads.length, 1); assert.equal(f.launches.length, 1);
  assert.equal(f.bot._waitingForRequest, false); assert(f.pluginWaitFlags.every(value => value === false));
});

test('legacy mode still starts the autonomous idle loop when it has no work', async t => {
  const f = await fixture(t, { initialPaused: false });
  await new Promise(resolve => setTimeout(resolve, 550));
  assert(f.idleCalls.length > 0); assert.equal(f.survival.state.paused, false);
  assert.equal(f.bot._waitingForRequest, false);
});

test('planner waiting polls only the restricted reactive controller and never the OpenAI planner', async t => {
  let ticks = 0; const reactive = { tick: async () => { ticks++; }, cancel: async () => {} };
  const { planner, calls } = plannerFixture(); const f = await fixture(t, { planner, initialPaused: false, reactive });
  await new Promise(resolve => setTimeout(resolve, 550));
  assert(ticks > 0); assert.equal(calls.length, 0); assert.equal(f.idleCalls.length, 0);
});

test('new requested work waits for reactive defense cancellation before launching', async t => {
  let release, cancelled = false;
  const reactive = { tick: async () => {}, cancel: async () => { cancelled = true; await new Promise(resolve => { release = resolve; }); } };
  const { planner } = plannerFixture(); const f = await fixture(t, { planner, reactive });
  f.send('Jev colete troncos'); await settle();
  assert(cancelled); assert.equal(f.launches.length, 0);
  reactive.cancel = async () => {}; release(); await settle();
  assert.equal(f.launches.length, 1); assert.equal(f.bot._waitingForRequest, false);
});

test('a pending conversational model response does not suspend reactive defense', async t => {
  let ticks = 0, release;
  const planner = { interpret: async () => new Promise(resolve => { release = resolve; }) };
  const reactive = { tick: async () => { ticks++; }, cancel: async () => {} };
  const f = await fixture(t, { planner, reactive }); f.send('Jev como vai?');
  await new Promise(resolve => setTimeout(resolve, 550));
  assert(release); assert(ticks > 0); assert.equal(f.launches.length, 0);
  release({ kind: 'other', message: 'Olá!' }); await settle();
  assert(f.said.includes('Olá!')); assert.equal(f.bot._waitingForRequest, true);
});

for (const kind of ['chat', 'clarify']) test(`${kind} while waiting does not enable survival or reflex actions`, async t => {
  const { planner } = plannerFixture(output({ kind, item: null, count: null, deliver: null, message: 'Qual madeira?', options: [] }));
  const f = await fixture(t, { planner });
  f.send('Jev qual madeira?'); await settle();
  assert.equal(f.bot._waitingForRequest, true); assert.equal(f.survival.state.paused, true); assert.equal(f.launches.length, 0);
});

test('planner activity epochs change for replacement, completion, stop and a subsequent request', async t => {
  const { planner } = plannerFixture(); const f = await fixture(t, { planner });
  const joined = f.bot._requestActivityEpoch; assert(Number.isSafeInteger(joined));
  f.send('Jev colete troncos'); await settle(); const working = f.bot._requestActivityEpoch;
  assert(working > joined);
  f.send('Jev colete mais troncos'); await settle(); const replaced = f.bot._requestActivityEpoch;
  assert(replaced > working); assert.equal(f.bot._waitingForRequest, false);
  f.finish(); await settle(); const completed = f.bot._requestActivityEpoch;
  assert(completed > replaced); assert.equal(f.bot._waitingForRequest, true);
  f.send('Jev colete troncos'); await settle(); const beforeStop = f.bot._requestActivityEpoch;
  f.send('Jev pare'); const stopped = f.bot._requestActivityEpoch;
  assert(stopped > beforeStop);
  f.send('Jev colete troncos novamente'); await settle();
  assert(f.bot._requestActivityEpoch > stopped); assert.equal(f.bot._waitingForRequest, false);
});

test('finishing old work invalidates reflex activity without discarding a pending new player request', async t => {
  let calls = 0, release; const planner = { interpret: async (request, from) => {
    const spec = { request, from, kind: 'obtain', item: 'birch_log', count: 16, deliver: false, message: 'Vou coletar.' };
    if (calls++ === 0) return spec;
    return new Promise(resolve => { release = () => resolve(spec); });
  } };
  const f = await fixture(t, { planner }); f.send('Jev primeiro pedido'); await settle();
  f.send('Jev próximo pedido'); await settle(); assert(release);
  const previous = f.bot._requestActivityEpoch; f.finish(); await settle();
  assert(f.bot._requestActivityEpoch > previous); assert.equal(f.bot._waitingForRequest, true);
  release(); await settle();
  assert.equal(f.launches.length, 2); assert.equal(f.launches[1].request, 'Jev próximo pedido');
  assert.equal(f.bot._waitingForRequest, false);
});

test('Portuguese collection reaches the existing executor with a bounded observed snapshot', async t => {
  const { planner, calls } = plannerFixture(); const f = await fixture(t, { planner });
  f.send('Jev colete 16 troncos'); await settle();
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0].item, 'birch_log'); assert.equal(f.launches[0].count, 16);
  assert.equal(f.launches[0].from, 'Alex'); assert.equal(f.launches[0].request, 'Jev colete 16 troncos');
  assert.equal(f.bot._waitingForRequest, false);
  const snapshot = JSON.parse(calls[0].input);
  assert.equal(snapshot.inventory.oak_log, 7); assert.equal(snapshot.gameMode, 'survival'); assert.equal(snapshot.dimension, 'overworld');
  assert.deepEqual(snapshot.nearbyBlocks, ['birch_log']); assert.equal(f.scans.at(-1).maxDistance, 16); assert.equal(f.scans.at(-1).count, 16);
  assert(f.said.includes('Vou coletar 16 troncos.'));
});

for (const kind of ['chat', 'clarify', 'invalid']) test(`${kind} preserves the active task without pausing survival`, async t => {
  const value = kind === 'invalid' ? output({ count: 1025 }) : output({ kind, item: null, count: null, deliver: null, message: kind === 'chat' ? 'Olá!' : 'Qual madeira?', options: kind === 'clarify' ? ['carvalho', 'bétula'] : [] });
  const { planner } = plannerFixture(value); const f = await fixture(t, { planner });
  f.send('Jev retome'); await settle();
  // Start a valid goal through the planner, then switch its next response.
  const { planner: initial } = plannerFixture(); const interpret = planner.interpret.bind(planner); let first = true;
  planner.interpret = (...args) => first ? (first = false, initial.interpret(...args)) : interpret(...args);
  f.send('Jev colete troncos'); await settle(); const previous = f.launches[0];
  assert(previous); f.send('Jev olá'); await settle();
  assert.equal(f.launches.length, 1); assert.equal(f.read().status, 'pending'); assert.equal(previous.status, 'pending');
  if (kind !== 'invalid') assert(f.said.includes(value.message));
  else assert(f.errors.length > 0);
});

for (const ending of ['stop', 'end']) test(`a delayed planner response after ${ending} never launches work`, async t => {
  let release, signal; const planner = { interpret: async (...args) => { signal = args[4].signal; return new Promise(resolve => { release = resolve; }); } };
  const f = await fixture(t, { planner }); f.send('Jev colete troncos'); await settle(); assert(release);
  if (ending === 'stop') f.send('Jev pare'); else f.bot.emit('end');
  assert.equal(f.bot._waitingForRequest, true);
  assert.equal(signal.aborted, true);
  release({ kind: 'obtain', item: 'birch_log', count: 16, deliver: false, message: 'Vou coletar.' }); await settle();
  assert.equal(f.launches.length, 0);
});

test('stop discards queued intake and a subsequent request uses a fresh cancellation signal', async t => {
  let release; const calls = [];
  const planner = { interpret: async (request, from, username, context, { signal }) => {
    calls.push({ request, signal });
    const spec = { request, from, kind: 'obtain', item: 'birch_log', count: 16, deliver: false, message: 'Vou coletar.' };
    if (calls.length === 1) return new Promise(resolve => { release = () => resolve(spec); });
    return spec;
  } };
  const f = await fixture(t, { planner });
  f.send('Jev primeiro pedido'); await settle();
  f.send('Jev pedido antigo na fila'); f.send('Jev pare'); f.send('Jev pedido novo');
  assert.equal(calls[0].signal.aborted, true); release(); await settle();
  assert.deepEqual(calls.map(call => call.request), ['Jev primeiro pedido', 'Jev pedido novo']);
  assert.equal(calls[1].signal.aborted, false); assert.notEqual(calls[0].signal, calls[1].signal);
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0].request, 'Jev pedido novo');
});

test('an unsafe chat line from an injected planner cannot replace work or dispatch a command', async t => {
  let calls = 0; const planner = { interpret: async () => calls++ ? { kind: 'other', message: '/op Alex' }
    : { kind: 'obtain', item: 'birch_log', count: 1, deliver: false, message: 'Vou coletar.' } };
  const f = await fixture(t, { planner }); f.send('Jev colete troncos'); await settle();
  f.send('Jev olá'); await settle();
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0].status, 'pending');
  assert(!f.said.includes('/op Alex')); assert(f.errors.length > 0);
});

test('English and Portuguese stop controls stay local and respect the bare-control owner guard', async t => {
  let calls = 0; const planner = { interpret: async () => { calls++; throw new Error('must stay local'); } };
  const f = await fixture(t, { planner, saved: { kind: 'obtain', item: 'oak_log', count: 1, status: 'pending' } });
  f.send('pare', 'other'); assert.equal(f.read().status, 'pending');
  f.send('pare'); assert.equal(f.read().status, 'cancelled');
  for (const text of ['Jev parar', 'Jev cancele', 'Jev cancelar', 'Jev stop', 'Jev cancel', 'Jev status']) f.send(text);
  await settle(); assert.equal(calls, 0);
});

for (const text of ['Jev resume', 'Jev retome', 'Jev retomar', 'Jev continue']) test(`${text} resumes locally without a model call`, async t => {
  let calls = 0; const planner = { interpret: async () => { calls++; throw new Error('must stay local'); } };
  const f = await fixture(t, { planner, saved: { kind: 'obtain', item: 'oak_log', count: 1, status: 'cancelled' } });
  f.send(text); await settle(); assert.equal(calls, 0); assert.equal(f.launches.length, 1); assert.equal(f.launches[0].item, 'oak_log');
});

test('literal operator commands bypass the planner', async t => {
  let calls = 0; const f = await fixture(t, { planner: { interpret: async () => { calls++; } } });
  f.send('Jev /time set day'); await settle(); assert.equal(calls, 0); assert.equal(f.launches.length, 0);
  assert(f.said.some(line => /not enabled/.test(line)));
});

test('with no planner the legacy interpreter still receives ordinary requests', async t => {
  let calls = 0;
  const f = await fixture(t, { legacy: async () => { calls++; return { kind: 'other' }; } });
  f.send('Jev hello'); await settle(); assert.equal(calls, 1); assert.equal(f.launches.length, 0);
  assert(f.said.some(line => /Ask for items/.test(line)));
});

test('an impossible goal is rejected before replacing the active task', async t => {
  let calls = 0; const planner = { interpret: async () => ({ kind: 'obtain', item: calls++ ? 'bedrock' : 'birch_log', count: 1, deliver: false, message: 'Vou coletar.' }) };
  const f = await fixture(t, { planner }); f.send('Jev colete troncos'); await settle(); const previous = f.launches[0];
  assert(previous); f.send('Jev colete bedrock'); await settle();
  assert.equal(f.launches.length, 1); assert.equal(previous.status, 'pending');
});

test('loopback planner chat is open by default and accepts a request without the bot name', async t => {
  const { planner, calls } = plannerFixture(); const f = await fixture(t, { planner, host: 'localhost' });
  f.send('colete 16 troncos'); await settle();
  assert.equal(calls.length, 1); assert.equal(f.launches.length, 1); assert.equal(f.launches[0].count, 16);
});

test('named chat mode requires the bot name for ordinary player requests', async t => {
  const { planner, calls } = plannerFixture(); const f = await fixture(t, { planner, host: 'localhost', chatMode: 'named' });
  f.send('colete 16 troncos'); await settle(); assert.equal(calls.length, 0);
  f.send('Jev colete 16 troncos'); await settle(); assert.equal(calls.length, 1);
});

test('auto chat opens with one other player and requires a name when more players are present', async t => {
  const { planner, calls } = plannerFixture(); const f = await fixture(t, { planner, chatMode: 'auto' });
  f.send('colete 16 troncos'); await settle(); assert.equal(calls.length, 0);
  delete f.bot.players.Other; f.send('colete 16 troncos'); await settle(); assert.equal(calls.length, 1);
});

test('local chat policy commands bypass the planner, persist changes and preserve active work', async t => {
  const { planner, calls } = plannerFixture(); const f = await fixture(t, { planner, host: 'localhost', chatAdmins: 'Alex' });
  const before = f.said.length; f.send('!jev chat'); await settle();
  assert(f.said.length > before); assert.equal(calls.length, 0);
  f.send('!jev chat named'); await settle(); assert.equal(calls.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.policyFile, 'utf8')).mode, 'named');
  f.send('colete troncos'); await settle(); assert.equal(calls.length, 0);
  f.send('Jev colete troncos'); await settle(); assert.equal(f.launches.length, 1);
  const active = f.launches[0]; f.send('!jev chat open'); await settle();
  assert.equal(calls.length, 1); assert.equal(f.launches.length, 1); assert.equal(active.status, 'pending');
});

test('open chat still ignores the bot own player packets and protects bare stop ownership', async t => {
  const { planner, calls } = plannerFixture(); const f = await fixture(t, { planner, host: 'localhost' });
  f.bot.players.Jev = { username: 'Jev', uuid: 'jev' };
  f.send('colete 16 troncos', 'jev'); await settle(); assert.equal(calls.length, 0);
  f.send('colete 16 troncos'); await settle(); const active = f.launches[0];
  f.send('pare', 'other'); await settle(); assert.equal(active.status, 'pending');
  f.send('pare'); await settle(); assert.equal(active.status, 'cancelled'); assert.equal(calls.length, 1);
});

test('legacy mode keeps named intake even with an open chat policy environment', async t => {
  let calls = 0; const f = await fixture(t, { host: 'localhost', chatMode: 'open', legacy: async () => { calls++; return { kind: 'other' }; } });
  f.send('hello'); await settle(); assert.equal(calls, 0); assert.equal(fs.existsSync(f.policyFile), false);
});

for (const provider of ['planner', 'legacy']) test(`local communication commands bypass ${provider} and keep active work`, async t => {
  let calls = 0; const interpret = async () => { calls++; throw Error('No model for local configuration'); };
  const f = await fixture(t, { host: 'localhost', chatAdmins: 'Alex', saved: { kind: 'obtain', item: 'oak_log', count: 1, status: 'cancelled' },
    ...(provider === 'planner' ? { planner: { interpret } } : { legacy: interpret }) });
  f.send('Jev resume'); await settle(); const active = f.launches[0]; assert(active);
  const epoch = f.bot._requestActivityEpoch;
  for (const command of ['!jev language pt-BR', '!jev narration off', '!jev language', '!jev narration']) f.send(command);
  await settle();
  assert.equal(calls, 0); assert.equal(f.launches.length, 1); assert.equal(active.status, 'cancelled');
  assert.equal(f.bot._requestActivityEpoch, epoch); assert.equal(f.bot._jevLanguage, 'pt-BR'); assert.equal(f.bot._jevNarration, 'off');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.communicationFile, 'utf8')), { version: 1, language: 'pt-BR', narration: 'off' });
  assert(f.said.some(line => /Idioma.*pt-BR/i.test(line))); assert(f.said.some(line => /Narração.*off/i.test(line)));
});

test('persisted communication settings override environment defaults on reconnect', async t => {
  const f = await fixture(t, { planner: { interpret: async () => {} }, language: 'en-US', narration: 'full', communication: { language: 'pt-BR', narration: 'off' } });
  assert.equal(f.bot._jevLanguage, 'pt-BR'); assert.equal(f.bot._jevNarration, 'off'); assert.deepEqual(f.said, []);
});

test('selected communication language reaches the planner and follows live language changes', async t => {
  const { planner, calls } = plannerFixture(); const f = await fixture(t, { planner, language: 'pt-BR', chatAdmins: 'Alex' });
  f.send('Jev colete troncos'); await settle(); assert.equal(JSON.parse(calls[0].input).language, 'pt-BR');
  f.send('!jev language en-US'); f.send('Jev collect logs'); await settle(); assert.equal(JSON.parse(calls[1].input).language, 'en-US');
});

test('narration off suppresses unsolicited startup and async errors but keeps direct localized status and stop replies', async t => {
  const { planner } = plannerFixture(); const f = await fixture(t, { planner, language: 'pt-BR', narration: 'off' });
  assert.deepEqual(f.said, []); f.send('Jev colete troncos'); await settle(); const before = f.said.length;
  f.finish(Object.assign(Error('No route from here'), { name: 'NoRoute' })); await settle(); assert.equal(f.said.length, before);
  f.send('Jev status'); f.send('Jev stop'); await settle();
  assert(f.said.some(line => /Parei a tarefa/.test(line))); assert(f.said.length >= before + 2);
});

test('important narration suppresses startup progress but permits localized help after conversational quiet', async t => {
  let clock = Date.parse('2026-10-26T12:00:00Z');
  const { planner } = plannerFixture(); const f = await fixture(t, { planner, language: 'pt-BR', narration: 'important', companionNow: () => clock });
  assert.deepEqual(f.said, []); f.send('Jev colete troncos'); await settle(); const before = f.said.length;
  f.finish(Object.assign(Error('No route from here'), { name: 'NoRoute' })); await settle();
  assert.equal(f.said.length, before);
  clock += 6000; f.session.companion.tick(); await settle(); assert(f.said.length > before);
  assert(!f.said.at(-1).includes('could not'));
});

test('communication mutation permission failures stay local and leave settings and work unchanged', async t => {
  const { planner, calls } = plannerFixture(); const f = await fixture(t, { planner, language: 'en-US', chatAdmins: 'Alex' });
  f.send('!jev language pt-BR', 'other'); f.send('!jev narration off', 'other'); await settle();
  assert.equal(calls.length, 0); assert.equal(f.bot._jevLanguage, 'en-US'); assert.equal(f.bot._jevNarration, 'full');
  assert(f.said.some(line => /permission|cannot change/i.test(line)));
});

test('Portuguese legacy task acknowledgements and dream queries use the selected language', async t => {
  let calls = 0;
  const legacy = async (client, request, from) => calls++ ? { kind: 'dream', dream: { operation: 'query' } }
    : { kind: 'obtain', request, from, item: 'diamond_sword', count: 1, deliver: false };
  const f = await fixture(t, { legacy, language: 'pt-BR' });
  f.send('Jev consiga uma espada'); await settle(); assert(f.said.some(line => /Vou conseguir 1 Espada de Diamante/.test(line)));
  f.send('Jev qual seu sonho'); await settle(); assert(f.said.some(line => /Ainda não tenho um sonho/.test(line)));
});

const suspendedBuild = () => ({ kind: 'obtain', item: 'oak_log', count: 1, status: 'complete', suspendedTasks: [
  { kind: 'build', request: 'build the earlier tower', from: 'Alex', status: 'blocked', waitingOn: { x: 5, y: 64, z: 3, name: 'bedrock', dimension: 'overworld' } },
] });
for (const narration of ['off', 'important', 'full']) test(`automatic resume of older suspended work honors ${narration} narration`, async t => {
  const f = await fixture(t, { saved: suspendedBuild(), language: 'pt-BR', narration }); const before = f.said.length;
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0].request, 'build the earlier tower');
  const automatic = f.said.slice(before);
  if (narration === 'off') assert.deepEqual(automatic, []);
  else { assert.equal(automatic.length, 2); assert.match(automatic[0], /saiu do caminho/); assert.match(automatic[1], /Voltando à sua tarefa anterior/); }
});

test('explicit resume of older suspended work remains a direct reply with narration off', async t => {
  const f = await fixture(t, { saved: suspendedBuild(), language: 'pt-BR', narration: 'off' });
  f.send('Jev resume'); await settle(); assert.equal(f.launches.length, 1);
  assert(f.said.some(line => /Voltando à sua tarefa anterior/.test(line)));
});

function contextualPlanner(replies) {
  const calls = [];
  const planner = createPlanner({ client: { respond: async request => {
    calls.push({ ...request, snapshot: JSON.parse(request.input) });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    return { text: JSON.stringify(output(reply)) };
  } } });
  return { planner, calls };
}

test('postponing a clarification dismisses both question routes instead of reviving it from a later option', async t => {
  const { planner, calls } = contextualPlanner([
    { kind: 'clarify', item: null, count: null, deliver: null, message: 'Oak or birch?', options: ['oak_log', 'birch_log'] },
    {},
  ]);
  const f = await fixture(t, { planner });
  f.send('Jev collect logs'); await settle();
  f.send('later'); await settle();
  assert.equal(f.session.companion.dialogue.pending('Alex'), null);
  f.send('birch_log'); await settle();
  assert.equal(calls.length, 1);
  assert.equal(f.launches.length, 0);
});

test('planner conversations remember both sides across requests and keep unrelated player chat private', async t => {
  const { planner, calls } = contextualPlanner([
    { kind: 'chat', item: null, count: null, deliver: null, message: 'Podemos usar madeira de carvalho.' },
    { kind: 'chat', item: null, count: null, deliver: null, message: 'Sim, era madeira de carvalho.' },
  ]);
  const f = await fixture(t, { planner, language: 'pt-BR' });
  f.send('Jev qual madeira devemos usar?'); await settle();
  f.send('private conversation between other players', 'other'); await settle();
  f.send('Jev qual foi sua sugestão?'); await settle();
  const context = calls.at(-1).snapshot.conversation;
  assert(context.recentMessages.some(message => message.role === 'player' && message.text.includes('qual madeira')));
  assert(context.recentMessages.some(message => message.role === 'bot' && message.text.includes('carvalho')));
  assert(!JSON.stringify(context).includes('private conversation'));
  assert.equal(f.launches.length, 0);
});

test('a later question receives the failed task and actual executor error as historical evidence', async t => {
  const { planner, calls } = contextualPlanner([
    {}, { kind: 'chat', item: null, count: null, deliver: null, message: 'Não encontrei um caminho seguro.' },
  ]);
  const f = await fixture(t, { planner, language: 'pt-BR' });
  f.send('Jev colete 16 troncos'); await settle();
  f.step({ status: 'running', step: { action: 'mine', item: 'birch_log' } });
  f.finish(Object.assign(new Error('No safe route to the requested tree'), { name: 'NoRoute' })); await settle();
  f.send('Jev por que você parou?'); await settle();
  const context = calls.at(-1).snapshot.conversation;
  assert(context.recentTasks.some(task => task.status === 'blocked' && /safe route/.test(task.error)));
  assert(context.recentEvents.some(event => event.action === 'mine'));
  assert.equal(f.launches.length, 1);
  assert.equal(f.bot._waitingForRequest, true);
});

test('conversation context survives reconnect while current empty inventory overrides pre-death possessions', async t => {
  const { planner, calls } = contextualPlanner([
    {}, { kind: 'chat', item: null, count: null, deliver: null, message: 'Perdi os itens quando morri.' },
  ]);
  const f = await fixture(t, { planner, language: 'pt-BR' });
  f.bot.inventory.slots = [];
  f.bot.inventory.slots[5] = { name: 'iron_helmet', count: 1 };
  f.send('Jev colete troncos'); await settle();
  f.bot.emit('death'); await f.session.closed; await settle();
  const next = await fixture(t, { planner, language: 'pt-BR', stateDirectory: f.directory });
  next.bot.inventory.items = () => [];
  next.bot.inventory.slots = [];
  next.send('Jev você ainda tem os troncos e o capacete?'); await settle();
  const snapshot = calls.at(-1).snapshot;
  assert.deepEqual(snapshot.inventory, {});
  assert.deepEqual(snapshot.equipment, []);
  assert(snapshot.conversation.recentEvents.some(event => event.type === 'death'));
  assert(snapshot.conversation.recentMessages.some(message => message.role === 'player' && message.text.includes('colete troncos')));
  assert.equal(next.launches.length, 0);
});

test('personality changes stay local, persist and reach the planner without replacing active work', async t => {
  const { planner, calls } = contextualPlanner([
    {}, { kind: 'chat', item: null, count: null, deliver: null, message: 'Tudo certo por aqui.' },
  ]);
  const f = await fixture(t, { planner, language: 'pt-BR', chatAdmins: 'Alex', personality: 'reserved', initiative: 'help' });
  f.send('Jev colete troncos'); await settle();
  assert.equal(calls[0].snapshot.personality, 'reserved');
  const active = f.launches[0], epoch = f.bot._requestActivityEpoch;
  f.send('!jev personality playful'); f.send('!jev initiative full'); await settle();
  assert.equal(calls.length, 1); assert.equal(f.launches.length, 1);
  assert.equal(f.bot._requestActivityEpoch, epoch);
  assert.equal(active.status, 'pending');
  assert.equal(JSON.parse(fs.readFileSync(f.communicationFile, 'utf8')).personality, 'playful');
  assert.equal(JSON.parse(fs.readFileSync(f.communicationFile, 'utf8')).initiative, 'full');
  f.send('Jev como está indo?'); await settle();
  assert.equal(calls.at(-1).snapshot.personality, 'playful');
  assert.equal(f.launches.length, 1);
});

test('a Portuguese ordinal answers the original clarification after reconnect without repeating the bot name', async t => {
  let clock = Date.parse('2026-10-26T12:00:00Z');
  const { planner, calls } = contextualPlanner([
    { kind: 'clarify', item: null, count: null, deliver: null, message: 'Você prefere carvalho ou bétula?', options: ['carvalho', 'bétula'] },
    { item: 'birch_log', count: 8, message: 'Vou coletar oito troncos de bétula.' },
  ]);
  const f = await fixture(t, { planner, language: 'pt-BR', companionNow: () => clock });
  f.send('Jev colete oito troncos para mim'); await settle();
  assert.equal(f.launches.length, 0);
  f.session.shutdown(); await f.session.closed; await settle();
  clock += 1000;
  const next = await fixture(t, { planner, language: 'pt-BR', companionNow: () => clock, stateDirectory: f.directory });
  next.send('a segunda'); await settle();
  assert.equal(calls.length, 2);
  assert.match(calls[1].snapshot.request, /colete oito troncos/);
  assert.match(calls[1].snapshot.request, /bétula/);
  assert.equal(next.launches.length, 1);
  assert.equal(next.launches[0].count, 8);
});

test('repeated executor errors pause once, request useful help, and preserve reactive waiting', async t => {
  let clock = Date.parse('2026-10-26T12:00:00Z'), ticks = 0;
  const reactive = { tick: async () => { ticks++; }, cancel: async () => {} };
  const { planner, calls } = contextualPlanner([{}]);
  const f = await fixture(t, { planner, language: 'pt-BR', reactive, companionNow: () => clock });
  f.send('Jev colete dezesseis troncos'); await settle();
  for (let failures = 1; failures <= 3; failures++) {
    clock += 1000;
    f.step({ status: 'running', step: { action: 'mine', item: 'birch_log' }, lastError: 'No safe route to the requested tree', failures,
      updatedAt: new Date(clock).toISOString() });
    await settle();
  }
  assert.equal(f.read().status, 'blocked');
  assert.equal(f.bot._waitingForRequest, true);
  assert.equal(f.survival.state.paused, true);
  clock += 5000;
  f.session.companion.tick(); await settle();
  const pending = f.session.companion.dialogue.pending('Alex');
  assert.equal(pending.kind, 'help');
  assert.equal(pending.goalId, f.launches[0].memoryId);
  const afterHelp = f.said.length;
  for (let count = 0; count < 10; count++) { clock += 31000; f.session.companion.tick(); }
  assert.equal(f.said.length, afterHelp, 'the same blockage does not produce reminders');
  await new Promise(resolve => setTimeout(resolve, 550));
  assert(ticks > 0);
  assert.equal(calls.length, 1);
  assert.equal(f.launches.length, 1);
});

test('no measurable progress pauses a task using the observed clock instead of retrying forever', async t => {
  let clock = Date.parse('2026-10-26T12:00:00Z');
  const { planner } = contextualPlanner([{}]);
  const f = await fixture(t, { planner, companionNow: () => clock });
  f.send('Jev collect logs'); await settle();
  f.step({ status: 'running', step: { action: 'mine', item: 'birch_log' } });
  clock += 180001;
  f.session.companion.tick(); await settle();
  assert.equal(f.read().status, 'blocked');
  assert.equal(f.read().helpReason, 'no_progress');
  assert.equal(f.bot._waitingForRequest, true);
  assert.equal(f.session.companion.dialogue.pending('Alex').kind, 'help');
});

test('help acknowledgment waits for assistance, another player cannot answer it, and the owner explicitly resumes', async t => {
  let clock = Date.parse('2026-10-26T12:00:00Z');
  const { planner, calls } = contextualPlanner([{}]);
  const f = await fixture(t, { planner, language: 'pt-BR', companionNow: () => clock });
  f.send('Jev colete troncos'); await settle();
  f.finish(new Error('No safe route')); await settle();
  clock += 6000; f.session.companion.tick(); await settle();
  assert.equal(f.session.companion.dialogue.pending('Alex').kind, 'help');
  f.send('pode continuar', 'other'); await settle();
  assert.equal(f.launches.length, 1);
  f.send('sim'); await settle();
  assert.equal(f.launches.length, 1, 'agreeing to help is not proof the problem was fixed');
  assert.equal(f.session.companion.dialogue.pending('Alex').kind, 'help');
  f.send('pode continuar'); await settle();
  assert.equal(f.launches.length, 2);
  assert.equal(calls.length, 1, 'answering help uses the saved task, without another planner call');
  assert.equal(f.bot._waitingForRequest, false);
});

test('a new task invalidates old help so a later yes cannot resume the replaced task', async t => {
  let clock = Date.parse('2026-10-26T12:00:00Z');
  const { planner, calls } = contextualPlanner([{}, { item: 'oak_log', count: 4 }]);
  const f = await fixture(t, { planner, companionNow: () => clock });
  f.send('Jev collect birch logs'); await settle();
  f.finish(new Error('No safe route')); await settle();
  clock += 6000; f.session.companion.tick(); await settle();
  assert.equal(f.session.companion.dialogue.pending('Alex').kind, 'help');
  f.send('Jev collect four oak logs instead'); await settle();
  assert.equal(f.launches.length, 2);
  assert.equal(f.launches.at(-1).item, 'oak_log');
  assert.equal(f.session.companion.dialogue.pending('Alex'), null);
  f.send('sim'); await settle();
  assert.equal(f.launches.length, 2);
  assert.equal(calls.length, 2);
});

test('full initiative offers an observed completed item and waits for owner consent before delivery', async t => {
  let clock = Date.parse('2026-10-26T12:00:00Z');
  const { planner, calls } = contextualPlanner([
    { item: 'oak_log', count: 4 }, { item: 'oak_log', count: 4, deliver: true, message: 'Vou levar os troncos até você.' },
  ]);
  const f = await fixture(t, { planner, language: 'pt-BR', initiative: 'full', companionNow: () => clock });
  f.send('Jev colete quatro troncos de carvalho'); await settle();
  f.finish(); await settle();
  clock += 6000; f.session.companion.tick(); await settle();
  assert.equal(f.session.companion.dialogue.pending('Alex').kind, 'suggestion');
  assert.equal(f.launches.length, 1);
  assert.equal(calls.length, 1);
  f.send('sim', 'other'); await settle();
  assert.equal(f.launches.length, 1);
  f.send('pode trazer'); await settle();
  assert.equal(f.launches.length, 2);
  assert.equal(f.launches.at(-1).deliver, true);
  assert.equal(f.launches.at(-1).from, 'Alex');
  assert.match(calls.at(-1).snapshot.request, /Bring me 4 oak_log/);
});

for (const narration of ['off', 'important']) test(`${narration} narration suppresses optional suggestions while important still permits help`, async t => {
  let clock = Date.parse('2026-10-26T12:00:00Z');
  const { planner } = contextualPlanner([{ item: 'oak_log', count: 4 }]);
  const f = await fixture(t, { planner, narration, initiative: 'full', companionNow: () => clock });
  f.send('Jev collect four oak logs'); await settle();
  f.finish(); await settle();
  const before = f.said.length;
  clock += 6000; f.session.companion.tick(); await settle();
  assert.equal(f.session.companion.dialogue.pending('Alex'), null);
  assert.equal(f.said.length, before);
  f.send('Jev collect four more oak logs'); await settle();
  f.finish(new Error('No safe route')); await settle();
  clock += 6000; f.session.companion.tick(); await settle();
  assert.equal(f.session.companion.dialogue.pending('Alex')?.kind || null, narration === 'important' ? 'help' : null);
});

test('a new addressed conversation dismisses an old clarification and its later option does not revive it', async t => {
  const { planner, calls } = contextualPlanner([
    { kind: 'clarify', item: null, count: null, deliver: null, message: 'Carvalho ou bétula?', options: ['carvalho', 'bétula'] },
    { kind: 'chat', item: null, count: null, deliver: null, message: 'Tudo bem, podemos conversar sobre outra coisa.' },
  ]);
  const f = await fixture(t, { planner, language: 'pt-BR' });
  f.send('Jev colete alguns troncos'); await settle();
  assert.equal(f.session.companion.dialogue.pending('Alex').kind, 'clarify');
  f.send('Jev como está o tempo por aqui?'); await settle();
  assert.equal(f.session.companion.dialogue.pending('Alex'), null);
  f.send('bétula'); await settle();
  assert.equal(calls.length, 2);
  assert.equal(f.launches.length, 0);
});

test('another player answering their own clarification cannot bare-cancel the active owner task', async t => {
  const { planner, calls } = contextualPlanner([
    {}, { kind: 'clarify', item: null, count: null, deliver: null, message: 'Oak or birch?', options: ['oak', 'birch'] },
  ]);
  const f = await fixture(t, { planner });
  f.send('Jev collect birch logs'); await settle();
  const active = f.launches[0];
  f.send('Jev which wood should I use?', 'other'); await settle();
  assert.equal(f.session.companion.dialogue.pending('Other').kind, 'clarify');
  f.send('cancel', 'other'); await settle();
  assert.equal(active.status, 'pending');
  assert.equal(f.bot._waitingForRequest, false);
  f.send('esquece', 'other'); await settle();
  assert.equal(active.status, 'pending');
  assert.equal(f.session.companion.dialogue.pending('Other'), null);
  assert.equal(f.launches.length, 1);
  assert.equal(calls.length, 2);
});

test('lost inventory invalidates a pending delivery offer before an affirmative answer can start work', async t => {
  let clock = Date.parse('2026-10-26T12:00:00Z');
  const { planner, calls } = contextualPlanner([{ item: 'oak_log', count: 4 }]);
  const f = await fixture(t, { planner, initiative: 'full', companionNow: () => clock });
  f.send('Jev collect four oak logs'); await settle();
  f.finish(); await settle();
  clock += 6000; f.session.companion.tick(); await settle();
  assert.equal(f.session.companion.dialogue.pending('Alex').kind, 'suggestion');
  f.bot.inventory.items = () => [];
  f.send('sim'); await settle();
  assert.equal(f.session.companion.dialogue.pending('Alex'), null);
  assert.equal(f.launches.length, 1);
  assert.equal(calls.length, 1);
});

test('an explicit English remember note stays local and reaches the planner notebook after reconnect', async t => {
  const { planner, calls } = contextualPlanner([
    { kind: 'chat', item: null, count: null, deliver: null, message: 'You told me our base is by the river.' },
  ]);
  const f = await fixture(t, { planner, language: 'en-US' });
  f.send('Jev remember that our base is by the river'); await settle();
  assert.equal(calls.length, 0);
  f.session.shutdown(); await f.session.closed; await settle();
  const next = await fixture(t, { planner, language: 'en-US', stateDirectory: f.directory });
  next.send('Jev where did I say our base was?'); await settle();
  assert.equal(calls.length, 1);
  assert(calls[0].snapshot.memory.notes.some(note => note.note === 'our base is by the river'));
  assert.equal(next.launches.length, 0);
});

test('clearing one player memory preserves another player notes and the active task', async t => {
  const { planner, calls } = contextualPlanner([{}]);
  const f = await fixture(t, { planner });
  f.send('Jev remember that I prefer oak');
  f.send('Jev remember that I prefer birch', 'other');
  await settle();
  f.send('Jev collect birch logs'); await settle();
  const active = f.launches[0], epoch = f.bot._requestActivityEpoch;
  f.send('!jev memory clear'); await settle();
  assert.equal(f.bot.companionMemory.context('Alex').notes.length, 0);
  assert.equal(f.bot.companionMemory.context('Other').notes[0].note, 'I prefer birch');
  assert(f.session.companion.memory.context('Other').recentMessages.some(message => message.text.includes('prefer birch')));
  assert(!f.session.companion.memory.context('Alex').recentMessages.some(message => message.role === 'player' && message.text.includes('prefer oak')));
  assert.equal(active.status, 'pending');
  assert.equal(f.bot._requestActivityEpoch, epoch);
  assert.equal(f.launches.length, 1);
  assert.equal(calls.length, 1);
});
