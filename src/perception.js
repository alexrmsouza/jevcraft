'use strict';

const { Vec3 } = require('vec3');
const { iterators: { RaycastIterator } } = require('prismarine-world');

const MODES = new Set(['player', 'unrestricted']);
const COORDINATES = new Set(['hud', 'relative', 'off']);
const normalizeMode = value => {
  const mode = String(value || 'player').trim().toLowerCase();
  if (!MODES.has(mode)) throw new Error('JEV_PERCEPTION must be player or unrestricted.');
  return mode;
};
const normalizeCoordinates = value => {
  const coordinates = String(value || 'hud').trim().toLowerCase();
  if (!COORDINATES.has(coordinates)) throw new Error('JEV_COORDINATES must be hud, relative or off.');
  return coordinates;
};
const valid = p => p && ['x', 'y', 'z'].every(key => Number.isFinite(p[key]) && Math.abs(p[key]) <= 30000000);
const vector = p => new Vec3(p.x, p.y, p.z);
const keyOf = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const plain = p => ({ x: p.x, y: p.y, z: p.z });
const clean = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 96);
const air = block => /^(air|cave_air|void_air)$/.test(block?.name || '');
const cube = [[0, 0, 0, 1, 1, 1]];
const directions = ['front', 'front_right', 'right', 'back_right', 'back', 'back_left', 'left', 'front_left'];
const blockFields = ['name', 'displayName', 'type', 'metadata', 'stateId', 'light', 'skyLight', 'boundingBox', 'transparent',
  'diggable', 'material', 'hardness', 'isWaterlogged', 'hash', 'missingStateShape'];
const entityFields = ['id', 'name', 'type', 'displayName', 'username', 'uuid', 'yaw', 'pitch', 'headYaw', 'height', 'width', 'onGround', 'isValid'];
const visibleMetadata = new Set(['pose', 'baby', 'is_baby', 'creeper_state', 'is_charged', 'swell_dir', 'is_ignited',
  'blaze_flags', 'mob_flags', 'aggressive', 'angry', 'puff_state', 'is_screaming', 'peek', 'size', 'is_sitting', 'tameable_flags']);

function cloneData(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Vec3) return value.clone();
  if (Array.isArray(value)) return value.map(cloneData);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['__proto__', 'constructor', 'prototype'].includes(key)).map(([key, field]) => [key, cloneData(field)]));
}

function viewDirection(yaw = 0, pitch = 0) {
  return new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
}

function unknownBlock(position) {
  return { name: 'unknown', type: -1, stateId: -1, position: vector(position).floored(), boundingBox: 'block',
    shapes: cube.map(shape => [...shape]), diggable: false, transparent: false, _jevUnknown: true };
}

// A gameplay view over the transport. Raw Mineflayer physics and protocol
// plugins keep their original world; no terrain or entity object is patched.
function createPerception(rawBot, { mode = 'player', coordinates = 'hud', range = 32,
  horizontalFov = 110, verticalFov = 80, maxBlocks = 12000, now = Date.now } = {}) {
  mode = normalizeMode(mode); coordinates = normalizeCoordinates(coordinates);
  range = Number.isFinite(range) ? Math.max(1, Math.min(32, range)) : 32;
  horizontalFov = Number.isFinite(horizontalFov) ? Math.max(20, Math.min(120, horizontalFov)) : 110;
  verticalFov = Number.isFinite(verticalFov) ? Math.max(20, Math.min(100, verticalFov)) : 80;
  maxBlocks = Number.isInteger(maxBlocks) ? Math.max(64, Math.min(20000, maxBlocks)) : 12000;
  const blocks = new Map(), sightings = new Map(), sounds = [], local = new Map(), pluginWrappers = new Map();
  const subscriptions = [];
  let entities = new WeakMap(), closed = false, observedDimension = null, refreshedAt = -Infinity, scannedAt = -Infinity,
    frame = '', visibility = new Map(), rawCache = new Map();
  let facade;

  const eyes = () => valid(rawBot.entity?.position) ? vector(rawBot.entity.position).offset(0,
    Number.isFinite(rawBot.entity.eyeHeight) ? rawBot.entity.eyeHeight : rawBot.entity.height > 0 ? Math.min(1.62, rawBot.entity.height * .9) : 1.62, 0) : null;
  const rawBlock = p => {
    const key = keyOf(p);
    if (rawCache.has(key)) return rawCache.get(key);
    try {
      const block = rawBot.blockAt?.call(rawBot, vector(p), false) || rawBot.world?.getBlock?.(vector(p)) || null;
      rawCache.set(key, block);
      while (rawCache.size > 8192) rawCache.delete(rawCache.keys().next().value);
      return block;
    }
    catch { return null; }
  };
  const bodyContact = p => {
    const body = rawBot.entity, at = body?.position;
    if (!valid(at)) return false;
    const width = Math.min(1, Number.isFinite(body.width) && body.width > 0 ? body.width / 2 : .3);
    const height = Math.min(2.5, Number.isFinite(body.height) && body.height > 0 ? body.height : 1.8);
    const q = vector(p).floored();
    return q.x + 1 >= at.x - width - .015 && q.x <= at.x + width + .015 &&
      q.z + 1 >= at.z - width - .015 && q.z <= at.z + width + .015 && q.y + 1 >= at.y - .015 && q.y <= at.y + height;
  };
  const visionRange = () => {
    const effects = rawBot.entity?.effects || {}, definitions = rawBot.registry?.effectsByName || {};
    const has = name => definitions[name] && effects[definitions[name].id];
    return Math.min(range, has('blindness') ? 3 : range, has('darkness') ? 8 : range,
      rawBot.entity?.isInLava ? 2 : rawBot.entity?.isInWater ? 12 : range);
  };
  const inView = p => {
    const eye = eyes(); if (!eye || !valid(p)) return false;
    const delta = vector(p).minus(eye), distance = delta.norm();
    if (distance > visionRange() || !distance) return distance === 0;
    const yaw = Number.isFinite(rawBot.entity.yaw) ? rawBot.entity.yaw : 0;
    const pitch = Number.isFinite(rawBot.entity.pitch) ? rawBot.entity.pitch : 0;
    const bearing = Math.atan2(-delta.x, -delta.z);
    const yawGap = Math.atan2(Math.sin(bearing - yaw), Math.cos(bearing - yaw));
    const targetPitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z));
    return Math.abs(yawGap) <= horizontalFov * Math.PI / 360 && Math.abs(targetPitch - pitch) <= verticalFov * Math.PI / 360;
  };
  const brightness = block => {
    const effect = rawBot.registry?.effectsByName?.night_vision || rawBot.registry?.effectsByName?.nightVision;
    if (effect && rawBot.entity?.effects?.[effect.id]) return 15;
    const time = rawBot.time?.timeOfDay;
    const daylight = !Number.isFinite(time) || time < 12500 || time > 23500;
    const sky = Number.isFinite(block?.skyLight) ? Math.max(0, block.skyLight - (daylight ? 0 : 12)) : 0;
    return Math.max(Number.isFinite(block?.light) ? block.light : 0, sky);
  };
  const lit = (block, distance, exterior) => {
    const light = Math.max(brightness(block), brightness(exterior));
    const limit = visionRange();
    return light > 0 && distance <= (light >= 8 ? limit : Math.min(limit, 3 + light * 2));
  };

  function snapshotBlock(block, at, observedAt = now(), visible = true) {
    const result = Object.create(Object.getPrototypeOf(block) || Object.prototype);
    for (const field of blockFields) if (Object.hasOwn(block, field)) result[field] = block[field];
    for (const field of ['shapes', 'harvestTools', 'drops', '_properties', 'computedStates']) {
      if (block[field] !== undefined) result[field] = cloneData(block[field]);
    }
    result.position = vector(at).floored();
    // F3 can identify the biome at the player's body, not remote cells.
    if (coordinates === 'hud' && bodyContact(at) && block.biome) result.biome = cloneData(block.biome);
    result._jevObservedAt = observedAt;
    result._jevVisible = visible;
    // Block entity NBT, container contents and unrendered data never enter a snapshot.
    return result;
  }

  function remember(block, p) {
    if (!block) return null;
    const key = keyOf(p), observedAt = now();
    const value = snapshotBlock(block, p, observedAt);
    blocks.delete(key); blocks.set(key, { block: value, at: observedAt });
    while (blocks.size > maxBlocks) blocks.delete(blocks.keys().next().value);
    return value;
  }

  function shapesOf(block) {
    if (air(block)) return [];
    return Array.isArray(block?.shapes) && block.shapes.length ? block.shapes : block?.boundingBox === 'block' ? cube : [];
  }

  function lineClear(from, to, targetKey = null) {
    const delta = to.minus(from), length = delta.norm();
    if (!length) return true;
    const iterator = new RaycastIterator(from, delta.scaled(1 / length), length);
    let cell = iterator.block, steps = 0;
    while (cell && steps++ < 128) {
      const p = vector(cell), block = rawBlock(p);
      if (!block) return false;
      const hit = iterator.intersect(/(?:^|_)glass(?:_pane)?$/.test(block.name || '') && keyOf(p) !== targetKey ? [] : shapesOf(block), p);
      if (hit && hit.pos.distanceTo(from) <= length + .001 && hit.pos.distanceTo(from) >= -.001) {
        if (keyOf(p) === targetKey) return true;
        return false;
      }
      cell = iterator.next();
    }
    return true;
  }

  // Vision can pass through glass; a hand or an attack cannot. This ray uses
  // collision geometry and requires the first encountered block to be the
  // requested block, or an entirely clear segment when aiming at an entity.
  function interactionClear(from, to, targetKey = null) {
    const delta = to.minus(from), length = delta.norm();
    if (!length) return targetKey === null || keyOf(from) === targetKey;
    const iterator = new RaycastIterator(from, delta.scaled(1 / length), length);
    let cell = iterator.block, steps = 0;
    while (cell && steps++ < 128) {
      const p = vector(cell), block = rawBlock(p);
      if (!block) return false;
      if (targetKey === keyOf(p) && targetKey === keyOf(from) && !air(block)) return true;
      const shapes = shapesOf(block);
      const hit = iterator.intersect(targetKey === keyOf(p) && !air(block) && !shapes.length ? cube : shapes, p);
      if (hit && hit.pos.distanceTo(from) <= length + .001 && hit.pos.distanceTo(from) >= -.001) return keyOf(p) === targetKey;
      cell = iterator.next();
    }
    return targetKey === null;
  }

  function faceSamples(block, position) {
    if (air(block)) return [position.offset(.5, .5, .5)];
    const shapes = shapesOf(block);
    const geometry = shapes.length ? shapes : cube;
    const eye = eyes(), samples = [];
    for (const shape of geometry.slice(0, 8)) {
      const center = position.offset((shape[0] + shape[3]) / 2, (shape[1] + shape[4]) / 2, (shape[2] + shape[5]) / 2);
      for (const [axis, a, b] of [['x', 0, 3], ['y', 1, 4], ['z', 2, 5]]) {
        const sample = center.clone(), positive = eye[axis] >= center[axis];
        sample[axis] = position[axis] + shape[positive ? b : a] + (positive ? -.0001 : .0001);
        sample._jevLightCell = position.offset(axis === 'x' ? positive ? 1 : -1 : 0,
          axis === 'y' ? positive ? 1 : -1 : 0, axis === 'z' ? positive ? 1 : -1 : 0);
        samples.push(sample);
      }
    }
    return samples;
  }

  function beginFrame() {
    const eye = eyes(), dimension = String(rawBot.game?.dimension || 'unknown');
    if (observedDimension !== null && dimension !== observedDimension) {
      blocks.clear(); sightings.clear(); sounds.length = 0; entities = new WeakMap(); rawCache.clear(); scannedAt = -Infinity;
    }
    observedDimension = dimension;
    const stamp = eye ? `${eye.x},${eye.y},${eye.z}:${rawBot.entity.yaw}:${rawBot.entity.pitch}:${dimension}` : dimension;
    if (stamp !== frame || now() - refreshedAt >= 100 || now() < refreshedAt) {
      frame = stamp; visibility = new Map(); rawCache.clear(); refreshedAt = now(); return true;
    }
    return false;
  }

  function canSeeBlock(position) {
    if (closed || !valid(position?.position || position)) return false;
    const p = vector(position.position || position).floored();
    if (mode === 'unrestricted') return Boolean(rawBlock(p));
    beginFrame();
    const key = keyOf(p);
    if (visibility.has(key)) return visibility.get(key);
    const eye = eyes();
    if (!eye || p.offset(.5, .5, .5).distanceTo(eye) > range + 1) return false;
    const block = rawBlock(p);
    if (!eye || !block) return false;
    if (bodyContact(p)) { visibility.set(key, true); remember(block, p); return true; }
    const samples = faceSamples(block, p);
    const visible = samples.some(sample => inView(sample) && lineClear(eye, sample, key) &&
      lit(block, sample.distanceTo(eye), rawBlock(sample._jevLightCell || sample)));
    visibility.set(key, visible);
    if (visible) remember(block, p);
    return visible;
  }

  function blockAt(position) {
    if (closed || !valid(position)) return null;
    if (mode === 'unrestricted') return rawBlock(position);
    const p = vector(position).floored();
    if (canSeeBlock(p)) {
      const saved = blocks.get(keyOf(p));
      return saved ? snapshotBlock(saved.block, p, saved.at, true) : null;
    }
    const saved = blocks.get(keyOf(p));
    return saved ? snapshotBlock(saved.block, p, saved.at, false) : null;
  }

  function visibleRawEntity(entity) {
    if (closed || !entity || !valid(entity.position) || entity.isValid === false) return false;
    beginFrame();
    if (entity === rawBot.entity) return true;
    if (mode === 'unrestricted') return true;
    if ((Number(entity.metadata?.[0]) || 0) & 0x20) return false;
    const eye = eyes(); if (!eye) return false;
    const height = Math.max(.2, Math.min(4, entity.height || 1));
    const points = [.25, .65, .95].map(part => vector(entity.position).offset(0, height * part, 0));
    return points.some(p => {
      if (!inView(p)) return false;
      const block = rawBlock(p);
      return block && lit(block, p.distanceTo(eye)) && lineClear(eye, p);
    });
  }

  const visibleItem = item => item ? Object.fromEntries(['name', 'type', 'metadata', 'displayName'].filter(key => item[key] !== undefined)
    .map(key => [key, item[key]]).concat([['count', 1]])) : null;

  function entitySnapshot(entity) {
    if (entity === rawBot.entity) return entity;
    let known = entities.get(entity);
    if (!known) { known = { snapshot: Object.create(Object.getPrototypeOf(entity) || Object.prototype), at: 0 }; entities.set(entity, known); }
    const snapshot = known.snapshot;
    for (const field of entityFields) if (entity[field] !== undefined) snapshot[field] = entity[field];
    snapshot.position = vector(entity.position);
    snapshot.velocity = valid(entity.velocity) ? vector(entity.velocity) : new Vec3(0, 0, 0);
    snapshot.metadata = [];
    if (entity.metadata?.[0] !== undefined) snapshot.metadata[0] = entity.metadata[0];
    if (typeof entity.metadata?.[2] === 'string') snapshot.metadata[2] = clean(entity.metadata[2]);
    const metadataKeys = rawBot.registry?.entitiesByName?.[entity.name]?.metadataKeys || [];
    for (let index = 0; index < metadataKeys.length; index++) {
      const value = entity.metadata?.[index];
      if (visibleMetadata.has(metadataKeys[index]) && ['number', 'boolean'].includes(typeof value)) snapshot.metadata[index] = value;
    }
    snapshot.equipment = (entity.equipment || []).slice(0, 6).map(visibleItem);
    snapshot.effects = {};
    if (/^(item|Item|item_stack)$/.test(entity.name || '')) {
      let dropped = null;
      try { dropped = visibleItem(entity.getDroppedItem?.()); } catch { /* Unknown visible dropped-item form. */ }
      snapshot.getDroppedItem = () => cloneData(dropped);
    }
    snapshot._jevObservedAt = known.at = now(); snapshot._jevVisible = true;
    if (entity.username) sightings.set(entity.username.toLowerCase(), { name: entity.username, position: vector(entity.position),
      dimension: String(rawBot.game?.dimension || 'unknown'), observedAt: now() });
    while (sightings.size > 128) sightings.delete(sightings.keys().next().value);
    return snapshot;
  }

  function visibleEntity(entity) {
    if (!entity) return false;
    const current = entity.id === rawBot.entity?.id ? rawBot.entity : rawBot.entities?.[entity.id];
    return Boolean(current && visibleRawEntity(current));
  }

  function visibleEntities() {
    if (closed) return {};
    if (mode === 'unrestricted') return rawBot.entities || {};
    const result = Object.create(null);
    for (const [id, entity] of Object.entries(rawBot.entities || {})) {
      if (visibleRawEntity(entity)) result[id] = entitySnapshot(entity);
      else { const known = entities.get(entity); if (known) known.snapshot._jevVisible = false; }
    }
    if (rawBot.entity?.id !== undefined) result[rawBot.entity.id] = rawBot.entity;
    return result;
  }

  function visiblePlayers() {
    if (closed) return {};
    if (mode === 'unrestricted') return rawBot.players || {};
    const result = Object.create(null);
    for (const [name, player] of Object.entries(rawBot.players || {})) {
      const value = {};
      // The online tab list is public; it is not proof a player is in sight.
      for (const field of ['username', 'uuid', 'ping', 'gamemode', 'displayName']) if (player[field] !== undefined) value[field] = cloneData(player[field]);
      if (player.entity && visibleRawEntity(player.entity)) value.entity = entitySnapshot(player.entity);
      result[name] = value;
    }
    return result;
  }

  function lastSeenPlayer(name) {
    const current = Object.values(rawBot.players || {}).find(player => String(player.username).toLowerCase() === String(name).toLowerCase());
    if (current?.entity && visibleRawEntity(current.entity)) entitySnapshot(current.entity);
    const seen = sightings.get(String(name).toLowerCase());
    return seen ? { ...seen, position: seen.position.clone(), visible: Boolean(current?.entity && visibleRawEntity(current.entity)) } : null;
  }

  function canInteract(target, reach = 4.5) {
    const eye = eyes(), position = target?.position || target;
    if (!eye || !valid(position) || !Number.isFinite(reach) || reach < 0) return false;
    if (target?.id !== undefined && target.id !== rawBot.entity?.id) {
      const current = rawBot.entities?.[target.id];
      if (!current || !visibleRawEntity(current)) return false;
      const width = Math.max(.1, Math.min(2, (current.width || .6) / 2)), height = Math.max(.1, Math.min(4, current.height || 1));
      const closest = new Vec3(Math.max(current.position.x - width, Math.min(eye.x, current.position.x + width)),
        Math.max(current.position.y, Math.min(eye.y, current.position.y + height)),
        Math.max(current.position.z - width, Math.min(eye.z, current.position.z + width)));
      return closest.distanceTo(eye) <= reach && interactionClear(eye, closest);
    }
    const p = vector(position).floored();
    if (!canSeeBlock(p)) return false;
    const current = rawBlock(p);
    if (!current || air(current)) return false;
    for (const field of ['name', 'type', 'stateId']) {
      if (target?.[field] !== undefined && current[field] !== undefined && target[field] !== current[field]) return false;
    }
    const shapes = shapesOf(current), geometry = shapes.length ? shapes : cube;
    const points = faceSamples(current, p);
    for (const shape of geometry.slice(0, 8)) {
      const center = p.offset((shape[0] + shape[3]) / 2, (shape[1] + shape[4]) / 2, (shape[2] + shape[5]) / 2);
      const closest = new Vec3(Math.max(p.x + shape[0], Math.min(eye.x, p.x + shape[3])),
        Math.max(p.y + shape[1], Math.min(eye.y, p.y + shape[4])), Math.max(p.z + shape[2], Math.min(eye.z, p.z + shape[5])));
      points.push(closest.plus(center.minus(closest).scaled(.0001)));
    }
    return points.some(point => point.distanceTo(eye) <= reach + .001 && interactionClear(eye, point, keyOf(p)));
  }

  function scanRay(eye, direction) {
    const limit = visionRange(), iterator = new RaycastIterator(eye, direction, limit);
    let cell = iterator.block, steps = 0;
    while (cell && steps++ < 128) {
      const p = vector(cell), block = rawBlock(p);
      if (!block) return;
      const hit = iterator.intersect(shapesOf(block), p);
      const contact = bodyContact(p);
      if (contact || air(block) && lit(block, p.offset(.5, .5, .5).distanceTo(eye))) remember(block, p);
      else if (hit && hit.pos.distanceTo(eye) >= -.001 && hit.pos.distanceTo(eye) <= limit) {
        // Opaque cells normally carry zero light. Their visible exterior face
        // is illuminated by the air/fluid on this side, not their interior.
        const outside = hit.pos.minus(direction.scaled(.01));
        if (lit(block, hit.pos.distanceTo(eye), rawBlock(outside))) remember(block, p);
      } else if (!shapesOf(block).length && lit(block, p.offset(.5, .5, .5).distanceTo(eye))) remember(block, p);
      if (hit && !/(?:^|_)glass(?:_pane)?$/.test(block.name || '') && hit.pos.distanceTo(eye) <= limit && hit.pos.distanceTo(eye) >= -.001) return;
      cell = iterator.next();
    }
  }

  function refresh(force = true) {
    if (closed || mode === 'unrestricted') return;
    beginFrame();
    if (force) { visibility = new Map(); rawCache.clear(); }
    const eye = eyes(); if (!eye) return;
    const feet = vector(rawBot.entity.position).floored();
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 2; y++) for (let z = -1; z <= 1; z++) {
      const p = feet.offset(x, y, z);
      if (bodyContact(p)) remember(rawBlock(p), p);
    }
    // Head movement invalidates on-demand sight immediately, but does not
    // justify rendering the complete camera cone every physics tick.
    if (!force && now() >= scannedAt && now() - scannedAt < 200) return;
    scannedAt = now();
    // Sample only a camera cone. Searches use these observations, never a
    // registry/palette scan over hidden loaded chunks.
    const yaw = Number(rawBot.entity.yaw) || 0, pitch = Number(rawBot.entity.pitch) || 0;
    for (let h = -6; h <= 6; h++) for (let v = -4; v <= 4; v++) {
      const angle = yaw + h / 6 * horizontalFov * Math.PI / 360;
      const tilt = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch + v / 4 * verticalFov * Math.PI / 360));
      scanRay(eye, viewDirection(angle, tilt));
    }
    visibleEntities();
  }

  function findBlocks(options = {}) {
    if (closed) return [];
    if (mode === 'unrestricted') return rawBot.findBlocks?.call(rawBot, options) || [];
    refresh(false);
    const center = valid(options.point) ? vector(options.point) : valid(rawBot.entity?.position) ? vector(rawBot.entity.position) : null;
    if (!center) return [];
    const distance = Number.isFinite(options.maxDistance) ? Math.max(0, Math.min(128, options.maxDistance)) : 16;
    const count = Number.isSafeInteger(options.count) ? Math.max(0, Math.min(512, options.count)) : 1;
    const match = typeof options.matching === 'function' ? options.matching : block => (Array.isArray(options.matching) ? options.matching : [options.matching]).includes(block.type);
    const results = [];
    for (const saved of [...blocks.values()]) {
      const p = saved.block.position;
      if (p.distanceTo(center) > distance) continue;
      const block = blockAt(p);
      if (!block || !match(block) || (typeof options.useExtraInfo === 'function' && !options.useExtraInfo(block))) continue;
      results.push(p.clone());
    }
    return results.sort((a, b) => a.distanceTo(center) - b.distanceTo(center)).slice(0, count);
  }

  function raycast(from, direction, distance, matcher) {
    if (mode === 'unrestricted') return rawBot.world?.raycast?.(from, direction, distance, matcher) || null;
    if (!valid(from) || !valid(direction) || !Number.isFinite(distance) || distance < 0 || !vector(direction).norm()) return null;
    const iterator = new RaycastIterator(vector(from), vector(direction).normalize(), Math.min(128, distance));
    let cell = iterator.block, steps = 0;
    while (cell && steps++ < 512) {
      const p = vector(cell), block = blockAt(p);
      if (!block) return unknownBlock(p);
      if (matcher) { if (matcher(block, iterator)) return block; }
      else {
        const hit = iterator.intersect(shapesOf(block), p);
        if (hit && hit.pos.distanceTo(from) <= distance && hit.pos.distanceTo(from) >= -.001) {
          block.face = hit.face; block.intersect = hit.pos; return block;
        }
      }
      cell = iterator.next();
    }
    return null;
  }

  function relative(p) {
    const delta = vector(p).minus(rawBot.entity.position), yaw = Number(rawBot.entity.yaw) || 0;
    const bearing = Math.atan2(-delta.x, -delta.z), angle = Math.atan2(Math.sin(yaw - bearing), Math.cos(yaw - bearing));
    return { direction: directions[(Math.round(angle / (Math.PI / 4)) + 8) % 8], distance: Math.max(0, Math.round(delta.norm() / 2) * 2) };
  }

  function heard(sound, position, volume = 1) {
    if (closed || !valid(position) || !valid(rawBot.entity?.position) || !(volume > 0)) return;
    // A sound may arrive before the first visual/context refresh. Establish
    // its world now so initialization cannot erase it or carry it elsewhere.
    beginFrame();
    const distance = vector(position).distanceTo(rawBot.entity.position);
    if (distance > Math.min(32, 16 * Math.max(1, volume))) return;
    const item = { sound: clean(sound) || 'unknown_sound', direction: relative(position).direction,
      proximity: distance <= 8 ? 'near' : distance <= 20 ? 'medium' : 'far', at: now() };
    const previous = sounds.at(-1);
    if (!previous || previous.sound !== item.sound || previous.direction !== item.direction || now() - previous.at > 150) sounds.push(item);
    while (sounds.length > 16) sounds.shift();
  }

  function context() {
    refresh(false);
    const spatial = p => coordinates === 'hud' ? { position: plain(p) } : coordinates === 'relative' ? relative(p) : {};
    const visibleBlocks = [];
    for (const { block } of [...blocks.values()].reverse()) {
      if (air(block) || !canSeeBlock(block.position)) continue;
      visibleBlocks.push({ name: clean(block.name), ...spatial(block.position) });
      if (visibleBlocks.length >= 24) break;
    }
    const visible = Object.values(visibleEntities()).filter(entity => entity.id !== rawBot.entity?.id).slice(0, 16);
    const result = { mode, coordinates, range: visionRange(), visibleBlocks, visibleEntities: visible.map(entity => ({ name: clean(entity.name), type: clean(entity.type),
      ...(entity.username && { username: clean(entity.username) }), ...spatial(entity.position) })),
      sounds: sounds.filter(sound => now() - sound.at <= 5000 && now() >= sound.at).slice(-8).map(sound => ({ ...sound })) };
    if (coordinates === 'hud' && valid(rawBot.entity?.position)) {
      result.position = plain(rawBot.entity.position);
      const biome = blockAt(rawBot.entity.position)?.biome?.name;
      if (biome) result.biome = clean(biome);
    }
    return result;
  }

  function filteredArgs(event, args) {
    if (mode === 'unrestricted') return args;
    if (event === 'particle') {
      const particle = args[0], p = particle?.position, eye = eyes();
      if (!eye || !valid(p) || !inView(p) || !lit(rawBlock(p), vector(p).distanceTo(eye)) || !lineClear(eye, vector(p))) return null;
      return [{ id: particle.id, name: clean(particle.name), position: vector(p),
        ...(valid(particle.offset) && { offset: vector(particle.offset) }), count: Math.min(100, Math.max(0, Number(particle.count) || 0)) }];
    }
    if (/^blockUpdate(?::|$)/.test(event)) {
      const next = args[1] || args[0], p = next?.position;
      if (!valid(p)) return null;
      const previous = blocks.get(keyOf(p));
      if (!canSeeBlock(p)) return null;
      const current = blockAt(p);
      return [previous ? snapshotBlock(previous.block, p, previous.at, false) : unknownBlock(p), current];
    }
    if (event === 'soundEffectHeard') {
      if (!valid(args[1]) || !valid(rawBot.entity?.position) || !(args[2] > 0) ||
        vector(args[1]).distanceTo(rawBot.entity.position) > Math.min(32, 16 * Math.max(1, args[2]))) return null;
      const item = sounds.at(-1);
      return item && now() - item.at <= 150 ? [args[0], null, args[2], args[3], { ...item }] : null;
    }
    if (event === 'hardcodedSoundEffectHeard') return null;
    if (['entityEffect', 'entityEffectEnd'].includes(event) && args[0] !== rawBot.entity) return null;
    const result = [];
    for (const value of args) {
      if (value && typeof value === 'object' && value.id !== undefined && valid(value.position)) {
        if (!visibleRawEntity(value)) { if (result.length) { result.push(undefined); continue; } return null; }
        result.push(value === rawBot.entity ? value : entitySnapshot(value));
      } else if (value && valid(value.position) && typeof value.name === 'string' &&
        (value.stateId !== undefined || value.boundingBox !== undefined)) {
        if (!canSeeBlock(value.position)) return null;
        result.push(snapshotBlock(value, value.position));
      } else if (value?.entity && value.username) result.push(visiblePlayers()[value.username] || { username: value.username, uuid: value.uuid });
      else result.push(value);
    }
    return result;
  }

  function subscribe(target, event, listener, once, filter = filteredArgs, chain = () => facade, prepend = false) {
    if (typeof listener !== 'function') throw new TypeError('The event listener must be a function.');
    const entry = { target, event, listener, wrapped: null };
    entry.wrapped = (...args) => {
      const filtered = filter(event, args);
      if (!filtered) return;
      if (once) removeSubscription(entry);
      listener.apply(chain(), filtered);
    };
    subscriptions.push(entry);
    if (prepend && typeof target.prependListener === 'function') target.prependListener(event, entry.wrapped);
    else target.on(event, entry.wrapped);
    return chain();
  }
  function removeSubscription(entry) {
    entry.target.removeListener(entry.event, entry.wrapped);
    const index = subscriptions.indexOf(entry); if (index >= 0) subscriptions.splice(index, 1);
  }
  function off(target, event, listener, chain) {
    for (const entry of [...subscriptions]) if (entry.target === target && entry.event === event && (!listener || entry.listener === listener)) removeSubscription(entry);
    return chain;
  }

  const world = Object.create(null);
  const worldArgs = (event, args) => /^blockUpdate(?::|$)/.test(event) ? filteredArgs(event, args)
    : ['chunkColumnLoad', 'chunkColumnUnload'].includes(event) ? [] : event === 'error' ? args : null;
  Object.assign(world, {
    getBlock: blockAt, raycast,
    getBlockStateId: p => blockAt(p)?.stateId,
    getBlockType: p => blockAt(p)?.type,
    getBlockData: p => blockAt(p)?.metadata,
    getBlockLight: p => blockAt(p)?.light,
    getSkyLight: p => blockAt(p)?.skyLight,
    getBiome: p => blockAt(p)?.biome?.id,
    on: (event, listener) => subscribe(rawBot.world || rawBot, event, listener, false, worldArgs, () => world),
    once: (event, listener) => subscribe(rawBot.world || rawBot, event, listener, true, worldArgs, () => world),
    off: (event, listener) => off(rawBot.world || rawBot, event, listener, world),
    removeListener: (event, listener) => off(rawBot.world || rawBot, event, listener, world),
  });
  // No getColumn/getColumnAt/getColumns/sections/async alias: those contain the
  // entire loaded terrain and would bypass the observation boundary.

  const safePackets = new Set(['playerChat', 'registry_data', 'declare_commands', 'difficulty', 'respawn', 'set_passengers', 'damage_event', 'entity_metadata',
    'position', 'held_item_slot', 'craft_progress_bar', 'window_property', 'open_window', 'close_window', 'window_items', 'set_slot']);
  const openedWindows = new Set();
  function packetArgs(event, args) {
    if (mode === 'unrestricted') return args;
    if (!safePackets.has(event)) return null;
    const packet = args[0];
    if (event === 'damage_event') {
      if (packet?.entityId !== rawBot.entity?.id) return null;
      return [Object.fromEntries(['entityId', 'sourceTypeId', 'sourceCauseId', 'sourceDirectId'].filter(key => packet[key] !== undefined).map(key => [key, packet[key]]))];
    }
    if (event === 'entity_metadata' && packet?.entityId !== rawBot.entity?.id) return null;
    if (event === 'set_passengers' && packet?.entityId !== rawBot.entity?.id && !packet?.passengers?.includes(rawBot.entity?.id)) return null;
    if (['craft_progress_bar', 'window_property', 'open_window', 'close_window', 'window_items', 'set_slot'].includes(event)) {
      const id = packet?.windowId ?? packet?.windowID;
      if (![0, -1, -2].includes(id) && id !== rawBot.currentWindow?.id && !openedWindows.has(id)) return null;
    }
    return args;
  }
  const client = Object.create(null);
  if (rawBot._client) Object.assign(client, {
    on: (event, listener) => subscribe(rawBot._client, event, listener, false, packetArgs, () => client),
    once: (event, listener) => subscribe(rawBot._client, event, listener, true, packetArgs, () => client),
    off: (event, listener) => off(rawBot._client, event, listener, client),
    removeListener: (event, listener) => off(rawBot._client, event, listener, client),
    write: (...args) => { const result = rawBot._client.write?.apply(rawBot._client, args); return result === rawBot._client ? client : result; },
    emit: (event, ...args) => (mode === 'unrestricted' || safePackets.has(event)) && rawBot._client.emit?.call(rawBot._client, event, ...args),
  });
  for (const field of ['state', 'uuid', 'ended', 'version', 'protocolVersion', 'latency']) {
    Object.defineProperty(client, field, { enumerable: true, get: () => {
      const value = rawBot._client?.[field]; return value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value) ? value : undefined;
    } });
  }

  const perceptual = {
    get mode() { return mode; }, get coordinates() { return coordinates; },
    canSeeBlock, visibleEntity, canInteract, lastSeenPlayer, context, refresh: (force = false) => refresh(force),
  };
  const overrides = {
    blockAt, findBlocks, findBlock: options => { const positions = findBlocks(options); return positions.length ? blockAt(positions[0]) : null; },
    findBlocksAsync: async (options, check = () => {}) => { check(); const found = findBlocks(options); check(); return found; },
    canSeeBlock,
    nearestEntity: (match = () => true) => Object.values(visibleEntities()).filter(entity => entity.id !== rawBot.entity?.id && match(entity))
      .sort((a, b) => a.position.distanceTo(rawBot.entity.position) - b.position.distanceTo(rawBot.entity.position))[0] || null,
    findPlayers: filter => {
      const found = Object.values(visibleEntities()).filter(entity => entity.type === 'player' &&
        (filter === null || typeof filter === 'function' && filter(entity) || filter instanceof RegExp && filter.test(entity.username) ||
          typeof filter === 'string' && String(entity.username).toLowerCase() === filter.toLowerCase()));
      return typeof filter === 'string' ? found.length === 1 ? found[0] : found.length ? found : null : found;
    },
    blockAtCursor: (distance = 6, matcher = null) => { const eye = eyes(); return eye ? raycast(eye, viewDirection(rawBot.entity?.yaw, rawBot.entity?.pitch), Math.min(range, distance), matcher) : null; },
    blockAtEntityCursor: (entity, distance = 6, matcher = null) => entity === rawBot.entity || entity?.id === rawBot.entity?.id
      ? overrides.blockAtCursor(distance, matcher) : null,
    blockInSight: (steps = 16, length = 5 / 16) => overrides.blockAtCursor(steps * length),
    entityAtCursor: (distance = 3.5) => {
      const eye = eyes(); if (!eye) return null;
      const direction = viewDirection(rawBot.entity?.yaw, rawBot.entity?.pitch), iterator = new RaycastIterator(eye, direction, distance);
      return Object.values(visibleEntities()).filter(entity => entity.id !== rawBot.entity?.id && canInteract(entity, distance))
        .map(entity => ({ entity, hit: iterator.intersect([[-(entity.width || .6) / 2, 0, -(entity.width || .6) / 2,
          (entity.width || .6) / 2, entity.height || 1, (entity.width || .6) / 2]], entity.position) }))
        .filter(entry => entry.hit && entry.hit.pos.distanceTo(eye) <= distance)
        .sort((a, b) => a.hit.pos.distanceTo(eye) - b.hit.pos.distanceTo(eye))[0]?.entity || null;
    },
    loadPlugin: plugin => {
      if (typeof plugin !== 'function') throw new TypeError('A plugin must be a function.');
      if (!pluginWrappers.has(plugin)) pluginWrappers.set(plugin, (_raw, ...options) => plugin(facade, ...options));
      const result = rawBot.loadPlugin?.call(rawBot, pluginWrappers.get(plugin));
      return result === rawBot ? facade : result;
    },
    loadPlugins: plugins => { for (const plugin of plugins) overrides.loadPlugin(plugin); },
    hasPlugin: plugin => pluginWrappers.has(plugin) || rawBot.hasPlugin?.call(rawBot, plugin),
    on: (event, listener) => subscribe(rawBot, event, listener, false),
    addListener: (event, listener) => subscribe(rawBot, event, listener, false),
    once: (event, listener) => subscribe(rawBot, event, listener, true),
    prependListener: (event, listener) => subscribe(rawBot, event, listener, false, filteredArgs, () => facade, true),
    prependOnceListener: (event, listener) => subscribe(rawBot, event, listener, true, filteredArgs, () => facade, true),
    off: (event, listener) => off(rawBot, event, listener, facade),
    removeListener: (event, listener) => off(rawBot, event, listener, facade),
    removeAllListeners: event => { for (const entry of [...subscriptions]) if (entry.target === rawBot && (event === undefined || entry.event === event)) removeSubscription(entry); return facade; },
    listeners: event => subscriptions.filter(entry => entry.target === rawBot && entry.event === event).map(entry => entry.listener),
    rawListeners: event => subscriptions.filter(entry => entry.target === rawBot && entry.event === event).map(entry => entry.listener),
    listenerCount: event => subscriptions.filter(entry => entry.target === rawBot && entry.event === event).length,
    eventNames: () => [...new Set(subscriptions.filter(entry => entry.target === rawBot).map(entry => entry.event))],
    emit: (...args) => rawBot.emit.apply(rawBot, args),
  };
  overrides.findPlayer = overrides.findPlayers;
  facade = new Proxy(Object.create(null), {
    get(_, property) {
      if (local.has(property)) return local.get(property);
      if (Object.hasOwn(overrides, property)) return overrides[property];
      if (property === 'perception') return perceptual;
      if (property === 'world') return mode === 'unrestricted' ? rawBot.world : world;
      if (property === '_client') return mode === 'unrestricted' ? rawBot._client : client;
      if (property === 'entities') return visibleEntities();
      if (property === 'players') return visiblePlayers();
      if (property === '_worldBlockAt') return undefined;
      if (property === '_events' || property === '_eventsCount') return undefined;
      if (property === 'getExplosionDamages' && mode === 'player') return undefined;
      if (property === '_playerFromUUID') return uuid => Object.values(visiblePlayers()).find(player => player.uuid === uuid);
      const value = rawBot[property];
      if (typeof value === 'function') return (...args) => { const result = value.apply(rawBot, args); return result === rawBot ? facade : result; };
      return value;
    },
    set(_, property, value) {
      if (Object.hasOwn(overrides, property) || ['world', '_client', 'entities', 'players', '_worldBlockAt', 'perception'].includes(property)) local.set(property, value);
      else rawBot[property] = value;
      return true;
    },
    deleteProperty(_, property) { return local.has(property) ? local.delete(property) : delete rawBot[property]; },
    has(_, property) { return local.has(property) || Object.hasOwn(overrides, property) || property === 'perception' || property in rawBot; },
    ownKeys() { return [...new Set([...Reflect.ownKeys(rawBot), ...local.keys(), ...Object.keys(overrides), 'perception'])]; },
    getOwnPropertyDescriptor(_, property) { return { configurable: true, enumerable: true, writable: true, value: facade[property] }; },
  });

  const onPhysics = () => refresh(false);
  const onSound = (name, p, volume) => heard(name, p, volume);
  const onUnknownSound = (_id, _category, p, volume) => heard('unknown_sound', p, volume);
  const onBlockUpdate = () => { visibility = new Map(); rawCache.clear(); refreshedAt = -Infinity; };
  const onWindow = window => { if (Number.isInteger(window?.id)) { openedWindows.add(window.id); while (openedWindows.size > 8) openedWindows.delete(openedWindows.values().next().value); } };
  rawBot.on?.('physicsTick', onPhysics);
  rawBot.on?.('soundEffectHeard', onSound);
  rawBot.on?.('hardcodedSoundEffectHeard', onUnknownSound);
  rawBot.on?.('blockUpdate', onBlockUpdate);
  rawBot.on?.('windowOpen', onWindow);

  return {
    bot: facade, context, refresh,
    setMode(value) {
      const next = normalizeMode(value);
      if (mode !== next) { mode = next; blocks.clear(); sightings.clear(); sounds.length = 0; entities = new WeakMap(); visibility = new Map(); rawCache.clear(); refreshedAt = scannedAt = -Infinity; frame = ''; }
      return mode;
    },
    setCoordinates(value) { coordinates = normalizeCoordinates(value); return coordinates; },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of [...subscriptions]) removeSubscription(entry);
      rawBot.removeListener?.('physicsTick', onPhysics);
      rawBot.removeListener?.('soundEffectHeard', onSound);
      rawBot.removeListener?.('hardcodedSoundEffectHeard', onUnknownSound);
      rawBot.removeListener?.('blockUpdate', onBlockUpdate);
      rawBot.removeListener?.('windowOpen', onWindow);
      blocks.clear(); sightings.clear(); sounds.length = 0; rawCache.clear();
    },
  };
}

module.exports = { createPerception, normalizeMode, normalizeCoordinates, viewDirection };
