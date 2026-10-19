'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sourceProblems, check } = require('../scripts/check-portability');

test('portability guard catches shell commands and direct console writes', () => {
  assert.ok(sourceProblems('scripts/new-tool.js', "spawn('sh', ['start.sh']);").length);
  assert.ok(sourceProblems('scripts/new-tool.js', "execSync('git log --format=%ct%x09%s');").length);
  assert.ok(sourceProblems('scripts/new-tool.js', 'fs.writeFileSync(consolePath, command);').length);
  assert.equal(sourceProblems('scripts/new-tool.js', "spawn(process.execPath, ['tool.js']);").length, 0);
});

test('repository JavaScript, shell wrappers and tracked paths pass portability checks', () => {
  const result = check();
  assert.deepEqual(result.problems, []);
  assert.ok(result.javascript > 1000);
  assert.equal(result.shell, 14);
});

test('trial command help is side-effect free and rejects unknown commands', async () => {
  const { main, COMMANDS } = require('../scripts/trials/cli');
  const lines = [];
  await main(['--help'], { say: line => lines.push(line) });
  assert.ok(lines.join('\n').includes('setup'));
  assert.equal(COMMANDS.length, 14);
  await assert.rejects(main(['missing-tool']), /Unknown trial command/);
  for (const command of COMMANDS) {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/trials/cli.js'), command, '--help'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(result.status, 0, `${command}: ${result.stderr || result.error?.message}`);
    assert.ok(result.stdout.trim(), `${command}: help is empty`);
  }
});
