'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runner = path.join(__dirname, '..', 'scripts', 'test.js');

function runFixture(t, source, args = []) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jevcraft-test-runner-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'test', 'support'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'test', 'support', 'jev-stand-in.js'), 'global.standInLoaded = true;\n');
  fs.writeFileSync(path.join(cwd, 'test', 'fixture.test.js'), source);
  const env = { ...process.env, JEV_NONE_GOOD: '1' };
  // The fixture is a separate suite, not a child test managed by this runner.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [runner, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 15_000
  });
}

test('test runner preloads the stand-in, sets JEV_NONE_GOOD and forwards Node test options', t => {
  const result = runFixture(t, `
    const test = require('node:test');
    const assert = require('node:assert/strict');
    test('selected test', () => {
      assert.equal(process.env.JEV_NONE_GOOD, '0');
      assert.equal(global.standInLoaded, true);
    });
    test('excluded test', () => assert.fail('name filter was not forwarded'));
  `, ['--test-name-pattern=selected test', '--test-reporter=tap']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /TAP version 13/);
  assert.match(result.stdout, /ok \d+ - selected test/);
});

test('test runner returns a failing test exit code', t => {
  const result = runFixture(t, `
    const test = require('node:test');
    test('failure', () => { throw new Error('fixture failure'); });
  `);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /fixture failure/);
});
