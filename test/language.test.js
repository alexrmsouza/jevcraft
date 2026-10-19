'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLanguage, languageOf, localize, displayName, formatItems } = require('../src/language');

test('language identifiers are canonical and unsupported choices are rejected', () => {
  assert.equal(normalizeLanguage('pt-br'), 'pt-BR');
  assert.equal(normalizeLanguage(' EN-us '), 'en-US');
  assert.equal(normalizeLanguage(undefined), 'en-US');
  assert.throws(() => normalizeLanguage('fr-FR'), /JEV_LANGUAGE/);
  assert.throws(() => normalizeLanguage('__proto__'), /JEV_LANGUAGE/);
});

test('inventory summaries translate names while preserving item quantities', () => {
  assert.equal(formatItems({ oak_log: 3, iron_ingot: 2 }, 'pt-BR'), '3 Tronco de Carvalho, 2 Lingote de Ferro');
  assert.equal(formatItems({ oak_log: 3 }, 'en-US'), '3 oak log');
  assert.equal(formatItems({ oak_log: 0 }, 'pt-BR'), '');
});

test('language follows the bot setting without changing the English default', () => {
  const bot = { _jevLanguage: 'pt-BR' };
  assert.equal(languageOf(bot), 'pt-BR');
  assert.equal(localize(bot, 'Ready.', 'Pronto.'), 'Pronto.');
  bot._jevLanguage = 'en-US';
  assert.equal(localize(bot, 'Ready.', 'Pronto.'), 'Ready.');
  assert.equal(languageOf({}), 'en-US');
});

test('Minecraft labels are translated locally, with readable unknown-name fallbacks', () => {
  assert.equal(displayName('diamond_pickaxe', 'pt-BR'), 'Picareta de Diamante');
  assert.equal(displayName('minecraft:oak_log', 'pt-BR'), 'Tronco de Carvalho');
  assert.equal(displayName('skeleton', { _jevLanguage: 'pt-BR' }), 'Esqueleto');
  assert.equal(displayName('warped_forest', 'pt-BR'), 'Floresta distorcida');
  assert.equal(displayName('sharpness', 'pt-BR'), 'Afiação');
  assert.equal(displayName('regeneration', 'pt-BR'), 'Regeneração');
  assert.equal(displayName('diamond_pickaxe'), 'diamond pickaxe');
  assert.equal(displayName('unlisted_future_item', 'pt-BR'), 'unlisted future item');
  assert.equal(displayName('custom:diamond_pickaxe', 'pt-BR'), 'custom:diamond pickaxe');
  assert.equal(displayName('__proto__', 'pt-BR'), '  proto  ');
});
