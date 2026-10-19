'use strict';
const portugueseNames = require('./locales/minecraft-pt-BR.json').names;

function normalizeLanguage(value) {
  const language = String(value || 'en-US').trim().toLowerCase();
  if (language === 'en-us') return 'en-US';
  if (language === 'pt-br') return 'pt-BR';
  throw new Error('JEV_LANGUAGE must be en-US or pt-BR.');
}

function languageOf(value) {
  return normalizeLanguage(typeof value === 'string' ? value : value?._jevLanguage);
}
const isPortuguese = value => languageOf(value) === 'pt-BR';
const localize = (value, english, portuguese) => isPortuguese(value) ? portuguese : english;

function displayName(value, language) {
  const identifier = String(value?.name || value || '').replace(/^minecraft:/, '');
  if (isPortuguese(language)) {
    const key = identifier.toLowerCase().replaceAll(' ', '_');
    for (const type of ['item', 'block', 'entity', 'biome', 'enchantment', 'effect']) {
      const name = `${type}.minecraft.${key}`;
      if (Object.hasOwn(portugueseNames, name)) return portugueseNames[name];
    }
  }
  return identifier.replaceAll('_', ' ');
}

function formatItems(items, language) {
  return Object.entries(items || {}).filter(([, count]) => typeof count === 'number' && count > 0)
    .map(([item, count]) => `${count} ${displayName(item, language)}`).join(', ');
}

module.exports = { normalizeLanguage, languageOf, isPortuguese, localize, displayName, formatItems };
