'use strict';

const { spawn } = require('node:child_process');
const { readdirSync } = require('node:fs');
const { constants } = require('node:os');

// Expand the files here so cmd.exe and Unix shells run the same suite.
const files = readdirSync('test').filter(name => name.endsWith('.test.js')).map(name => `test/${name}`);
const child = spawn(process.execPath, [
  '--test', '--require', './test/support/jev-stand-in.js',
  ...process.argv.slice(2), ...files
], {
  stdio: 'inherit',
  env: { ...process.env, JEV_NONE_GOOD: '0' }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', error => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? 128 + (constants.signals[signal] ?? 1);
});
