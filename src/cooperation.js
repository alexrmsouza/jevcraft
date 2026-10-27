'use strict';

const { localize, displayName } = require('./language');

const clean = (value, size = 160) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').trim().slice(0, size) : '';
const owner = value => clean(value, 64).toLowerCase();
const idOf = goal => clean(goal?.memoryId || goal?.id || goal?.createdAt || goal?.request, 160);
const point = value => value && ['x', 'y', 'z'].every(key => Number.isFinite(value[key]) && Math.abs(value[key]) <= 30000000)
  ? { x: value.x, y: value.y, z: value.z } : null;
const dimensionOf = value => clean(value || 'overworld', 80).replace(/^minecraft:/, '').replace(/^the_/, '');
const containerName = name => /^(chest|trapped_chest|barrel|hopper|dispenser|dropper|(?:[a-z_]+_)?shulker_box|furnace|blast_furnace|smoker|brewing_stand|chest_minecart|hopper_minecart)$/.test(name || '');
const normal = value => clean(value, 200).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.!?]+$/, '').toLowerCase();
const YES = /^(yes|yeah|sure|ok|okay|go ahead|do it|yes please|sim|claro|pode|pode sim|pode usar|pode trocar|pode alterar|pode fazer|confirmo|confirmar|autorizo)$/;
const NO = /^(no|nope|no thanks|cancel|stop|later|not now|nao|nao obrigado|cancele|cancelar|pare|depois|agora nao)$/;
const ACTIVE = new Set(['pending', 'running', 'recovering', 'blocked']);
const TASKS = new Set(['obtain', 'craft', 'bundle', 'build', 'house', 'find', 'visit', 'follow', 'come', 'give', 'explore']);

class CooperationRequired extends Error {
  constructor(permissionRequest) {
    super('This container needs a player permission before it can be used');
    this.name = 'Blocked';
    this.code = 'COOPERATION_REQUIRED';
    this.needsPlayer = true;
    this.permissionRequest = structuredClone(permissionRequest);
  }
}

function createCooperation({ bot, now = Date.now, settings = () => ({}), getGoal = () => bot?._goal,
  getGeneration = () => 0, lostPlayerMs = 15000, questionMs = 90000 } = {}) {
  if (!bot) throw new TypeError('A bot is required');
  const questions = new Map(), approvals = new Map(), owned = new Set(), tracking = new Map();
  const originals = new Map(), wrappers = new Map();
  let closed = false;
  const say = (english, portuguese) => localize(settings()?.language || bot, english, portuguese);
  const generationOf = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const currentGeneration = () => generationOf(getGeneration());
  const dimension = () => dimensionOf(bot.game?.dimension);

  function targetKey(target, where = dimension()) {
    const p = point(target?.position || target);
    if (!p) return '';
    if (target?.id !== undefined) return `${where}:entity:${clean(String(target.uuid || target.id), 80)}`;
    return `${dimensionOf(where)}:${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  }

  function expire() {
    for (const [key, value] of questions) if (value.until <= now()) questions.delete(key);
    for (const [key, value] of approvals) if (value.until <= now()) approvals.delete(key);
  }

  function pending(from) {
    if (settings()?.cooperation === 'off') { questions.clear(); return null; }
    expire();
    const value = questions.get(owner(from));
    return value ? structuredClone(value) : null;
  }

  function authorizationKey(type, from, requestId, generation, goalId, target = '') {
    return JSON.stringify([type, owner(from), clean(requestId, 1024), generationOf(generation), clean(goalId), clean(target, 240)]);
  }

  function question({ type, from, requestedBy = from, requestId, generation, goalId = '', target = '', message, spec, permission }) {
    if (closed || !owner(from)) return { reason: 'missing_owner' };
    expire();
    const key = authorizationKey(type, requestedBy, requestId, generation, goalId, target);
    if (approvals.has(key)) return { approved: true };
    const previous = questions.get(owner(from));
    if (previous?.authorizationKey === key) return { question: structuredClone(previous), reason: type };
    const value = { kind: 'cooperation', type, from: clean(from, 64), requestedBy: clean(requestedBy, 64),
      requestId: clean(requestId, 1024), generation: generationOf(generation), goalId: clean(goalId), target: clean(target, 240),
      message: clean(message, 200), options: ['yes', 'no'], authorizationKey: key, until: now() + questionMs,
      ...(spec && { spec: structuredClone(spec) }), ...(permission && { permission: structuredClone(permission) }) };
    questions.set(owner(from), value);
    while (questions.size > 32) questions.delete(questions.keys().next().value);
    return { question: structuredClone(value), reason: type };
  }

  function propose(spec, { from = spec?.from, activeGoal = getGoal(), builds, generation = currentGeneration() } = {}) {
    if (closed) return { reason: 'closed' };
    if (!spec || typeof spec !== 'object' || !owner(from)) return { reason: 'invalid_request' };
    if (settings()?.cooperation === 'off') return { spec: { ...spec, from } };
    if (!TASKS.has(spec.kind)) return { spec };
    const requestId = clean(spec.requestId || spec.request, 1024), goalId = idOf(activeGoal);
    if (!requestId) return { reason: 'invalid_request' };
    if (activeGoal && ACTIVE.has(activeGoal.status) && owner(activeGoal.from) && owner(activeGoal.from) !== owner(from)) {
      const result = question({ type: 'replace_task', from: activeGoal.from, requestedBy: from, requestId, generation, goalId,
        message: say(`${activeGoal.from}, ${from} asked for different work. May I pause your task and switch?`,
          `${activeGoal.from}, ${from} pediu outra tarefa. Posso pausar a sua e trocar?`), spec: { ...spec, from } });
      if (!result.approved) return result;
    }
    const continuation = spec.buildContinuation;
    if (spec.kind === 'build' && continuation && ['edit', 'replace', 'remove', 'demolish', 'extend'].includes(continuation.mode || continuation.operation)) {
      const entries = Array.isArray(builds) ? builds : builds?.all?.() || [];
      const targetId = continuation.target || continuation.id;
      let build = entries.find(entry => entry.id === targetId ||
        (!targetId && clean(entry.name).toLowerCase() === clean(continuation.name).toLowerCase()));
      if (!build?.from && targetId && typeof bot.buildRegistry?.find === 'function') build = bot.buildRegistry.find(targetId) || build;
      const responder = build?.from || from, buildId = clean(build?.id || targetId || continuation.name);
      const result = question({ type: 'construction_edit', from: responder, requestedBy: from, requestId, generation, goalId, target: buildId,
        message: say(`${responder}, may I change ${clean(build?.name || continuation.name, 64) || 'this building'} for ${from}? Existing blocks may be removed.`,
          `${responder}, posso alterar ${clean(build?.name || continuation.name, 64) || 'essa construção'} para ${from}? Isso pode remover blocos existentes.`), spec: { ...spec, from } });
      if (!result.approved) return result;
    }
    return { spec: { ...spec, from } };
  }

  function permissionOf(target, { from, goal = getGoal(), generation = currentGeneration() } = {}) {
    const p = point(target?.position || target), key = targetKey(target);
    if (!p || !key || !owner(from || goal?.from)) return null;
    return { type: 'container', from: clean(from || goal.from, 64), key, position: p,
      name: clean(target?.name || 'container', 80), dimension: dimension(), goalId: idOf(goal),
      requestId: clean(goal?.request, 1024), generation: generationOf(generation) };
  }

  function proposePermission(permission) {
    if (settings()?.cooperation === 'off') return { approved: true };
    if (!permission || permission.type !== 'container' || !owner(permission.from) || !point(permission.position) ||
      !clean(permission.key, 240) || !permission.goalId) return { reason: 'invalid_permission' };
    const coordinates = (settings()?.coordinates || 'hud') === 'hud' ? ` ${Math.floor(permission.position.x)}, ${Math.floor(permission.position.y)}, ${Math.floor(permission.position.z)}` : '';
    const label = displayName(permission.name, settings()?.language || bot);
    const message = say(`${permission.from}, may I use this ${label}${coordinates ? ` at${coordinates}` : ''} for this task?`,
      `${permission.from}, posso usar ${label}${coordinates ? ` em${coordinates}` : ''} nesta tarefa?`);
    return question({ type: 'shared_container', from: permission.from, requestId: permission.requestId,
      generation: permission.generation, goalId: permission.goalId, target: permission.key, message, permission });
  }

  function reply(from, text, { generation = currentGeneration(), activeGoal = getGoal() } = {}) {
    const value = pending(from), answer = normal(text);
    if (!value || (!YES.test(answer) && !NO.test(answer))) return null;
    if (value.generation !== generationOf(generation) || value.goalId !== idOf(activeGoal)) {
      questions.delete(owner(from)); return { action: 'stale', question: value };
    }
    questions.delete(owner(from));
    if (NO.test(answer)) return { action: 'decline', question: value };
    approvals.set(value.authorizationKey, { until: now() + 300000 });
    while (approvals.size > 128) approvals.delete(approvals.keys().next().value);
    return { action: 'accept', question: value, ...(value.spec && { spec: structuredClone(value.spec) }),
      ...(value.permission && { permission: structuredClone(value.permission) }) };
  }

  function markOwned(target, goal = getGoal()) {
    const key = targetKey(target);
    if (!key || !containerName(target?.name)) return false;
    owned.add(key);
    while (owned.size > 128) owned.delete(owned.values().next().value);
    if (goal && typeof goal === 'object') {
      goal.cooperationOwnedContainers = [...new Set([...(Array.isArray(goal.cooperationOwnedContainers) ? goal.cooperationOwnedContainers : []), key])].slice(-128);
    }
    return true;
  }

  function isOwned(target, goal = getGoal()) {
    const key = targetKey(target);
    if (!key) return false;
    if (owned.has(key) || (Array.isArray(goal?.cooperationOwnedContainers) && goal.cooperationOwnedContainers.includes(key))) return true;
    // Existing caches provide placement evidence; proximity to a home or a
    // remembered landmark does not establish container ownership.
    return (goal?.caches || []).some(cache => cache.placedAt && cache.dimension &&
      dimensionOf(cache.dimension) === dimension() && targetKey(cache.position) === key);
  }

  function canUseContainer(target, context = {}) {
    expire();
    if (closed) return false;
    if (settings()?.cooperation === 'off') return true;
    if (target?.name === 'ender_chest') return true;
    const goal = context.goal || getGoal();
    if (isOwned(target, goal)) return true;
    const permission = permissionOf(target, { ...context, goal });
    if (!permission) return false;
    return approvals.has(authorizationKey('shared_container', permission.from, permission.requestId,
      permission.generation, permission.goalId, permission.key));
  }

  function requireContainer(target) {
    if (canUseContainer(target)) return;
    const goal = getGoal(), permission = permissionOf(target, { goal });
    if (goal && permission) goal.cooperationRequest = structuredClone(permission);
    throw new CooperationRequired(permission || { type: 'container', name: clean(target?.name || 'container', 80), key: targetKey(target) });
  }

  function install(name, build) {
    if (closed || typeof bot[name] !== 'function' || bot[name] === wrappers.get(name)) return;
    const original = bot[name], wrapper = build(original);
    originals.set(name, original); wrappers.set(name, wrapper); bot[name] = wrapper;
  }

  function installGuards() {
    for (const name of ['openContainer', 'openChest', 'openDispenser', 'openFurnace', 'openBrewingStand']) {
      install(name, original => (target, ...args) => { requireContainer(target); return original.call(bot, target, ...args); });
    }
    for (const name of ['openBlock', 'activateBlock']) install(name, original => (target, ...args) => {
      if (containerName(target?.name)) requireContainer(target);
      return original.call(bot, target, ...args);
    });
    install('openEntity', original => (target, ...args) => { requireContainer(target); return original.call(bot, target, ...args); });
    for (const name of ['placeBlock', '_placeBlockWithOptions']) install(name, original => async (reference, face, ...args) => {
      const item = clean(bot.heldItem?.name, 80), where = dimension();
      const ref = point(reference?.position), offset = point(face);
      const placedAt = ref && offset ? { x: ref.x + offset.x, y: ref.y + offset.y, z: ref.z + offset.z } : null;
      const result = await original.call(bot, reference, face, ...args);
      if (!closed && where === dimension() && containerName(item) && placedAt) {
        const actual = bot.blockAt?.(new (require('vec3').Vec3)(placedAt.x, placedAt.y, placedAt.z));
        if (actual?.name === item) markOwned(actual);
      }
      return result;
    });
    return restoreGuards;
  }
  bot.on?.('inject_allowed', installGuards);
  bot.on?.('spawn', installGuards);

  function restoreGuards() {
    for (const [name, original] of originals) if (bot[name] === wrappers.get(name)) bot[name] = original;
    originals.clear(); wrappers.clear();
  }

  function player(name, { goalId = idOf(getGoal()), generation = currentGeneration() } = {}) {
    const who = owner(name), scope = `${who}:${clean(goalId)}:${generationOf(generation)}`;
    const entry = Object.entries(bot.players || {}).find(([username]) => owner(username) === who)?.[1];
    const entity = entry?.entity;
    if (closed || !who) return { status: 'expired', pause: true, reason: 'invalid_player' };
    if (entity && bot.perception?.visibleEntity?.(entity) === true) {
      tracking.delete(scope); return { status: 'visible', pause: false, entity };
    }
    const seen = bot.perception?.lastSeenPlayer?.(name);
    const lastSeen = seen && point(seen.position) ? { name: clean(seen.name || name, 64), position: point(seen.position),
      dimension: dimensionOf(seen.dimension), observedAt: seen.observedAt, visible: false } : null;
    if (!tracking.has(scope)) tracking.set(scope, now());
    while (tracking.size > 64) tracking.delete(tracking.keys().next().value);
    const expired = now() - tracking.get(scope) >= lostPlayerMs;
    return { status: expired ? 'expired' : entry ? 'lost' : 'offline', pause: true, lastSeen,
      reason: expired ? 'player_not_seen_in_time' : entry ? 'player_not_visible' : 'player_offline', remainingMs: Math.max(0, lostPlayerMs - (now() - tracking.get(scope))) };
  }

  function canShare(item, count) {
    if (!/^[a-z0-9_:]{1,96}$/.test(item || '') || !Number.isSafeInteger(count) || count < 1) return false;
    return (bot.inventory?.items?.() || []).filter(stack => stack.name === item).reduce((sum, stack) => sum + stack.count, 0) >= count;
  }

  function close() {
    closed = true;
    bot.removeListener?.('inject_allowed', installGuards);
    bot.removeListener?.('spawn', installGuards);
    restoreGuards(); questions.clear(); approvals.clear(); tracking.clear(); owned.clear();
  }
  return { propose, proposePermission, pending, reply, canShare, canUseContainer, markOwned, isOwned, installGuards, restoreGuards,
    player, close, clear(from) { questions.delete(owner(from)); }, clearAll() { questions.clear(); approvals.clear(); tracking.clear(); } };
}

module.exports = { createCooperation, CooperationRequired, idOf };
