'use strict';

const { ConversationMemory } = require('./conversation-memory');
const { createDialogue, goalIdentity } = require('./dialogue');
const { localize, displayName } = require('./language');
const { friendlyProblem } = require('./speech');
const { immediateThreat } = require('./danger');

const samePlayer = (a, b) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
const PLACES_PT = { village: 'uma vila', mineshaft: 'uma mina abandonada', dungeon: 'uma masmorra', igloo: 'um iglu',
  ruined_portal: 'um portal em ruínas', desert_temple: 'um templo do deserto', jungle_temple: 'um templo da selva',
  lava_pool: 'um lago de lava', deep_dark: 'as profundezas sombrias', warped_forest: 'uma floresta distorcida',
  ancient_city: 'uma cidade ancestral', trial_chambers: 'câmaras do desafio', nether_fortress: 'uma fortaleza do Nether',
  bastion: 'um bastião', stronghold: 'uma fortaleza do End' };
const inventoryOf = bot => {
  const stock = Object.create(null);
  for (const item of bot.inventory?.items?.() || []) stock[item.name] = (stock[item.name] || 0) + item.count;
  return stock;
};

// This adapter observes the existing executor. It never issues a game action or
// calls a model; all accepted proposals return through the normal request gate.
function createSessionCompanion({ bot, file, dialogueFile, settings, getGoal, getDiscoveries = () => [], isReady, isWorking = () => false, onBlocked, now = Date.now }) {
  const memory = new ConversationMemory(file, { now });
  let lastPlayer = null, recipient = null, closed = false, offer = null, help = null, checkedAt = null;
  const say = (english, portuguese) => localize(settings().language, english, portuguese);
  const online = from => Object.keys(bot.players || {}).some(name => samePlayer(name, from));
  const safe = () => {
    if (closed || !isReady() || bot.isAlive === false || (bot.health ?? 20) < 14 || (bot.food ?? 20) < 10 ||
      (bot.oxygenLevel ?? 20) < 16 || (bot._alightUntil || 0) > Date.now()) return false;
    try { return !immediateThreat(bot); } catch { return false; }
  };

  const originalChat = bot.chat.bind(bot);
  const wrappedChat = message => {
    const result = originalChat(message);
    const from = recipient || getGoal()?.from || lastPlayer;
    // Operator/server commands are never conversation to replay to a model.
    if (!closed && from && typeof message === 'string' && !message.trimStart().startsWith('/')) memory.message(from, 'bot', message);
    return result;
  };
  bot.chat = wrappedChat;

  function sayTo(from, message) {
    const previous = recipient, dropped = bot._quietRepeats?.dropped || 0;
    recipient = from;
    try { bot.chat(message); return (bot._quietRepeats?.dropped || 0) === dropped; }
    finally { recipient = previous; }
  }

  const dialogue = createDialogue({ file: dialogueFile, now, settings, isSafe: safe,
    emit: (message, { from }) => sayTo(from, message) });
  const discoveryKey = entry => entry?.kind && entry?.position && [entry.position.x, entry.position.y, entry.position.z].every(Number.isFinite)
    ? `${entry.dimension || 'overworld'}:${entry.kind}:${Math.floor(entry.position.x)},${Math.floor(entry.position.y)},${Math.floor(entry.position.z)}` : null;
  // Existing discoveries are context, not fresh news on every reconnect.
  const discoveries = new Set(getDiscoveries().map(discoveryKey).filter(Boolean));
  let discovery = null;

  function helpMessage(goal, reason) {
    const issue = reason === 'no_progress'
      ? say('I have not made measurable progress for a few minutes.', 'Estou há alguns minutos sem avançar de verdade.')
      : reason === 'repeated_error'
        ? say('The same problem keeps stopping me.', 'O mesmo problema está me impedindo de avançar.')
        : friendlyProblem(goal.lastError || 'The task is blocked', { language: settings().language });
    const problem = reason === 'repeated_error' && goal.lastError
      ? ` ${friendlyProblem(goal.lastError, { language: settings().language })}` : '';
    const lead = settings().personality === 'reserved' ? '' : say('Could you help? ', 'Pode me ajudar? ');
    return `${lead}${issue}${problem}`.slice(0, 112) + say(' Say "resume" when ready, "later", or "cancel".', ' Diga "resume" quando estiver pronto, "depois" ou "cancel".');
  }

  function askHelp() {
    if (!help || !online(help.from)) return;
    const goal = getGoal();
    if (!goal || goalIdentity(goal) !== help.goalId || goal.status !== 'blocked') { help = null; return; }
    const question = dialogue.ask(help.from, { kind: 'help', key: help.key, message: helpMessage(goal, help.reason),
      request: goal.request, goalId: help.goalId, options: ['resume', 'later', 'cancel'] });
    if (question) {
      memory.record(help.from, 'help_requested', { goalId: help.goalId, reason: help.reason, error: goal.lastError });
      help = null;
    }
  }

  function observe(goal) {
    if (!goal?.from || closed) return { blocked: false };
    memory.task(goal.from, goal);
    const result = dialogue.observeTask(goal.from, goal, { inventory: inventoryOf(bot), position: bot.entity?.position });
    if (result.blocked) onBlocked(goal, result.reason);
    return result;
  }

  function blocked(goal, reason = goal.helpReason || 'blocked') {
    if (!goal?.from || goal.impossible || closed) return;
    memory.task(goal.from, goal);
    help = { from: goal.from, goalId: goalIdentity(goal), reason, key: `help:${goalIdentity(goal)}:${goal.helpEpoch || 0}` };
    offer = null;
    askHelp();
  }

  function completed(goal) {
    if (!goal?.from || closed) return;
    memory.task(goal.from, goal);
    help = null;
    if (settings().narration !== 'full' || settings().initiative !== 'full') return;
    const held = inventoryOf(bot)[goal.item] || 0;
    if (!['obtain', 'craft'].includes(goal.kind) || goal.deliver || !Number.isSafeInteger(goal.count) || held < goal.count) return;
    const amount = Math.min(goal.count, held), label = displayName(goal.item, settings().language);
    offer = { from: goal.from, goalId: goalIdentity(goal), key: `deliver:${goalIdentity(goal)}`,
        item: goal.item, count: amount, until: now() + 300000, proposal: `Bring me ${amount} ${goal.item}`,
      message: settings().personality === 'reserved'
        ? say(`Bring you ${amount} ${label}?`, `Quer que eu leve ${amount} ${label} até você?`)
        : settings().personality === 'playful'
          ? say(`I have ${amount} ${label}. Want delivery service too?`, `Tenho ${amount} ${label}. Quer serviço de entrega também?`)
          : say(`I have ${amount} ${label}. Would you like me to bring them to you?`, `Tenho ${amount} ${label}. Quer que eu leve até você?`) };
  }

  function tick() {
    if (closed) return;
    dialogue.tick();
    const optionalSpeech = settings().narration === 'full' && settings().initiative === 'full';
    if (!optionalSpeech) { offer = null; discovery = null; }
    if (isWorking() && safe() && (checkedAt === null || now() - checkedAt >= 5000)) {
      checkedAt = now();
      observe(getGoal());
    }
    askHelp();
    const from = getGoal()?.from || lastPlayer;
    for (const entry of getDiscoveries().slice(-64)) {
      const key = discoveryKey(entry);
      if (!key || discoveries.has(key)) continue;
      discoveries.add(key);
      if (discoveries.size > 256) discoveries.delete(discoveries.values().next().value);
      if (from) {
        memory.record(from, 'discovery', { item: entry.kind, text: entry.label, position: entry.position, dimension: entry.dimension });
        if (optionalSpeech) discovery = { from, key: `discovery:${key}`, kind: entry.kind, until: now() + 120000 };
      }
    }
    if (discovery && discovery.until <= now()) discovery = null;
    if (!offer && discovery && !help && online(discovery.from)) {
      const label = settings().language === 'pt-BR' && Object.hasOwn(PLACES_PT, discovery.kind)
        ? PLACES_PT[discovery.kind] : displayName(discovery.kind, settings().language);
      const message = settings().personality === 'reserved'
        ? say(`Found a ${label} nearby.`, `Encontrei ${label} por aqui.`)
        : settings().personality === 'playful'
          ? say(`A ${label} nearby. At least this trip has something to show for it.`, `Encontrei ${label} por aqui. Já temos uma novidade na viagem.`)
          : say(`I spotted a ${label} nearby. I will remember where it is.`, `Encontrei ${label} por aqui. Vou guardar a localização.`);
      if (dialogue.notice(discovery.from, { key: discovery.key, message })) discovery = null;
    }
    if (!offer || !online(offer.from)) return;
    const goal = getGoal();
    if (!goal || goal.status !== 'complete' || goalIdentity(goal) !== offer.goalId || offer.until <= now() || (inventoryOf(bot)[offer.item] || 0) < offer.count) {
      offer = null; return;
    }
    if (dialogue.offer(offer.from, offer)) offer = null;
  }

  const listeners = [];
  const listen = (event, callback) => { bot.on(event, callback); listeners.push([event, callback]); };
  const recordObserved = (type, detail) => {
    const from = getGoal()?.from || lastPlayer;
    if (from) memory.record(from, type, { ...detail, dimension: bot.game?.dimension, position: bot.entity?.position });
  };
  listen('diggingCompleted', block => recordObserved('block_broken', { item: block?.name, action: 'dig' }));
  listen('playerCollect', collector => { if (collector === bot.entity) recordObserved('items_collected', { action: 'collect' }); });
  listen('entityHurt', entity => { if (entity === bot.entity) recordObserved('hurt', { health: bot.health }); });

  return {
    memory, dialogue, safe, sayTo, observe, blocked, completed, tick,
    heard() { dialogue.playerSpoke(); },
    received(from, message) { lastPlayer = from; memory.message(from, 'player', message); },
    started(goal) {
      help = null; offer = null; discovery = null; dialogue.clearAll();
      memory.task(goal.from, goal);
      dialogue.resetTask?.(goal.from);
      observe(goal);
    },
    clearQuestions() { help = null; offer = null; discovery = null; dialogue.clearAll(); },
    reply(from, message, explicit) {
      const question = dialogue.pending(from), goal = getGoal();
      if (question?.kind === 'help' && (!goal || goal.status !== 'blocked' || !samePlayer(goal.from, from) || question.goalId !== goalIdentity(goal))) {
        dialogue.clear(from); return null;
      }
      if (question?.kind === 'suggestion') {
        const delivery = /^Bring me (\d+) ([a-z0-9_]+)$/.exec(question.proposal || '');
        if (!goal || goal.status !== 'complete' || !samePlayer(goal.from, from) || question.goalId !== goalIdentity(goal) ||
          !delivery || (inventoryOf(bot)[delivery[2]] || 0) < Number(delivery[1])) { dialogue.clear(from); return null; }
      }
      return dialogue.reply(from, message, { explicit, goalId: goalIdentity(goal) });
    },
    clarify(from, spec, request) {
      dialogue.clear(from);
      return dialogue.ask(from, { kind: 'clarify', message: spec.message, request,
        options: spec.clarification?.options || [] });
    },
    context(from) {
      const equipment = bot.entity?.equipment?.filter(Boolean).map(item => item.name) || [];
      for (const slot of [5, 6, 7, 8, 45]) {
        const name = bot.inventory?.slots?.[slot]?.name;
        if (name && !equipment.includes(name)) equipment.push(name);
      }
      if (bot.heldItem?.name && !equipment.includes(bot.heldItem.name)) equipment.push(bot.heldItem.name);
      return { conversation: memory.context(from), pendingQuestion: dialogue.pending(from), personality: settings().personality,
        vitals: { health: bot.health, food: bot.food, oxygen: bot.oxygenLevel },
        equipment,
        botPosition: bot.entity?.position };
    },
    death() { recordObserved('death', { reason: bot._deathMessage?.text || 'Observed death; possessions need to be checked again' }); help = null; offer = null; discovery = null; dialogue.clearAll(); },
    close() {
      closed = true; memory.flush(); dialogue.flush();
      for (const [event, callback] of listeners) bot.removeListener(event, callback);
      if (bot.chat === wrappedChat) bot.chat = originalChat;
    },
  };
}

module.exports = { createSessionCompanion, inventoryOf };
