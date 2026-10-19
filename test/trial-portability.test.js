'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const zlib = require('node:zlib');
const fixture = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev trials ')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const put = (root, name, text = '') => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };

test('all portable trial entrypoints explain usage without touching the working directory', t => {
  const root = fixture(t);
  for (const name of ['checkpoint', 'critic', 'harvest', 'janitor', 'promote', 'retry', 'settle', 'spectate', 'start-fresh', 'start-stage', 'watch']) {
    const file = path.resolve(__dirname, '../scripts/trials', `${name}.js`);
    assert(fs.existsSync(file), `${name} has a portable entrypoint`);
    const r = spawnSync(process.execPath, [file, '--help'], { cwd: root, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.match(r.stdout, /usage:/i);
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test('watch honors cut reasons, played-on reasons and JEV outages', () => {
  const { needsAttention } = require('../scripts/trials/watch');
  assert.equal(needsAttention({ reasons: ['cut: no Nether in 60 minutes played'] }), true);
  assert.equal(needsAttention({ reasons: ['held through a loop: played on', 'died once: played on'] }), false);
  assert.equal(needsAttention({ reasons: ['stranded here'] }), true);
  assert.equal(needsAttention({ done: true, jevDownNow: true, reasons: ['death'] }), false);
});

test('fresh trial names skip reports and world folders on every port', async t => {
  const root = fixture(t);
  put(root, '.trial-sources/first-days-242.archive', '.bot-state/archive old\n');
  put(root, 'artifacts/midgame/mid-242-a.json', '{}');
  put(root, '.clean-run-25589/mid-242-aa/level.dat');
  const calls = [];
  const result = await require('../scripts/trials/start-fresh').startFresh('25582', '242', { root, run: async (...args) => { calls.push(args); return ''; } });
  assert.equal(result.world, 'mid-242-ab');
  assert.deepEqual(calls[0][1], ['start', 'mid-242-ab', '.trial-sources/first-days-242', '.bot-state/archive old']);
  assert.equal(calls[0][2].MIDGAME_PORT, '25582');
});

test('janitor preserves stage saves and active log bytes, removing only expired eligible files', async t => {
  const root = fixture(t), now = Date.now();
  const recording = put(root, '.clean-run-25582/recordings/a/b/old.tmcpr', 'old');
  fs.utimesSync(recording, new Date(now - 9 * 3600000), new Date(now - 9 * 3600000));
  put(root, '.trial-checkpoints/stages/nether/source/world/level.dat', 'keep');
  put(root, '.clean-run-25582/server.properties', 'server-port=25582\nlevel-name=mid-active\n');
  const active = put(root, 'artifacts/midgame-active.log', 'before\n');
  const result = await require('../scripts/trials/janitor').janitor({ root, now, freeGb: () => 50, liveLogBytes: 1, oldLogBytes: 1 });
  assert.equal(fs.existsSync(recording), false);
  assert.equal(fs.readFileSync(active, 'utf8'), 'before\n');
  assert.equal(fs.readFileSync(path.join(root, '.trial-checkpoints/stages/nether/source/world/level.dat'), 'utf8'), 'keep');
  assert.equal(result.snapshots.length, 1);
  assert.equal(zlib.gunzipSync(fs.readFileSync(result.snapshots[0])).toString(), 'before\n');
  fs.appendFileSync(active, 'after\n');
  const next = await require('../scripts/trials/janitor').janitor({ root, now: now + 1000, freeGb: () => 50, liveLogBytes: 1, oldLogBytes: 1 });
  assert.equal(zlib.gunzipSync(fs.readFileSync(next.snapshots[0])).toString(), 'after\n');
});

test('checkpoint pruning rejects path escapes and does not traverse directory symlinks', t => {
  const root = fixture(t), outside = fixture(t);
  put(outside, 'keep', 'untouched');
  const { safeRemove } = require('../scripts/lib/trial-ops');
  assert.throws(() => safeRemove(root, outside), /outside|escape|descendant/i);
  fs.mkdirSync(path.join(root, 'allowed'));
  fs.symlinkSync(outside, path.join(root, 'allowed', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => safeRemove(root, path.join(root, 'allowed', 'linked', 'keep')), /symbolic|symlink|link/i);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'untouched');
});

test('managed paths accept symlink ancestors above the base but reject a linked base or descendant', t => {
  const parent = fixture(t), actual = fixture(t), outside = fixture(t);
  const alias = path.join(parent, 'alias');
  fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(actual, 'managed'));
  const base = path.join(alias, 'managed'), file = put(base, 'world/level.dat', 'owned');
  const { safePath, safeRemove } = require('../scripts/lib/trial-ops');
  assert.equal(safePath(base, file), file, 'an OS path alias such as macOS /var must preserve the lexical path');
  safeRemove(base, path.dirname(file));
  assert.equal(fs.existsSync(path.join(actual, 'managed/world')), false);
  assert.throws(() => safePath(alias, path.join(alias, 'managed/file')), /symbolic|symlink|link/i, 'the managed base itself may not be a link');
  fs.symlinkSync(outside, path.join(base, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  put(outside, 'keep', 'untouched');
  assert.throws(() => safeRemove(base, path.join(base, 'linked/keep')), /symbolic|symlink|link/i);
  assert.throws(() => safeRemove(base, path.join(base, '../elsewhere')), /outside|escape|descendant/i);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'untouched');
});

test('spectator commands touch only the named watcher and notice log resets', async t => {
  const root = fixture(t), log = put(root, '.clean-run-25582/logs/latest.log', 'Alex joined the game\n');
  put(root, '.clean-run-25582/server.properties', 'server-port=25582\n');
  const writes = [], seen = new Map();
  const { scan } = require('../scripts/trials/spectate');
  const options = { root, seen, pause: async () => {}, writeConsole: (dir, text) => writes.push(text), serverRunning: () => true, say: () => {} };
  await scan('Alex', options); await scan('Alex', options);
  assert.deepEqual(writes, ['gamemode spectator Alex\nspectate Jev Alex']);
  fs.writeFileSync(log, ''); await scan('Alex', options);
  fs.writeFileSync(log, 'Alex joined the game\n'); await scan('Alex', options);
  assert.equal(writes.length, 2);
  await assert.rejects(() => scan('Alex\nstop', options), /player/i);
});

test('checkpoint preserves pre-death snapshots, milestones and only the configured ring size', async t => {
  const root = fixture(t), now = Date.parse('2026-10-18T12:00:00Z');
  put(root, '.clean-run-25582/server.properties', 'server-port=25582\nlevel-name=mid-242-a\n');
  const log = put(root, '.clean-run-25582/logs/latest.log', 'Jev joined the game\n');
  put(root, '.clean-run-25582/mid-242-a/region/r.0.0.mca', 'before');
  put(root, '.clean-run-25582/mid-242-a/session.lock', 'do not copy lock');
  put(root, '.bot-state/127_0_0_1-25582-Jev.json', '{"stage":"nether"}');
  const writes = [], options = { root, now, listenerPid: () => 123, writeConsole: (dir, text) => writes.push(text), pause: async () => {}, milestones: () => 'nether', freeGb: () => 50, config: { keep: 1 }, say: () => {} };
  const checkpoint = require('../scripts/trials/checkpoint');
  const first = await checkpoint.scan(['25582'], options);
  assert.equal(fs.existsSync(path.join(first[0], 'world/session.lock')), false);
  assert.equal(fs.readFileSync(path.join(first[0], 'state/127_0_0_1-25582-Jev.json'), 'utf8'), '{"stage":"nether"}');
  fs.appendFileSync(log, '[12:00] Jev fell from a high place\n');
  await checkpoint.scan(['25582'], { ...options, now: now + 30000 });
  assert.deepEqual(writes, ['save-all flush', 'save-all flush']);
  assert.equal(fs.readdirSync(path.join(root, '.trial-checkpoints/mid-242-a/ring')).length, 1);
  assert.equal(fs.readdirSync(path.join(root, '.trial-checkpoints/deaths/mid-242-a-120030')).length, 1);
  assert.equal(fs.readFileSync(path.join(root, '.trial-checkpoints/stages/nether/mid-242-a-120000/world/region/r.0.0.mca'), 'utf8'), 'before');
  assert.equal(checkpoint.stageAllowed('mid-242-a-fortress-1', 'nether'), false);
  assert.equal(checkpoint.stageAllowed('mid-242-a-fortress-1', 'stronghold'), true);
});

test('harvest waits for saved server shutdown and archives both world and bot state', async t => {
  const root = fixture(t);
  put(root, '.clean-run-25582/server.properties', 'server-port=25582\nlevel-name=first-days-242\n');
  put(root, '.clean-run-25582/first-days-242/level.dat', 'world');
  put(root, '.bot-state/127_0_0_1-25582-Jev.json', '{}');
  put(root, '.bot-state/pids/127.0.0.1-25582-Jev.pid', '123');
  let botAlive = true, serverAlive = true;
  const commands = [], stops = [];
  const result = await require('../scripts/trials/harvest').harvest('25582', { root, now: 1234567890000, pause: async () => {}, isAlive: pid => pid === 123 ? botAlive : serverAlive, stopProcess: pid => { stops.push(pid); botAlive = false; }, listenerPid: () => serverAlive ? 456 : null, writeConsole: (dir, command) => { assert(fs.existsSync(path.join(root, '.bot-state/pids/127.0.0.1-25582-Jev.starting'))); commands.push(command); serverAlive = false; } });
  assert.deepEqual(commands, ['stop']); assert.deepEqual(stops, [123]);
  assert.equal(result.source, '.trial-sources/first-days-242');
  assert.equal(fs.readFileSync(path.join(root, result.source, 'level.dat'), 'utf8'), 'world');
  assert.equal(fs.readFileSync(path.join(root, result.archive, '127_0_0_1-25582-Jev.json'), 'utf8'), '{}');
  assert.equal(opsRead(root, `${result.source}.archive`).trim(), result.archive);
  assert.equal(fs.existsSync(path.join(root, '.bot-state/pids/127.0.0.1-25582-Jev.starting')), false);
});
function opsRead(root, name) { return fs.readFileSync(path.join(root, name), 'utf8'); }

test('promotion and settlement preserve death and iron-pickaxe criteria', async t => {
  const root = fixture(t), calls = [];
  const { promotable, promote } = require('../scripts/trials/promote');
  const { state } = require('../scripts/trials/settle');
  assert.equal(promotable({ done: true, reasons: ['death: 1'] }), false);
  assert.equal(promotable({ done: true, reasons: ['died once'] }), false);
  assert.equal(state({ done: true, world: 'first-days-1', reasons: [], reachedAt: { iron_pickaxe: 1 } }), 'promote');
  assert.equal(state({ done: false, reasons: [] }), 'running');
  await promote('25582', 'a', { root, say: () => {}, run: async (...args) => { calls.push(args); return args[0] === 'first-days.js' ? '{"done":true,"reasons":[]}' : ''; }, harvest: async () => ({ source: '.trial-sources/first-days-242', archive: '.bot-state/archive x' }) });
  assert.deepEqual(calls[1][1], ['start', 'mid-242-a', '.trial-sources/first-days-242', '.bot-state/archive x']);
});

test('stage startup honors picker fallback, skips occupied names and logs pairing metadata', async t => {
  const root = fixture(t), best = path.join(root, '.trial-checkpoints/stages/nether/mid-242-a-120000');
  put(root, '.trial-checkpoints/stages/fortress/.keep');
  put(best, 'world/level.dat', 'world'); fs.mkdirSync(path.join(best, 'state'));
  put(root, '.clean-run-25582/mid-242-a-nether-1/level.dat');
  const calls = [];
  const result = await require('../scripts/trials/start-stage').startStage('25582', 'fortress', { root, now: 0, say: () => {}, run: async (...args) => { calls.push(args); return args[0] === 'lib/arms.js' ? 'main' : args[0] === 'trials/stage-pick.js' ? `nether\t${best}` : ''; } });
  assert.equal(result.world, 'mid-242-a-nether-2');
  assert.match(opsRead(root, '.trial-checkpoints/stage-starts.log'), /\tnether\tmid-242-a-120000\tmain\tfortress/);
  assert.equal(calls[1][2].STAGE_ARM, 'main');
});

test('retry uses free configured ports and the snapshot BACK places before the last', async t => {
  const root = fixture(t), kept = '.trial-checkpoints/deaths/mid-242-a-120000';
  for (const at of ['115830', '115900', '115930']) { put(root, `${kept}/${at}/world/level.dat`, at); fs.mkdirSync(path.join(root, kept, at, 'state')); }
  for (const port of [25601, 25602, 25603]) fs.mkdirSync(path.join(root, `.clean-run-${port}`));
  const calls = [], supervised = [];
  const result = await require('../scripts/trials/retry').retry(kept, 2, { root, env: { BACK: '2' }, say: () => {}, listenerPid: port => port === 25601 ? 100 : null, run: async (...args) => { calls.push(args); return ''; }, supervise: port => supervised.push(port) });
  assert.deepEqual(result.map(r => r.port), [25602, 25603]);
  assert.match(calls[0][1][2], /115900[\\/]world$/);
  assert.deepEqual(supervised, [25602, 25603]);
});

test('critic passes read-only tool scopes and honors the stop marker without calling a model', async t => {
  const root = fixture(t);
  put(root, 'scripts/trials/critic-prompt.md', 'Read the trial files.');
  const { EventEmitter } = require('node:events'); const { PassThrough } = require('node:stream');
  const calls = [];
  const spawn = (command, args, options) => { calls.push({ command, args, options }); const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdin.resume(); process.nextTick(() => { fs.writeSync(options.stdio[1], 'fixture report\n'); child.emit('exit', 0); }); return child; };
  const { critique } = require('../scripts/trials/critic');
  const result = await critique({ root, env: { CLAUDE_BIN: 'C:\\Program Files\\Claude\\claude.cmd' }, now: 0, spawn });
  assert.equal(result.code, 0); assert.equal(fs.readFileSync(result.file, 'utf8'), 'fixture report\n');
  assert.equal(calls[0].command, 'C:\\Program Files\\Claude\\claude.cmd');
  assert(calls[0].args.includes('Bash(node scripts/*)')); assert(!calls[0].args.includes('Write')); assert(!calls[0].args.includes('Edit'));
  assert(calls[0].args.includes('PowerShell(node scripts/*)'));
  assert(calls[0].args.includes('PowerShell(Get-ChildItem:*)'));
  put(root, 'artifacts/critic/stop'); assert.equal(await critique({ root, spawn }), false); assert.equal(calls.length, 1);
});

test('maintenance ignores unconfigured server folders and removes old inactive logs after archiving', async t => {
  const root = fixture(t), now = Date.now();
  fs.mkdirSync(path.join(root, '.clean-run-25601'));
  const log = put(root, 'artifacts/midgame-ended.log', 'old complete record\n');
  fs.utimesSync(log, new Date(now - 4 * 3600000), new Date(now - 4 * 3600000));
  const result = await require('../scripts/trials/janitor').janitor({ root, now, oldLogBytes: 1, freeGb: () => 50, say: () => {} });
  assert.equal(fs.existsSync(log), false);
  assert.equal(zlib.gunzipSync(fs.readFileSync(result.snapshots[0])).toString(), 'old complete record\n');
});

test('copying refuses to overwrite a symlink in an existing destination', t => {
  const root = fixture(t), outside = fixture(t);
  const source = put(root, 'source/level.dat', 'replacement');
  const target = put(outside, 'level.dat', 'keep');
  fs.mkdirSync(path.join(root, 'target'));
  fs.symlinkSync(outside, path.join(root, 'target/world'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => require('../scripts/lib/trial-ops').copyTree(path.dirname(source), path.join(root, 'target/world')), /symbolic|symlink|link/i);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
});

test('portable subprocess runner preserves literal arguments and enforces timeouts', async t => {
  const root = fixture(t);
  put(root, 'scripts/echo.js', 'console.log(JSON.stringify({args:process.argv.slice(2),port:process.env.MIDGAME_PORT}));');
  put(root, 'scripts/hang.js', 'setInterval(() => {}, 1000);');
  const { run } = require('../scripts/lib/trial-ops');
  const args = ['path with spaces', 'a&b', '"quoted"', '$(fake)'];
  const output = JSON.parse(await run('echo.js', args, { MIDGAME_PORT: '25601' }, { root }));
  assert.deepEqual(output, { args, port: '25601' });
  await assert.rejects(run('hang.js', [], {}, { root, timeout: 50 }), error => error.killed === true);
});

test('an already aborted monitor does not perform a check', async () => {
  const { main } = require('../scripts/trials/watch');
  const controller = new AbortController(); controller.abort();
  let calls = 0; await main(['25582'], { signal: controller.signal, run: async () => { calls++; return '{}'; } });
  assert.equal(calls, 0);
});

test('checkpoint skips a port while its start or harvest marker exists', async t => {
  const root = fixture(t);
  put(root, '.bot-state/pids/127.0.0.1-25582-Jev.starting');
  let writes = 0;
  const result = await require('../scripts/trials/checkpoint').scan(['25582'], { root, listenerPid: () => 1, writeConsole: () => writes++, freeGb: () => 50 });
  assert.deepEqual(result, []); assert.equal(writes, 0);
});

test('janitor low-space policy prunes only abandoned midgame rings and eligible recordings', async t => {
  const root = fixture(t), now = Date.now();
  put(root, '.clean-run-25582/server.properties', 'server-port=25582\nlevel-name=mid-active\n');
  const recording = put(root, '.clean-run-25582/recordings/a/b/old.tmcpr', 'old');
  fs.utimesSync(recording, new Date(now - 90 * 60000), new Date(now - 90 * 60000));
  put(root, '.trial-checkpoints/mid-abandoned/ring/save/world/level.dat', 'expired');
  put(root, '.trial-checkpoints/mid-active/ring/save/world/level.dat', 'active');
  put(root, '.trial-checkpoints/deaths/death/world/level.dat', 'death');
  for (const world of ['mid-active', 'mid-abandoned']) fs.utimesSync(path.join(root, '.trial-checkpoints', world), new Date(now - 13 * 3600000), new Date(now - 13 * 3600000));
  await require('../scripts/trials/janitor').janitor({ root, now, freeGb: () => 5, say: () => {} });
  assert.equal(fs.existsSync(recording), false);
  assert.equal(fs.existsSync(path.join(root, '.trial-checkpoints/mid-abandoned')), false);
  assert.equal(fs.existsSync(path.join(root, '.trial-checkpoints/mid-active')), true);
  assert.equal(fs.existsSync(path.join(root, '.trial-checkpoints/deaths/death/world/level.dat')), true);
});

test('trial startup has no implicit timeout while verdicts remain bounded and explicit deadlines work', async () => {
  const { run } = require('../scripts/lib/trial-ops'), calls = [], controller = new AbortController();
  const execFile = (file, args, options, done) => { calls.push({ args, options }); done(null, '{}', ''); };
  await run('midgame.js', ['start', 'mid-242-a', 'world', 'state'], {}, { execFile, signal: controller.signal });
  await run('midgame.js', ['verdict'], {}, { execFile });
  await run('first-days.js', ['start', 'first-days-1'], {}, { execFile, timeout: 30000 });
  assert.equal(calls[0].options.timeout, 0, 'slow world preparation must not kill the starter and leave its .starting marker behind');
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[1].options.timeout, 120000);
  assert.equal(calls[2].options.timeout, 30000);
});
