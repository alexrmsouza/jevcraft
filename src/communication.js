'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { normalizeLanguage, localize } = require('./language');
const { normalizePersonality, normalizeInitiative } = require('./personality');
const NARRATION = new Set(['off', 'important', 'full']);
const normalize = value => String(value || '').trim().toLowerCase();

function normalizeNarration(value) {
  const narration = normalize(value || 'full');
  if (!NARRATION.has(narration)) throw new Error('JEV_NARRATION must be off, important or full.');
  return narration;
}
const narrationOf = bot => normalizeNarration(typeof bot === 'string' ? bot : bot?._jevNarration);
const shouldNarrate = (bot, level = 'progress') => {
  const mode = narrationOf(bot);
  return mode === 'full' || (mode === 'important' && level === 'important');
};
function announce(bot, text, level = 'progress') {
  if (!text || !shouldNarrate(bot, level) || typeof bot?.chat !== 'function') return false;
  bot.chat(text);
  return true;
}
const notify = (bot, english, portuguese, level = 'progress') => announce(bot, localize(bot, english, portuguese), level);

function createCommunicationPolicy({ host, language, narration, personality, initiative, file, admins } = {}) {
  const defaults = { language: normalizeLanguage(language), narration: normalizeNarration(narration),
    personality: normalizePersonality(personality), initiative: normalizeInitiative(initiative) };
  const target = file ? path.resolve(file) : null;
  const saved = {};
  if (target) {
    try {
      const value = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (typeof value?.language === 'string') { try { saved.language = normalizeLanguage(value.language); } catch { /* Ignore unsupported saved locales. */ } }
      if (NARRATION.has(value?.narration)) saved.narration = value.narration;
      for (const [key, normalizeValue] of [['personality', normalizePersonality], ['initiative', normalizeInitiative]]) {
        if (typeof value?.[key] === 'string') {
          try { saved[key] = normalizeValue(value[key]); } catch { /* Ignore unsupported saved values. */ }
        }
      }
    } catch { /* Missing or damaged state uses configured defaults. */ }
  }
  const current = () => Object.fromEntries(Object.keys(defaults).map(key => [key, saved[key] || defaults[key]]));
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(normalize(host));
  const adminList = new Set((Array.isArray(admins) ? admins : String(admins || '').split(',')).map(normalize).filter(Boolean));
  const players = context => {
    const entries = Array.isArray(context?.players) ? context.players.map(entry => typeof entry === 'string' ? entry : entry?.username) : Object.keys(context?.players || {});
    return [...new Set(entries.map(normalize).filter(name => name && name !== normalize(context?.username)))];
  };
  const result = (message, changed = false) => ({ handled: true, changed, message, ...current() });
  const say = (english, portuguese) => localize(current().language, english, portuguese);
  return {
    get language() { return current().language; },
    get narration() { return current().narration; },
    get personality() { return current().personality; },
    get initiative() { return current().initiative; },
    handleCommand(text, context = {}) {
      if (typeof text !== 'string' || !/^!jev\s+(?:language|narration|personality|initiative)(?:\s|$)/i.test(text.trim())) return null;
      const online = players(context), from = normalize(context.from);
      if (!from || from === normalize(context.username) || !online.includes(from)) return result(null);
      const match = /^!jev\s+(language|narration|personality|initiative)(?:\s+(\S+))?\s*$/i.exec(text.trim());
      if (match && !match[2]) {
        const state = current();
        return result(say(`Language: ${state.language}. Narration: ${state.narration}. Personality: ${state.personality}. Initiative: ${state.initiative}.`,
          `Idioma: ${state.language}. Narração: ${state.narration}. Personalidade: ${state.personality}. Iniciativa: ${state.initiative}.`));
      }
      let value;
      try {
        if (!match) throw Error('Invalid command arguments');
        const normalizers = { language: normalizeLanguage, narration: normalizeNarration, personality: normalizePersonality, initiative: normalizeInitiative };
        value = normalizers[match[1].toLowerCase()](match[2]);
      } catch {
        const usages = { language: '!jev language en-US|pt-BR', narration: '!jev narration off|important|full',
          personality: '!jev personality reserved|companion|playful', initiative: '!jev initiative off|help|full' };
        const key = text.trim().split(/\s+/)[1]?.toLowerCase();
        return result(`Use ${usages[key] || '!jev language en-US|pt-BR'}.`);
      }
      const allowed = adminList.size ? adminList.has(from) : local && online.length === 1;
      if (!allowed) return result(say('You cannot change these settings. Configure JEV_CHAT_ADMINS.', 'Você não tem permissão para alterar estas configurações. Configure JEV_CHAT_ADMINS.'));
      const key = match[1].toLowerCase(), next = { ...saved, [key]: value };
      if (target) {
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, ...next })}\n`, { flag: 'wx' });
          fs.renameSync(temporary, target);
        } catch {
          try { fs.unlinkSync(temporary); } catch { /* No temporary file may exist. */ }
          return result(say('Could not save settings; nothing changed.', 'Não foi possível salvar as configurações; nada mudou.'));
        }
      }
      const changed = current()[key] !== value;
      Object.assign(saved, next);
      const messages = {
        language: [`Language set to ${value}.`, `Idioma definido como ${value}.`],
        narration: [`Narration set to ${value}.`, `Narração definida como ${value}.`],
        personality: [`Personality set to ${value}.`, `Personalidade definida como ${value}.`],
        initiative: [`Initiative set to ${value}.`, `Iniciativa definida como ${value}.`],
      };
      return result(say(...messages[key]), changed);
    },
  };
}

module.exports = { createCommunicationPolicy, normalizeNarration, narrationOf, shouldNarrate, announce, notify };
