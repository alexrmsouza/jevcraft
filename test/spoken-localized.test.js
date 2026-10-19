'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spoken, Spoken } = require('../src/spoken');

test('player-facing phase labels use the chosen language without changing internal English labels', () => {
  assert.equal(spoken('obtain_blaze_rods'), 'the hunt for blaze rods');
  assert.equal(spoken('obtain_blaze_rods', 'pt-BR'), 'a busca por varas de blaze');
  assert.equal(Spoken('reach_nether', { _jevLanguage: 'pt-BR' }), 'A viagem ao Nether');
  assert.match(spoken('diamond_sword', 'pt-BR'), /Espada de Diamante/);
});
