'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('stance profiles retain Windows call frames', () => {
  const profile = { nodes: [
    { id: 1, callFrame: { functionName: '(root)', url: '' }, children: [2] },
    { id: 2, callFrame: { functionName: 'blazeStands', url: 'C:\\Jev workspace\\src\\blaze-stand.js' } },
  ], samples: [2], timeDeltas: [400000] };
  assert.deepEqual(require('../src/stance-profile').heaviest(profile), ['blazeStands blaze-stand.js 400 ms']);
});

test('stall profiles normalize Windows source paths and include their sampled time', () => {
  const profile = { nodes: [
    { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0 }, children: [2] },
    { id: 2, callFrame: { functionName: 'search', url: 'C:\\Jev workspace\\src\\movement.js', lineNumber: 9 } },
  ], samples: [2], timeDeltas: [100000] };
  const result = require('../src/stall-profiler').summarize(profile, 'C:\\Jev workspace');
  assert.deepEqual(result.inclusive, ['search src/movement.js:10 100 ms']);
  assert.deepEqual(result.self, ['search src/movement.js:10 100 ms']);
});

test('movement release diagnostics shorten Windows stack paths', async () => {
  const controls = {}, bot = { controlState: controls, getControlState: key => !!controls[key], setControlState: (key, value) => { controls[key] = value; } };
  let released;
  await require('../src/motion').move(bot, { check() {} }, { label: 'fixture', until: () => {
    const previous = Error.prepareStackTrace;
    try {
      Error.prepareStackTrace = () => 'Error\n at frames\n at watcher\n at release (C:\\Jev workspace\\src\\survival.js:25:2)';
      bot.setControlState('forward', false);
      released = bot._controller.letGoBy;
    } finally { Error.prepareStackTrace = previous; }
    return true;
  } });
  assert.match(released, /release \(src\/survival.js:25:2\)/);
  assert.doesNotMatch(released, /C:|Jev workspace/);
});

test('arm comparisons classify native Windows source paths consistently', () => {
  const { startKind } = require('../scripts/lib/ab');
  assert.equal(startKind({ source: '.trial-checkpoints\\stages\\fortress\\checkpoint\\world' }), 'fortress save');
  assert.equal(startKind({ source: '.trial-sources\\first-days-77' }), 'fresh 77');
});

test('Overworld death reports exclude stage snapshots recorded with Windows separators', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-death-report-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trials = path.join(root, 'artifacts', 'midgame');
  fs.mkdirSync(trials, { recursive: true });
  fs.mkdirSync(path.join(root, '.bot-state', 'flight'), { recursive: true });
  fs.writeFileSync(path.join(trials, 'stage.json'), JSON.stringify({ port: 25588, startedAt: '2026-10-18T00:00:00Z', source: '.trial-checkpoints\\stages\\fortress\\snapshot\\world', world: 'stage', verdict: { minutes: 1, done: true } }));
  const result = require('node:child_process').spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/overworld-deaths.js'), '--json'], { encoding: 'utf8', env: { ...process.env, JEV_ROOT: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).summary.trialsBegun, 0);
});
