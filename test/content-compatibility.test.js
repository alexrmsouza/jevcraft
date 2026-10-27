'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { playerConfig, playerMessage } = require('../src/player-config');
const { contentCompatibility, assertContentCompatibility } = require('../src/content-compatibility');

test('player-like defaults validate without a connection or credentials', () => {
  assert.deepEqual(playerConfig({}), { perception: 'player', coordinates: 'hud', actions: 'natural', cooperation: 'ask', loader: 'vanilla' });
  for (const field of ['JEV_PERCEPTION', 'JEV_COORDINATES', 'JEV_ACTIONS', 'JEV_COOPERATION', 'MC_LOADER']) assert.throws(() => playerConfig({ [field]: 'invalid' }), new RegExp(field));
});

test('disabling F3 coordinates also filters coordinate announcements without changing commands', () => {
  assert.equal(playerMessage('Found at 123, 64, -87.', { coordinates: 'off' }), 'Found at the observed location.');
  assert(!playerMessage('Encontrei em (123, 64, -87).', { coordinates: 'relative', language: 'pt-BR' }).includes('123'));
  assert.equal(playerMessage('/tp 123 64 -87', { coordinates: 'off' }), '/tp 123 64 -87');
});

test('connecting to a loader is not advertised as supporting arbitrary content', () => {
  assert.equal(contentCompatibility({ env: {} }).status, 'vanilla');
  assert.equal(contentCompatibility({ env: { MC_LOADER: 'fabric' } }).status, 'vanilla_protocol_only');
  for (const loader of ['forge', 'neoforge']) assert.throws(() => assertContentCompatibility({ env: { MC_LOADER: loader } }), /networking adapter/);
  assert.throws(() => assertContentCompatibility({ env: { MC_VERSION: '1.20.1' } }), /matching content adapter/);
});

test('vanilla capability checks fail closed for unknown mod items', () => {
  const report = contentCompatibility({ env: {}, registry: { itemsByName: { stone: {} } } });
  assert.equal(report.supportsItem('stone'), true);
  assert.equal(report.supportsItem('minecraft:stone'), true);
  assert.equal(report.supportsItem('missing'), false);
  assert.equal(report.supportsItem('create:andesite_alloy'), false);
});

test('trusted adapters declare exact loader, version and content capabilities', () => {
  const adapter = { id: 'fixture', loaders: ['neoforge'], supportsVersion: value => value === '1.21.1',
    supportsItem: item => item === 'example:gear', describe: () => ['example_gears'] };
  const report = assertContentCompatibility({ env: { MC_LOADER: 'neoforge', MC_VERSION: '1.21.1' }, adapter });
  assert.equal(report.supportsItem('example:gear'), true);
  assert.equal(report.supportsItem('example:engine'), false);
  assert.throws(() => assertContentCompatibility({ env: { MC_LOADER: 'forge' }, adapter }), /must declare/);
  assert.throws(() => assertContentCompatibility({ env: { MC_LOADER: 'neoforge', MC_VERSION: '1.20.1' }, adapter }), /does not support/);
});
