'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { localize } = require('./language');

const MODES = new Set(['open', 'named', 'auto']);
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

function otherPlayers({ players, username } = {}) {
  const names = Array.isArray(players) ? players.map(player => typeof player === 'string' ? player : player?.username)
    : Object.keys(players || {});
  return [...new Set(names.map(normalize).filter(name => name && name !== normalize(username)))];
}

function createChatPolicy({ host, mode, file, directory, admins } = {}) {
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(normalize(host));
  const configured = normalize(mode);
  if (configured && !MODES.has(configured)) throw new Error('JEV_CHAT_MODE must be open, named or auto.');
  const adminList = new Set((Array.isArray(admins) ? admins : String(admins || '').split(',')).map(normalize).filter(Boolean));
  const target = file ? path.resolve(directory || '.', file) : directory ? path.join(directory, 'chat-policy.json') : null;
  let saved = null;
  if (target) {
    try { const value = JSON.parse(fs.readFileSync(target, 'utf8')); if (MODES.has(value?.mode)) saved = value.mode; }
    catch { /* Missing or damaged saved state leaves the host default in effect. */ }
  }
  const current = () => configured || saved || (local ? 'open' : 'auto');
  const status = context => {
    const others = otherPlayers(context), selected = current();
    return { mode: selected, effective: selected === 'auto' ? (others.length <= 1 ? 'open' : 'named') : selected,
      source: configured ? 'env' : saved ? 'persisted' : 'default', otherPlayers: others };
  };
  const player = context => {
    const from = normalize(context?.from);
    return Boolean(from && from !== normalize(context?.username) && otherPlayers(context).includes(from));
  };
  const result = (context, message, changed = false) => ({ handled: true, changed, message, ...status(context) });
  return {
    status,
    accept(context = {}) {
      if (!player(context)) return false;
      return status(context).effective === 'open' || context.addressed === true || context.control === true || context.clarification === true;
    },
    handleCommand(text, context = {}) {
      if (typeof text !== 'string' || !/^!jev\s+chat(?:\s|$)/i.test(text.trim())) return null;
      if (!player(context)) return result(context, null);
      const say = (english, portuguese) => localize(context.language, english, portuguese);
      const match = /^!jev\s+chat(?:\s+(\S+))?\s*$/i.exec(text.trim());
      if (match && !match[1]) {
        const state = status(context);
        return result(context, say(`Chat: ${state.mode} (effective: ${state.effective}; source: ${state.source}; other players: ${state.otherPlayers.length}).`,
          `Chat: ${state.mode} (efetivo: ${state.effective}; fonte: ${state.source}; outros jogadores: ${state.otherPlayers.length}).`));
      }
      const alias = match && normalize(match[1]);
      const selected = MODES.has(alias) ? alias : null;
      if (!selected) return result(context, say('Use !jev chat open|named|auto, or !jev chat to query.', 'Use !jev chat open|named|auto, ou !jev chat para consultar.'));
      const allowed = adminList.size ? adminList.has(normalize(context.from)) : local && otherPlayers(context).length === 1;
      if (!allowed) return result(context, say('No permission to change chat settings. Configure JEV_CHAT_ADMINS.', 'Sem permissão para alterar o chat. Configure JEV_CHAT_ADMINS.'));
      if (configured) return result(context, say(`JEV_CHAT_MODE fixes chat to ${configured}; change that setting to allow chat overrides.`, `JEV_CHAT_MODE fixa o chat em ${configured}; altere essa configuração para permitir mudanças pelo chat.`));
      if (target) {
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(temporary, `${JSON.stringify({ mode: selected })}\n`, { flag: 'wx' });
          fs.renameSync(temporary, target);
        } catch {
          try { fs.unlinkSync(temporary); } catch { /* No temporary file may have been created. */ }
          return result(context, say('Could not save chat settings; the mode is unchanged.', 'Não foi possível salvar a configuração do chat; o modo continua igual.'));
        }
      }
      const changed = current() !== selected;
      saved = selected;
      return result(context, say(`Chat configured to ${selected}.`, `Chat configurado para ${selected}.`), changed);
    },
  };
}

module.exports = { createChatPolicy };
