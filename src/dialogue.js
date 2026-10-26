'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const QUESTION_MS = { clarify: 90000, help: 300000, suggestion: 300000 };
const NO_PROGRESS_MS = 180000;
const COOLDOWN_MS = 30000;
const QUIET_MS = 5000;
const clean = (value, limit = 200) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').trim().slice(0, limit) : '';
const owner = value => clean(value, 64).toLowerCase();
const normalized = value => clean(value, 1024).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[.!?,;:]+$/g, '').replace(/\s+/g, ' ').toLowerCase();
const finite = value => typeof value === 'number' && Number.isFinite(value);
const goalIdentity = goal => clean(goal?.memoryId || goal?.id || goal?.createdAt || goal?.request, 160);
const YES = /^(yes|yeah|yep|sure|ok|okay|please|do it|go ahead|go for it|yes please|yes go ahead|sim|sim por favor|claro|pode|pode sim|pode fazer|pode fazer isso|quero|quero sim|vai la|beleza|ta bom|manda ver|a vontade)$/;
const ACCEPT_PROPOSAL = /^(pode trazer|traga|pode levar|pode entregar|bring it|bring them|bring them to me)$/;
const RESUME = /^(resume|continue|retry|try again|go on|carry on|resume now|retome|retomar|continue agora|continuar|tente novamente|tenta novamente|tente de novo|tenta de novo|pode continuar|pode seguir|pode retomar|ja pode continuar|ja pode retomar|pronto|tudo pronto|ja resolvi|ready)$/;
const DEFER = /^(later|not now|maybe later|leave it|skip|depois|agora nao|mais tarde|deixa pra depois|deixe para depois|deixa para depois|pode deixar|nao agora)$/;
const CANCEL = /^(cancel|cancel it|stop|never mind|nevermind|cancele|cancelar|cancela|pare|parar|esquece|esqueca|deixa pra la|deixe para la)$/;
const NO = /^(no|no thanks|nope|nao|nao obrigado|nao obrigada)$/;

function questionOf(value, now) {
  if (!value || !Object.hasOwn(QUESTION_MS, value.kind) || !owner(value.from) ||
    !finite(value.createdAt) || !finite(value.until) || value.until <= now || value.createdAt > now + 60000 ||
    value.until - value.createdAt > QUESTION_MS[value.kind]) return null;
  const message = clean(value.message), proposal = clean(value.proposal, 256);
  if (!message || message.startsWith('/') || proposal.startsWith('/')) return null;
  return {
    from: clean(value.from, 64), kind: value.kind, message,
    request: clean(value.request, 1024), goalId: clean(value.goalId, 160),
    key: clean(value.key, 160),
    options: [...new Set((Array.isArray(value.options) ? value.options : []).map(v => clean(v, 80)).filter(Boolean))].slice(0, 8),
    proposal, createdAt: value.createdAt, until: value.until,
  };
}

function inventoryOf(value) {
  const result = Object.create(null);
  const entries = Array.isArray(value) ? value.map(item => [item?.name, item?.count]) : Object.entries(value || {});
  for (const [name, count] of entries.slice(0, 128)) {
    if (/^[a-z0-9_:-]{1,80}$/.test(name || '') && Number.isSafeInteger(count) && count >= 0 && count <= 1000000) {
      result[name] = (result[name] || 0) + count;
    }
  }
  return result;
}

function location(value) {
  return value && ['x', 'y', 'z'].every(k => finite(value[k])) ? { x: value.x, y: value.y, z: value.z } : null;
}

function createDialogue({ file, now = Date.now, emit = () => false, isSafe = () => true, settings = () => ({}) } = {}) {
  const questions = new Map();
  const offered = new Map();
  const watches = new Map();
  let lastSpoke = null, lastPlayerSpoke = null, serialized = '', persistenceError = null;

  function flush() {
    if (!file) return;
    const value = JSON.stringify({ version: 1, questions: [...questions.values()], offered: [...offered] });
    if (value === serialized) return;
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temp, `${value}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
      serialized = value;
      persistenceError = null;
    } catch (error) {
      persistenceError = error.code || 'persistence_failed';
      try { fs.unlinkSync(temp); } catch { /* No temporary file remains after a failed write. */ }
    }
  }

  if (file) {
    try {
      if (fs.statSync(file).size > 262144) throw new Error('Dialogue state exceeds its size limit');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1) throw new Error('Unsupported dialogue state');
      for (const raw of (Array.isArray(saved.questions) ? saved.questions : []).slice(-64)) {
        const question = questionOf(raw, now());
        if (question) questions.set(owner(question.from), question);
      }
      for (const pair of (Array.isArray(saved.offered) ? saved.offered : []).slice(-128)) {
        if (Array.isArray(pair) && clean(pair[0], 240) && finite(pair[1]) && pair[1] <= now()) offered.set(clean(pair[0], 240), pair[1]);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') persistenceError = error.code || 'invalid_state';
    }
  }

  function tick() {
    let changed = false;
    for (const [from, question] of questions) if (question.until <= now()) { questions.delete(from); changed = true; }
    if (changed) flush();
  }

  function pending(from) {
    tick();
    const value = questions.get(owner(from));
    return value ? structuredClone(value) : null;
  }

  function maySpeak(kind) {
    if (kind === 'clarify') return true;
    const policy = settings() || {};
    if (policy.narration === 'off' || policy.initiative === 'off') return false;
    if (kind === 'suggestion' && (policy.narration === 'important' || (policy.initiative || 'help') !== 'full')) return false;
    if (!isSafe()) return false;
    const clock = now();
    return (lastSpoke === null || clock - lastSpoke >= COOLDOWN_MS) &&
      (lastPlayerSpoke === null || clock - lastPlayerSpoke >= QUIET_MS);
  }

  function ask(from, spec = {}) {
    tick();
    const clock = now();
    const question = questionOf({ ...spec, from, createdAt: clock, until: clock + QUESTION_MS[spec.kind] }, clock);
    if (!question || !maySpeak(question.kind)) return null;
    const eventKey = question.key && `${owner(from)}:${question.kind}:${question.key}`;
    if (eventKey && offered.has(eventKey)) return null;
    const previous = questions.get(owner(from));
    if (previous && (previous.kind === 'help' || question.kind !== 'help')) return null;
    const level = question.kind === 'help' ? 'important' : question.kind === 'clarify' ? 'direct' : 'progress';
    if (emit(question.message, { level, from: question.from, kind: question.kind }) === false) return null;
    questions.set(owner(from), question);
    while (questions.size > 64) questions.delete(questions.keys().next().value);
    if (eventKey) {
      offered.set(eventKey, clock);
      while (offered.size > 128) offered.delete(offered.keys().next().value);
    }
    lastSpoke = clock;
    flush();
    return structuredClone(question);
  }

  function clear(from) {
    const removed = questions.delete(owner(from));
    if (removed) flush();
  }

  function reply(from, raw, { explicit = false, goalId } = {}) {
    const question = pending(from);
    const text = clean(raw, 1024), answer = normalized(text);
    if (!question || !answer) return null;
    if (question.goalId && goalId !== undefined && clean(goalId, 160) !== question.goalId) { clear(from); return null; }
    const result = action => ({ action, question });
    if (CANCEL.test(answer)) { clear(from); return result('cancel'); }
    if (DEFER.test(answer) || NO.test(answer)) { clear(from); return result('defer'); }
    if (question.kind === 'help') {
      if (RESUME.test(answer)) { clear(from); return result('resume'); }
      // Agreeing to help does not prove that a missing item or unsafe route has been fixed.
      if (YES.test(answer)) return result('acknowledge');
      return null;
    }
    if (question.kind === 'suggestion') {
      if (!(YES.test(answer) || ACCEPT_PROPOSAL.test(answer)) || !question.proposal) return null;
      clear(from);
      return { ...result('request'), request: question.proposal };
    }
    const exact = question.options.find(option => normalized(option.replaceAll('_', ' ')) === answer.replaceAll('_', ' '));
    const ordinals = new Map([['first', 0], ['the first', 0], ['primeira', 0], ['a primeira', 0], ['primeiro', 0], ['o primeiro', 0],
      ['second', 1], ['the second', 1], ['segunda', 1], ['a segunda', 1], ['segundo', 1], ['o segundo', 1],
      ['third', 2], ['the third', 2], ['terceira', 2], ['a terceira', 2], ['terceiro', 2], ['o terceiro', 2]]);
    const ordinal = answer.replace(/^(option|opcao) /, '').replace(/ (option|opcao)$/, '');
    const index = /^\d$/.test(ordinal) ? Number(ordinal) - 1 : ordinals.get(ordinal);
    const selected = exact || (Number.isInteger(index) ? question.options[index] : null);
    if (!selected || !question.request) return null;
    clear(from);
    return { ...result('clarify'), request: `${question.request} (${selected})`, explicit };
  }

  function offer(from, { key, ...spec } = {}) {
    const eventKey = `${owner(from)}:${clean(key, 160)}`;
    if (!clean(key, 160) || offered.has(eventKey)) return null;
    const question = ask(from, { ...spec, kind: 'suggestion' });
    if (question) {
      offered.set(eventKey, now());
      while (offered.size > 128) offered.delete(offered.keys().next().value);
      flush();
    }
    return question;
  }

  function notice(from, { key, message } = {}) {
    tick();
    const eventKey = `${owner(from)}:notice:${clean(key, 160)}`, line = clean(message);
    if (!owner(from) || !clean(key, 160) || !line || line.startsWith('/') || offered.has(eventKey) ||
      questions.has(owner(from)) || !maySpeak('suggestion')) return false;
    if (emit(line, { level: 'progress', from: clean(from, 64), kind: 'notice' }) === false) return false;
    offered.set(eventKey, now());
    while (offered.size > 128) offered.delete(offered.keys().next().value);
    lastSpoke = now();
    flush();
    return true;
  }

  function observeTask(from, goal, { inventory, position } = {}) {
    const id = goalIdentity(goal);
    if (!owner(from) || !id || ['complete', 'cancelled', 'replaced'].includes(goal?.status)) {
      if (owner(from)) watches.delete(owner(from));
      return { blocked: false };
    }
    const clock = now(), stock = inventoryOf(inventory), step = goal.step?.detail || goal.step || {};
    let watch = watches.get(owner(from));
    if (!watch || watch.id !== id) {
      watch = { id, progressedAt: clock, counts: Object.assign(Object.create(null), stock), distances: new Map(), remaining: Infinity,
        delivered: 0, completed: 0, lastError: '', errorCount: 0, failures: null, observation: '', blocked: null };
      watches.set(owner(from), watch);
      while (watches.size > 64) watches.delete(watches.keys().next().value);
    }
    const relevant = new Set([goal.item, step.item, step.drops, step.block, step.tool].filter(value => typeof value === 'string'));
    let improved = false;
    for (const item of relevant) {
      const count = stock[item] || 0;
      if (count > (watch.counts[item] || 0)) improved = true;
      watch.counts[item] = Math.max(watch.counts[item] || 0, count);
    }
    const remaining = step.remainingBlocks;
    if (finite(remaining) && remaining >= 0) {
      if (watch.remaining !== Infinity && remaining < watch.remaining) improved = true;
      watch.remaining = Math.min(watch.remaining, remaining);
    }
    const delivered = goal.delivered || 0, completed = (Array.isArray(goal.tasks) ? goal.tasks : []).filter(task => task.status === 'complete').length;
    if (delivered > watch.delivered || completed > watch.completed) improved = true;
    watch.delivered = Math.max(watch.delivered, delivered); watch.completed = Math.max(watch.completed, completed);
    const target = location(step.target || step.position || goal.destination?.position), at = location(position);
    if (target && at) {
      const key = `${target.x},${target.y},${target.z}`;
      const distance = Math.hypot(target.x - at.x, target.y - at.y, target.z - at.z);
      const record = watch.distances.get(key) || { best: distance, anchor: distance };
      record.best = Math.min(record.best, distance);
      if (record.anchor - record.best >= 2) { improved = true; record.anchor = record.best; }
      watch.distances.set(key, record);
      while (watch.distances.size > 64) watch.distances.delete(watch.distances.keys().next().value);
    }
    if (improved) { watch.progressedAt = clock; watch.errorCount = 0; watch.blocked = null; }
    const error = clean(goal.lastError, 256);
    // Saved timestamps and new decisions can change while the same error is retained.
    // Only a changed failure counter (or a newly observed error) is another failure.
    const failures = Number.isSafeInteger(goal.failures) && goal.failures >= 0 ? goal.failures : null;
    const marker = [failures, error].join('|');
    if (error && marker !== watch.observation) {
      const advanced = failures === null || watch.failures === null || failures > watch.failures;
      watch.errorCount = failures === 0 ? 0 : !advanced ? 1 : watch.lastError === error ? watch.errorCount + 1 : 1;
      watch.lastError = error;
    } else if (!error) { watch.errorCount = 0; watch.lastError = ''; }
    watch.failures = failures;
    watch.observation = marker;
    if (!watch.blocked && watch.errorCount >= 3) watch.blocked = 'repeated_error';
    const deadline = typeof step.until === 'string' ? Date.parse(step.until) : step.until;
    const waiting = /^(wait|sleep|hold|rest)/.test(step.action || '') && finite(deadline) && deadline > clock && deadline - clock <= 1800000;
    if (waiting) watch.progressedAt = clock;
    if (!watch.blocked && clock - watch.progressedAt >= NO_PROGRESS_MS) watch.blocked = 'no_progress';
    return watch.blocked ? { blocked: true, reason: watch.blocked } : { blocked: false };
  }

  return {
    ask, pending, reply, clear, offer, notice, tick, observeTask, flush,
    resetTask(from) { watches.delete(owner(from)); },
    playerSpoke() { lastPlayerSpoke = now(); },
    clearAll() { questions.clear(); watches.clear(); flush(); },
    get persistenceError() { return persistenceError; },
  };
}

module.exports = { createDialogue, goalIdentity, NO_PROGRESS_MS, COOLDOWN_MS, QUIET_MS };
