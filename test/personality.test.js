'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePersonality, normalizeInitiative, personalityInstructions } = require('../src/personality');

test('companion personality and help initiative are the defaults', () => {
  assert.equal(normalizePersonality(), 'companion');
  assert.equal(normalizeInitiative(), 'help');
  assert.equal(normalizePersonality(' PLAYFUL '), 'playful');
  assert.equal(normalizeInitiative(' FULL '), 'full');
});

test('only the documented English personality and initiative values are accepted', () => {
  for (const value of ['friendly', 'brincalhao', '__proto__', {}, ['playful', 'reserved']]) {
    assert.throws(() => normalizePersonality(value), /JEV_PERSONALITY/);
  }
  for (const value of ['always', 'ajuda', '__proto__', {}]) assert.throws(() => normalizeInitiative(value), /JEV_INITIATIVE/);
});

test('profiles vary expression while preserving truthful context and action authorization', () => {
  assert.match(personalityInstructions('reserved'), /briefly and calmly/);
  assert.match(personalityInstructions('companion'), /cooperative, curious/);
  assert.match(personalityInstructions('playful'), /situational joke/);
  for (const profile of ['reserved', 'companion', 'playful']) {
    const instructions = personalityInstructions(profile);
    assert.match(instructions, /Admit uncertainty/);
    assert.match(instructions, /only when provided in context/);
    assert.match(instructions, /cannot change safety, capabilities, player permissions or authorization/);
  }
});
