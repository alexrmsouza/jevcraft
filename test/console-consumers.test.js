'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const consumers = ['arena', 'blaze-probe', 'climb-drill', 'end-drill', 'endgame', 'fishing-drill', 'jev-down-probe', 'pass-drill', 'perch-drill', 'rod-stash-probe', 'shield-probe', 'shot-reflex-probe', 'span-drill', 'spawner-drill', 'spawner-light-probe', 'threat-probe', 'terrain'];
test('every drill and probe sends console commands through the portable transport', () => {
  for (const name of consumers) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', `${name}.js`), 'utf8');
    assert.match(source, /writeConsoleFile\(/, name);
    assert.doesNotMatch(source, /fs\.(?:write|append)FileSync\((?:consolePath|CONSOLE),/, name);
  }
});
