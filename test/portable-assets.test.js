'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const arms = require('../scripts/lib/arms');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('baseline setup links directories without file-symlink privileges and refreshes Windows env before launch', t => {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=first\n');
  const run = (command, args) => {
    if (args[0] === 'worktree') {
      fs.mkdirSync(args[3], { recursive: true });
      fs.writeFileSync(path.join(args[3], 'index.js'), '');
    }
    return '';
  };
  const checkout = arms.setup('baseline', 'abcdef', { root, run, say() {} });
  assert.equal(fs.realpathSync(path.join(checkout, '.bot-state')), fs.realpathSync(path.join(root, '.bot-state')));
  if (process.platform === 'win32') assert.equal(fs.lstatSync(path.join(checkout, '.env')).isSymbolicLink(), false);
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=updated\n');
  arms.setArm(25590, 'baseline', { root });
  arms.botSpawn(25590, root, {});
  assert.equal(fs.readFileSync(path.join(checkout, '.env'), 'utf8'), 'TOKEN=updated\n');
  fs.rmSync(path.join(root, '.env'));
  arms.botSpawn(25590, root, {});
  assert.equal(fs.existsSync(path.join(checkout, '.env')), false);
});

test('baseline npm ci runs npm-cli.js through Node with no shell', t => {
  const root = temporary(t);
  const cli = path.join(root, 'npm-cli.js');
  fs.writeFileSync(cli, '');
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'worktree') {
      fs.mkdirSync(path.join(args[3], 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(args[3], 'index.js'), '');
    }
    if (args[0] === 'diff') throw new Error('different lock');
    return '';
  };
  arms.setup('baseline', 'abcdef', { root, run, env: { npm_execpath: cli }, say() {} });
  const install = calls.find(call => call.args.includes('ci'));
  assert.equal(install.command, process.execPath);
  assert.deepEqual(install.args, [cli, 'ci', '--no-audit', '--no-fund']);
  assert.notEqual(install.options.shell, true);
});

test('baseline setup resolves npm from the installed Node when npm_execpath is unset', () => {
  const cli = arms.npmCli({});
  const result = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('fresh trial pairing recognizes Windows source separators', t => {
  const root = temporary(t);
  const dir = path.join(root, 'artifacts', 'midgame');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'trial.json'), JSON.stringify({ source: 'C:\\runs\\.trial-sources\\first-days-77', arm: 'baseline', startedAt: '2026-10-18T00:00:00Z' }));
  assert.deepEqual(arms.freshStarts(root).map(start => start.key), ['77']);
});

test('replay metadata and timeline updates use ZIP archives with Unicode and preserve other entries', t => {
  const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');
  const { replayMeta, writeTimeline } = require('../scripts/trials/replay-camera');
  const root = temporary(t), file = path.join(root, 'replay ação.MCPR');
  const metadata = { date: 123, duration: 456, serverName: 'Ação' };
  const contents = { 'metaData.json': strToU8(JSON.stringify(metadata)), 'timelines.json': strToU8('{"old":true}'), 'ação/日本語.txt': strToU8('Olá 世界'), 'recording.tmcpr': new Uint8Array([0, 255, 7]) };
  fs.writeFileSync(file, zipSync(contents));
  assert.deepEqual(replayMeta(file), metadata);
  const timeline = { '': [{ keyframes: [], label: 'Visão' }] };
  writeTimeline(file, timeline);
  const updated = unzipSync(fs.readFileSync(file));
  assert.deepEqual(JSON.parse(strFromU8(updated['timelines.json'])), timeline);
  for (const name of Object.keys(contents).filter(name => name !== 'timelines.json')) assert.deepEqual(updated[name], contents[name]);
  assert.equal(replayMeta(path.join(root, 'missing.mcpr')), null);
});

test('replay paths choose platform defaults, discover vanilla, and honor explicit paths without HOME', t => {
  const { replayDirectory } = require('../scripts/lib/replay-paths');
  const home = temporary(t);
  const appData = path.join(home, 'Roaming');
  const win = replayDirectory({ platform: 'win32', home, env: { APPDATA: appData } });
  assert.equal(win, path.join(appData, 'PrismLauncher', 'instances', 'Jev Replays', '.minecraft', 'replay_recordings'));
  assert.equal(replayDirectory({ platform: 'darwin', home, env: {} }), path.join(home, 'Library', 'Application Support', 'PrismLauncher', 'instances', 'Jev Replays', 'minecraft', 'replay_recordings'));
  fs.mkdirSync(path.join(home, '.minecraft', 'replay_recordings'), { recursive: true });
  assert.equal(replayDirectory({ platform: 'linux', home, env: {} }), path.join(home, '.minecraft', 'replay_recordings'));
  assert.equal(replayDirectory({ platform: 'win32', home, env: { REPLAY_RECORDINGS: 'custom replays' } }), path.resolve('custom replays'));
  assert.throws(() => replayDirectory({ platform: 'win32', home, env: { REPLAY_RECORDINGS: 'missing' }, required: true }), /REPLAY_RECORDINGS.*missing|missing.*REPLAY_RECORDINGS/);
});

test('Python trial report reads UTF-8 on Windows even when default encoding is ASCII', t => {
  const python = ['python', 'python3'].find(command => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);
  if (!python) return t.skip('Python is optional and not installed');
  const root = temporary(t);
  fs.mkdirSync(path.join(root, 'artifacts', 'midgame'), { recursive: true });
  fs.mkdirSync(path.join(root, '.bot-state', 'flight'), { recursive: true });
  fs.writeFileSync(path.join(root, 'artifacts', 'midgame', 'trial.json'), JSON.stringify({ startedAt: '2026-10-18T00:00:00Z', port: 25588, world: 'ação', verdict: { minutes: 3, reachedAtMinute: { nether: 2 } } }));
  fs.writeFileSync(path.join(root, '.bot-state', 'flight', '127_0_0_1-25588-Jev-2026-10-18T00-00-00-000Z.jsonl'), JSON.stringify({ at: '2026-10-18T00:00:10Z', kind: 'decision', question: 'portal_plan', label: 'portal_plan_bucket', detail: 'ação' }) + '\n');
  const script = path.resolve(__dirname, '../scripts/plan-outcomes.py');
  const result = spawnSync(python, ['-X', 'utf8=0', '-X', 'warn_default_encoding', script], { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fresh trials 1 with a portal plan 1 reached nether 1/);
  assert.doesNotMatch(result.stderr, /EncodingWarning/);
});

test('replay reports can run without HOME or an installed replay folder', t => {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, 'artifacts', 'midgame'), { recursive: true });
  fs.writeFileSync(path.join(root, 'artifacts', 'deaths.json'), '[]');
  const env = { ...process.env, JEV_ROOT: root };
  delete env.HOME;
  delete env.REPLAY_RECORDINGS;
  for (const [name, args] of [['highlights', ['--dry']], ['death-index', []], ['death-camera', []]]) {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, `../scripts/trials/${name}.js`), ...args], { encoding: 'utf8', env });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
  assert.equal(fs.existsSync(path.join(root, 'artifacts', 'highlights.json')), true);
});

test('death ledger expands the user home on Windows without HOME', t => {
  const root = temporary(t), fixture = path.join(root, 'fixture');
  fs.mkdirSync(path.join(fixture, 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(fixture, '.bot-state', 'flight'), { recursive: true });
  const env = { ...process.env, USERPROFILE: root, HOME: root };
  if (process.platform === 'win32') delete env.HOME;
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/death-ledger.js'), '--root', '~/fixture'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"runs": 0/);
});

test('knowledge extraction produces UTF-8 JSON with LF on Windows', t => {
  const python = ['python', 'python3'].find(command => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);
  if (!python) return t.skip('Python is optional and not installed');
  const { zipSync, strToU8 } = require('fflate');
  const root = temporary(t), scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts);
  fs.copyFileSync(path.resolve(__dirname, '../scripts/extract-knowledge.py'), path.join(scripts, 'extract-knowledge.py'));
  const entries = {};
  for (const entity of ['blaze', 'enderman', 'spider', 'skeleton', 'cow', 'mooshroom', 'pig', 'sheep', 'chicken', 'rabbit']) entries[`data/minecraft/loot_table/entities/${entity}.json`] = strToU8('{"pools":[]}');
  entries['data/minecraft/recipe/ação.json'] = strToU8(JSON.stringify({ type: 'minecraft:crafting_shapeless', result: { id: 'minecraft:stick', count: 1 }, ingredients: ['minecraft:oak_planks'] }));
  const jar = path.join(root, 'vanilla ação.jar');
  fs.writeFileSync(jar, zipSync(entries));
  const result = spawnSync(python, ['-X', 'utf8=0', '-X', 'warn_default_encoding', path.join(scripts, 'extract-knowledge.py'), jar], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  assert.equal(result.status, 0, result.stderr);
  const output = fs.readFileSync(path.join(root, 'data', 'vanilla-26.1.json'), 'utf8');
  assert.equal(JSON.parse(output).recipes.stick[0].id, 'ação');
  assert.equal(output.endsWith('\n'), true);
  assert.equal(output.includes('\r'), false);
  assert.doesNotMatch(result.stderr, /EncodingWarning/);
});

test('death index reports an actionable missing-client error instead of claiming a copy succeeded', t => {
  const root = temporary(t), server = path.join(root, '.clean-run');
  fs.mkdirSync(path.join(server, 'logs'), { recursive: true });
  const log = path.join(server, 'logs', 'latest.log');
  fs.writeFileSync(log, '[12:00:00] [Server thread/INFO]: Preparing level "trial"\n[12:00:10] [Server thread/INFO]: Jev drowned\n');
  fs.utimesSync(log, new Date('2026-10-18T12:00:10Z'), new Date('2026-10-18T12:00:10Z'));
  const recordings = path.join(server, 'recordings', 'players', 'player');
  fs.mkdirSync(recordings, { recursive: true });
  fs.writeFileSync(path.join(recordings, '2026-10-18--12-00-00.mcpr'), 'fixture');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/trials/death-index.js')], { encoding: 'utf8', env: { ...process.env, JEV_ROOT: root, REPLAY_RECORDINGS: path.join(root, 'missing client') } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /copy failed:.*REPLAY_RECORDINGS/);
  assert.equal(fs.existsSync(path.join(root, 'missing client')), false);
});
