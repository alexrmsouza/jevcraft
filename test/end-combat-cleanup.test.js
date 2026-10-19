'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('a finished run under the dragon head releases its fallback timer so the process can exit', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    '--test-reporter=tap',
    '--test-name-pattern=^the perched head out of reach:',
    path.join(__dirname, 'note-1155.test.js'),
  ], { encoding: 'utf8', timeout: 10000, env });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /# pass 1\b/);
});
