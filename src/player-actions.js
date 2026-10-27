'use strict';

const { Vec3 } = require('vec3');

const finitePoint = point => point && ['x', 'y', 'z'].every(key => Number.isFinite(point[key]));
const cancelled = () => Object.assign(new Error('The action was superseded or the session ended'), { name: 'Cancelled', code: 'ACTION_CANCELLED' });
const rejected = error => { const promise = Promise.reject(error); promise.catch(() => {}); return promise; };
const unavailable = action => Object.assign(new Error(`The ${action} target is not currently visible and within player reach`),
  { name: 'Blocked', code: 'PLAYER_REACH', needsPlayer: false });

function installPlayerActions(bot, { mode = 'natural', now = Date.now, isIdle = () => Boolean(bot._waitingForRequest),
  isSafe = () => true, blockReach = 4.5, entityReach = 3, attendMs = 2000, rotationOnly = false, rotation = true } = {}) {
  if (!['natural', 'unrestricted'].includes(mode)) throw new TypeError('JEV_ACTIONS must be natural or unrestricted.');
  if (!bot || typeof bot !== 'object') throw new TypeError('A bot is required');
  const originals = new Map(), wrappers = new Map();
  let closed = false, lastAttendedAt = -Infinity, lookTicket = null;
  const reach = value => Number.isFinite(value) && value > 0 && value <= 6 ? value : 4.5;
  blockReach = reach(blockReach); entityReach = Math.min(3, reach(entityReach));

  function install(name, replacement) {
    if (typeof bot[name] !== 'function') return;
    if (bot[name] === wrappers.get(name)) return;
    const original = bot[name];
    originals.set(name, original);
    const wrapper = replacement(original);
    wrappers.set(name, wrapper);
    bot[name] = wrapper;
  }

  function check(target, distance, action) {
    if (closed) throw cancelled();
    if (!target || !bot.perception || bot.perception.canInteract?.(target, distance) !== true) throw unavailable(action);
  }

  function look(original, yaw, pitch) {
    if (closed) return rejected(cancelled());
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return rejected(new TypeError('Look angles must be finite radians'));
    lookTicket?.cancel();
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    // Some existing reflexes deliberately do not await a look. Keep supersession
    // handled while callers that do await it still receive cancellation.
    promise.catch(() => {});
    const ticket = { cancel() { reject(cancelled()); } };
    lookTicket = ticket;
    try {
      const result = original.call(bot, Math.atan2(Math.sin(yaw), Math.cos(yaw)), Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch)), false);
      Promise.resolve(result).then(value => {
        if (closed || lookTicket !== ticket) { reject(cancelled()); return; }
        lookTicket = null;
        resolve(value);
      }, error => { if (lookTicket === ticket) lookTicket = null; reject(error); });
    } catch (error) { if (lookTicket === ticket) lookTicket = null; reject(error); }
    return promise;
  }

  function bind() {
    if (closed || mode !== 'natural') return;
    if (rotation) install('look', original => (yaw, pitch) => look(original, yaw, pitch));
    if (rotation) install('lookAt', original => (point) => {
      if (closed) return rejected(cancelled());
      if (!finitePoint(point)) return rejected(new TypeError('The look target must have finite coordinates'));
      if (typeof bot.look !== 'function' || !finitePoint(bot.entity?.position)) return original.call(bot, point, false);
      const eyeHeight = Number.isFinite(bot.entity.eyeHeight) ? bot.entity.eyeHeight : 1.62;
      const dx = point.x - bot.entity.position.x, dy = point.y - bot.entity.position.y - eyeHeight,
        dz = point.z - bot.entity.position.z;
      // Calling the facade's look also covers Mineflayer methods bound to the
      // private raw bot. The normal physics plugin bounds rotation speed.
      return bot.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)), false);
    });
    if (!rotationOnly) install('dig', original => (block, forceLook, face) => {
      check(block, blockReach, 'dig');
      return original.call(bot, block, false, face);
    });
    for (const name of rotationOnly ? [] : ['placeBlock', '_placeBlockWithOptions']) install(name, original => (block, face, options) => {
      check(block, blockReach, 'placement');
      if (name === '_placeBlockWithOptions') return original.call(bot, block, face, { ...options, forceLook: false });
      return original.call(bot, block, face, options);
    });
    for (const name of rotationOnly ? [] : ['attack', 'useOn', 'activateEntity', 'activateEntityAt', 'openEntity', 'openVillager']) {
      install(name, original => (entity, ...args) => {
        if (bot.perception?.visibleEntity?.(entity) !== true) throw unavailable(name);
        check(entity, entityReach, name);
        return original.call(bot, entity, ...args);
      });
    }
    for (const name of rotationOnly ? [] : ['activateBlock', 'openBlock']) install(name, original => (block, ...args) => {
      check(block, blockReach, name);
      return original.call(bot, block, ...args);
    });
  }
  bind();
  bot.on?.('inject_allowed', bind);
  bot.on?.('spawn', bind);

  async function attend(from) {
    if (closed || rotationOnly || mode !== 'natural' || !isIdle() || !isSafe() || bot.currentWindow ||
      now() - lastAttendedAt < attendMs || typeof bot.lookAt !== 'function') return false;
    const entry = Object.entries(bot.players || {}).find(([name]) => name.toLowerCase() === String(from || '').toLowerCase())?.[1];
    const entity = entry?.entity;
    if (!entity || bot.perception?.visibleEntity?.(entity) !== true || !finitePoint(entity.position) || !finitePoint(bot.entity?.position)) return false;
    if (Math.hypot(entity.position.x - bot.entity.position.x, entity.position.y - bot.entity.position.y,
      entity.position.z - bot.entity.position.z) > 12) return false;
    lastAttendedAt = now();
    const target = new Vec3(entity.position.x, entity.position.y + Math.min(entity.height || 1.8, 1.8) * 0.9, entity.position.z);
    try { await bot.lookAt(target, false); return !closed; } catch (error) { if (error.name === 'Cancelled') return false; throw error; }
  }

  function close() {
    if (closed) return;
    closed = true;
    lookTicket?.cancel(); lookTicket = null;
    bot.removeListener?.('inject_allowed', bind);
    bot.removeListener?.('spawn', bind);
    // Do not overwrite guards installed by another component after this adapter.
    for (const [name, original] of originals) if (bot[name] === wrappers.get(name)) bot[name] = original;
  }

  return { mode, attend, close, restore: close };
}

module.exports = { installPlayerActions };
