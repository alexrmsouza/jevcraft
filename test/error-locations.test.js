'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { noteError } = require('../src/work');

for (const [name, root] of [
  ['POSIX', '/home/player/jevcraft'],
  ['POSIX with spaces', '/home/player/Minecraft Projects/jevcraft'],
  ['Windows', 'C:\\Users\\player\\dev\\jevcraft'],
  ['Windows with spaces', 'C:\\Users\\player\\Minecraft Projects\\jevcraft'],
  ['Windows with forward slashes', 'C:/Users/player/dev/jevcraft'],
]) {
  test(`error locations retain source frames on ${name}`, t => {
    t.mock.method(console, 'error', () => {});
    const separator = root.includes('\\') ? '\\' : '/';
    const frame = (fn, file, line) => `    at ${fn} (${root}${separator}src${separator}${file}.js:${line}:5)`;
    const err = new TypeError(`broken source on ${name}`);
    err.stack = [
      `${err.name}: ${err.message}`,
      frame('navigate', 'skills', 10),
      frame('move', 'motion', 20),
      frame('searchFor', 'work', 30),
      frame('runGoal', 'work', 40),
      '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
    ].join('\n');
    const goal = {};
    noteError(goal, err);
    assert.equal(goal.lastErrorAt, 'navigate (src/skills.js:10:5) < move (src/motion.js:20:5) < searchFor (src/work.js:30:5)');
    assert.equal(goal.lastErrorFrom, 'searchFor (src/work.js:30:5) < runGoal (src/work.js:40:5)');

    const worldError = new Error('No route to the goal');
    worldError.stack = ['Error: No route to the goal', frame('navigate', 'skills', 50), frame('runGoal', 'work', 60)].join('\n');
    noteError(goal, worldError);
    assert.equal(goal.lastErrorAt, undefined);
    assert.equal(goal.lastErrorFrom, 'runGoal (src/work.js:60:5)');
  });
}
