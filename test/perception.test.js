'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { createPerception, normalizeMode, normalizeCoordinates, viewDirection } = require('../src/perception');

class SeenBlock {
  constructor(name, position, patch = {}) {
    this.name = name; this.position = position.clone();
    this.type = { air: 0, stone: 1, chest: 2, diamond_ore: 3, glass: 4 }[name] ?? 5;
    this.stateId = this.type; this.metadata = 0;
    this.boundingBox = name === 'air' ? 'empty' : 'block';
    this.shapes = name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]];
    this.light = 15; this.skyLight = 15; this.diggable = name !== 'air';
    this._properties = {}; this.computedStates = {}; this.biome = { id: 1, name: 'plains' };
    Object.assign(this, patch);
  }
  getProperties() { return this._properties; }
  digTime() { return 100; }
}

function fixture(t, options = {}) {
  let clock = 1000, ambientLight = 15, ambientSky = 15;
  const cells = new Map(), key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const raw = Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(.5, 64, .5), velocity: new Vec3(0, 0, 0), width: .6, height: 1.8,
      eyeHeight: 1.62, yaw: 0, pitch: 0, effects: {}, metadata: [] },
    entities: {}, players: {}, username: 'Jev', game: { dimension: 'overworld' }, time: { timeOfDay: 1000 },
    registry: { effectsByName: { night_vision: { id: 9 } } },
    inventory: { items: () => [{ name: 'diamond', count: 4 }] },
    _client: new EventEmitter(),
    blockAt(p) { return cells.get(key(p)) || new SeenBlock(p.y < 64 ? 'stone' : 'air', p.floored(), { light: ambientLight, skyLight: ambientSky }); },
    findBlocks({ matching, count = 1 }) { return [...cells.values()].filter(block => typeof matching === 'function' ? matching(block) : block.type === matching).slice(0, count).map(block => block.position.clone()); },
    loadPlugin(plugin) { plugin(this); }, hasPlugin() { return false; },
  });
  raw.entities[1] = raw.entity;
  raw.world = Object.assign(new EventEmitter(), {
    getBlock: p => raw.blockAt(p), getColumn: () => ({ secretPalette: [3] }), async: { hiddenTerrain: true },
    raycast() { return [...cells.values()].at(-1) || null; },
  });
  const controller = createPerception(raw, { now: () => clock, ...options });
  t.after(() => controller.close());
  const put = (name, x, y, z, patch) => { const block = new SeenBlock(name, new Vec3(x, y, z), patch); cells.set(key(block.position), block); return block; };
  const wall = () => { for (let x = -3; x <= 3; x++) for (let y = 64; y <= 67; y++) put('stone', x, y, -2); };
  const entity = (id, name, p) => {
    const value = { id, name, type: name === 'player' ? 'player' : 'mob', position: p, velocity: new Vec3(0, 0, 0),
      width: .6, height: 1.8, isValid: true, metadata: [], equipment: [], effects: {} };
    raw.entities[id] = value; return value;
  };
  return { raw, bot: controller.bot, controller, put, wall, entity, advance: amount => { clock += amount; }, cells,
    setAmbient: (light, sky) => { ambientLight = light; ambientSky = sky; clock += 100; } };
}

test('default player view hides loaded ore behind walls, outside the field of view and beyond range', t => {
  const f = fixture(t);
  f.put('diamond_ore', 0, 65, -4); f.put('diamond_ore', 0, 65, 6); f.put('diamond_ore', 0, 65, -40);
  f.wall();
  assert.equal(f.bot.blockAt(new Vec3(0, 65, -4)), null);
  assert.equal(f.bot.blockAt(new Vec3(0, 65, 6)), null);
  assert.equal(f.bot.blockAt(new Vec3(0, 65, -40)), null);
  assert.deepEqual(f.bot.findBlocks({ matching: 3, count: 10, maxDistance: 100 }), []);
  assert.equal(f.raw.blockAt(new Vec3(0, 65, -4)).name, 'diamond_ore', 'the transport retains its real world');
});

test('exposed lit block faces and observed air are available to gameplay with Minecraft yaw and pitch conventions', t => {
  const f = fixture(t), p = new Vec3(0, 65, -4);
  f.put('diamond_ore', p.x, p.y, p.z);
  assert.equal(f.bot.perception.canSeeBlock(p), true);
  assert.equal(f.bot.blockAt(p).name, 'diamond_ore');
  assert.equal(f.bot.blockAt(new Vec3(0, 65, -1)).name, 'air');
  assert(f.bot.findBlocks({ matching: 3, count: 10, maxDistance: 8 }).some(found => found.equals(p)));
  assert(viewDirection(0, 0).distanceTo(new Vec3(0, 0, -1)) < .0001);
  assert(viewDirection(Math.PI / 2, 0).distanceTo(new Vec3(-1, 0, 0)) < .0001);
  assert(viewDirection(0, Math.PI / 2).distanceTo(new Vec3(0, 1, 0)) < .0001);
  f.raw.entity.yaw = Math.PI; f.advance(100);
  assert.equal(f.bot.perception.canSeeBlock(p), false);
});

test('darkness hides distant targets while body contact and the supporting floor remain known', t => {
  const f = fixture(t), p = new Vec3(0, 65, -4);
  f.setAmbient(0, 0);
  f.put('diamond_ore', p.x, p.y, p.z, { light: 0, skyLight: 0 });
  assert.equal(f.bot.perception.canSeeBlock(p), false);
  const floor = f.put('stone', 0, 63, 0, { light: 0, skyLight: 0 });
  assert.equal(f.bot.blockAt(floor.position).name, 'stone');
  f.raw.entity.effects[9] = { amplifier: 0, duration: 100 };
  f.advance(100);
  assert.equal(f.bot.perception.canSeeBlock(p), true, 'an actual night-vision effect is a legitimate observation aid');
});

test('night skylight reduces viewing distance rather than providing permanent daytime vision', t => {
  const f = fixture(t), p = new Vec3(0, 65, -16);
  f.setAmbient(0, 15);
  f.put('diamond_ore', p.x, p.y, p.z, { light: 0, skyLight: 15 });
  assert.equal(f.bot.perception.canSeeBlock(p), true);
  f.raw.time.timeOfDay = 18000; f.advance(100);
  assert.equal(f.bot.perception.canSeeBlock(p), false);
});

test('hidden changes preserve a detached last-observed snapshot without updating unseen terrain', t => {
  const f = fixture(t), p = new Vec3(0, 65, -4), original = f.put('diamond_ore', p.x, p.y, p.z);
  const seen = f.bot.blockAt(p);
  assert.equal(seen.name, 'diamond_ore');
  seen._properties.injected = true;
  f.wall(); original.name = 'stone'; original.type = 1; original.stateId = 1;
  f.raw.emit('blockUpdate', original, original); f.advance(100);
  const remembered = f.bot.blockAt(p);
  assert.equal(remembered.name, 'diamond_ore');
  assert.equal(remembered._jevVisible, false);
  assert.equal(remembered.getProperties().injected, undefined);
  assert.equal(original._properties.injected, undefined);
});

test('a visible container snapshot never carries block entity NBT or hidden contents', t => {
  const f = fixture(t), p = new Vec3(0, 65, -3);
  f.put('chest', p.x, p.y, p.z, { entity: { Items: ['secret'] }, blockEntity: { Items: ['secret'] }, nbt: { Items: ['secret'] }, items: ['secret'] });
  const visible = f.bot.blockAt(p);
  assert.equal(visible.name, 'chest');
  assert.equal(visible.entity, undefined); assert.equal(visible.blockEntity, undefined);
  assert.equal(visible.nbt, undefined); assert.equal(visible.items, undefined);
  assert(!JSON.stringify(visible).includes('secret'));
});

test('world and plugin access cannot bypass filtered blocks through chunk palettes or async aliases', t => {
  const f = fixture(t), p = new Vec3(0, 65, -4);
  f.put('diamond_ore', p.x, p.y, p.z); f.wall();
  assert.equal(f.bot.world.getBlock(p), null);
  assert.equal(f.bot.world.getBlockStateId(p), undefined);
  for (const key of ['getColumn', 'getColumnAt', 'getColumns', 'sections', 'async']) assert.equal(f.bot.world[key], undefined);
  assert.equal(f.bot._worldBlockAt, undefined);
  let injected;
  const plugin = bot => { injected = bot; assert.equal(bot.world.getBlock(p), null); };
  f.bot.loadPlugin(plugin);
  assert.equal(injected, f.bot);
  assert.equal(f.bot.hasPlugin(plugin), true);
  assert.equal(f.raw.world.getColumn().secretPalette[0], 3);
});

test('raycasting unknown terrain is conservative and never signals an unobserved clear path', t => {
  const f = fixture(t);
  const unknown = f.bot.world.raycast(new Vec3(20, 65, 20), new Vec3(1, 0, 0), 5);
  assert.equal(unknown._jevUnknown, true);
  assert.equal(unknown.diggable, false);
});

test('entities and player positions are visible only with sight, retaining stable detached references', t => {
  const f = fixture(t), enemy = f.entity(2, 'zombie', new Vec3(.5, 64, -3));
  const player = f.entity(3, 'player', new Vec3(1, 64, -3)); player.username = 'Alex';
  f.raw.players.Alex = { username: 'Alex', uuid: 'alex', entity: player };
  const first = f.bot.entities[2];
  assert.equal(first, f.bot.entities[2]);
  assert.notEqual(first, enemy);
  assert.equal(f.bot.entity, f.raw.entity);
  assert(f.bot.players.Alex.entity);
  assert.equal(f.bot.perception.lastSeenPlayer('Alex').visible, true);
  f.wall(); enemy.position.z = -6; player.position.z = -7; f.advance(100);
  assert.equal(f.bot.entities[2], undefined);
  assert.equal(f.bot.players.Alex.entity, undefined);
  assert.equal(first.position.z, -3, 'a retained target cannot keep following hidden packet updates');
  const last = f.bot.perception.lastSeenPlayer('ALEX');
  assert.equal(last.position.z, -3); assert.equal(last.visible, false);
});

test('entity visibility rejects invisible targets and exposes dropped-item appearance without nested item NBT', t => {
  const f = fixture(t), hidden = f.entity(2, 'zombie', new Vec3(.5, 64, -3)); hidden.metadata[0] = 0x20;
  const drop = f.entity(3, 'item', new Vec3(.5, 64, -2));
  drop.getDroppedItem = () => ({ name: 'shulker_box', type: 5, count: 64, nbt: { secret: 'contents' } });
  assert.equal(f.bot.entities[2], undefined);
  assert.equal(f.bot.entities[3].getDroppedItem().name, 'shulker_box');
  assert.equal(f.bot.entities[3].getDroppedItem().nbt, undefined);
  assert.equal(f.bot.entities[3].getDroppedItem().count, 1);
});

test('interaction checks use visible entity bounding boxes and reject hidden or distant targets', t => {
  const f = fixture(t), target = f.entity(2, 'zombie', new Vec3(.5, 64, -2.7));
  assert.equal(f.bot.perception.canInteract(target, 3), true);
  target.position.z = -8; f.advance(100);
  assert.equal(f.bot.perception.canInteract(target, 3), false);
  target.position.z = -3; f.wall(); f.advance(100);
  assert.equal(f.bot.perception.canInteract(target, 4.5), false);
});

test('gameplay entity events are filtered and translated while raw transport listeners keep their own data', t => {
  const f = fixture(t), enemy = f.entity(2, 'zombie', new Vec3(.5, 64, -3)), seen = [], rawSeen = [];
  f.raw.on('entityMoved', value => rawSeen.push(value));
  f.bot.on('entityMoved', value => seen.push(value));
  f.raw.emit('entityMoved', enemy);
  assert.equal(seen[0], f.bot.entities[2]); assert.notEqual(seen[0], enemy);
  f.wall(); f.advance(100); f.raw.emit('entityMoved', enemy);
  assert.equal(seen.length, 1); assert.equal(rawSeen.length, 2);
  let own;
  f.bot.on('entityHurt', value => { own = value; }); f.raw.emit('entityHurt', f.raw.entity);
  assert.equal(own, f.bot.entity);
});

test('raw packet listeners cannot leak spawn coordinates but actual own damage remains available without attacker location', t => {
  const f = fixture(t), leaked = [], damage = [], transport = [];
  f.bot._client.on('spawn_entity', value => leaked.push(value));
  f.bot._client.on('damage_event', value => damage.push(value));
  f.raw._client.on('spawn_entity', value => transport.push(value));
  f.raw._client.emit('spawn_entity', { entityId: 2, x: 30, y: 2, z: 40 });
  f.raw._client.emit('damage_event', { entityId: 1, sourceTypeId: 2, sourceCauseId: 3, sourcePosition: { x: 9, y: 9, z: 9 } });
  assert.equal(leaked.length, 0); assert.equal(transport.length, 1);
  assert.equal(damage.length, 1); assert.equal(damage[0].sourcePosition, undefined);
});

test('hearing uses actual emitted sounds and exposes only coarse direction and proximity', t => {
  const f = fixture(t), heard = [];
  f.bot.on('soundEffectHeard', (name, position, _volume, _pitch, detail) => heard.push({ name, position, detail }));
  f.raw.emit('soundEffectHeard', 'entity.zombie.ambient', new Vec3(.5, 64, 5), 1, 1);
  const sounds = f.controller.context().sounds;
  assert.equal(sounds.length, 1); assert.equal(sounds[0].direction, 'back'); assert.equal(sounds[0].proximity, 'near');
  assert.equal(heard[0].position, null);
  assert(!Object.hasOwn(sounds[0], 'position'));
  f.advance(6000); assert.equal(f.controller.context().sounds.length, 0);
});

test('sounds establish their world before the first visual refresh and do not follow dimension changes', t => {
  const f = fixture(t);
  f.raw.emit('soundEffectHeard', 'entity.zombie.ambient', new Vec3(.5, 64, 5), 1, 1);
  f.raw.game.dimension = 'nether';
  assert.deepEqual(f.controller.context().sounds, []);
  f.raw.emit('soundEffectHeard', 'entity.blaze.ambient', new Vec3(.5, 64, 5), 1, 1);
  assert.deepEqual(f.controller.context().sounds.map(sound => sound.sound), ['entity.blaze.ambient']);
});

test('coordinate policies bound model-facing spatial details and changing dimensions discards observations', t => {
  const f = fixture(t); f.put('diamond_ore', 0, 65, -4);
  f.controller.refresh();
  assert.deepEqual(f.controller.context().position, { x: .5, y: 64, z: .5 });
  f.controller.setCoordinates('relative');
  const relative = f.controller.context();
  assert(!JSON.stringify(relative).includes('"position"'));
  assert(relative.visibleBlocks.some(block => block.direction && Number.isFinite(block.distance)));
  f.controller.setCoordinates('off');
  assert(f.controller.context().visibleBlocks.every(block => !Object.hasOwn(block, 'distance')));
  f.raw.game.dimension = 'nether'; f.raw.entity.yaw = Math.PI; f.advance(100); f.controller.refresh();
  assert.equal(f.bot.blockAt(new Vec3(0, 65, -4)), null);
});

test('explicit unrestricted mode remains available and switching back cannot retain hidden loaded knowledge', t => {
  const f = fixture(t, { mode: 'unrestricted' }), p = new Vec3(0, 65, -4);
  f.put('diamond_ore', p.x, p.y, p.z); f.wall();
  assert.equal(f.bot.blockAt(p).name, 'diamond_ore');
  assert.equal(f.bot.world, f.raw.world);
  f.controller.setMode('player');
  assert.equal(f.bot.blockAt(p), null);
  assert.equal(f.bot.world.async, undefined);
  assert.equal(normalizeMode(), 'player');
  assert.equal(normalizeCoordinates(), 'hud');
  assert.throws(() => normalizeMode('oracle'), /JEV_PERCEPTION/);
  assert.throws(() => normalizeCoordinates('exact'), /JEV_COORDINATES/);
});

test('closing perception removes only its listeners and does not alter transport world or body physics', t => {
  const f = fixture(t), originalBlockAt = f.raw.blockAt, originalWorld = f.raw.world;
  let transportTicks = 0; f.raw.on('physicsTick', () => { transportTicks++; });
  f.bot.on('physicsTick', () => {});
  f.controller.close(); f.raw.emit('physicsTick');
  assert.equal(transportTicks, 1);
  assert.equal(f.raw.blockAt, originalBlockAt); assert.equal(f.raw.world, originalWorld);
  assert.equal(f.bot.blockAt(new Vec3(0, 65, -4)), null);
});

test('an opaque zero-light interior remains visible when its exposed face is lit by daylight air', t => {
  const f = fixture(t), p = new Vec3(0, 63, -4);
  f.setAmbient(0, 15);
  f.put('diamond_ore', p.x, p.y, p.z, { light: 0, skyLight: 0 });
  assert.equal(f.bot.perception.canSeeBlock(p), true);
  assert.equal(f.bot.blockAt(p).name, 'diamond_ore');
  f.controller.refresh();
  assert(f.bot.findBlocks({ matching: 3, count: 8, maxDistance: 8 }).some(found => found.equals(p)));
});

test('tile entity and sign event payloads are filtered, and visible blocks lose their hidden NBT', t => {
  const f = fixture(t), events = [];
  const chest = f.put('chest', 0, 65, -3, { entity: { Items: ['secret'] }, nbt: { Items: ['secret'] } });
  f.bot.on('blockEntityData', block => events.push(block));
  f.raw.emit('blockEntityData', chest);
  assert.equal(events.length, 1); assert.equal(events[0].name, 'chest');
  assert.equal(events[0].nbt, undefined); assert.equal(events[0].entity, undefined);
  f.wall(); f.advance(100); f.raw.emit('blockEntityData', chest);
  assert.equal(events.length, 1);
});

test('foreign effect details stay hidden while own hurt events survive an unseen damage source', t => {
  const f = fixture(t), enemy = f.entity(2, 'zombie', new Vec3(.5, 64, -3)), effects = [], hurts = [];
  f.bot.on('entityEffect', (...args) => effects.push(args));
  f.bot.on('entityHurt', (...args) => hurts.push(args));
  f.raw.emit('entityEffect', enemy, { id: 5, duration: 99999, amplifier: 10 });
  assert.equal(effects.length, 0);
  f.raw.emit('entityEffect', f.raw.entity, { id: 5, duration: 100, amplifier: 0 });
  assert.equal(effects.length, 1);
  f.wall(); f.advance(100); f.raw.emit('entityHurt', f.raw.entity, enemy);
  assert.equal(hurts.length, 1); assert.equal(hurts[0][0], f.raw.entity); assert.equal(hurts[0][1], undefined);
});

test('client HUD state and properties of an actually opened container remain readable', t => {
  const f = fixture(t), properties = [];
  f.raw._client.state = 'play'; f.raw._client.uuid = 'own-id';
  f.raw.currentWindow = { id: 7 }; f.raw.emit('windowOpen', f.raw.currentWindow);
  f.bot._client.on('craft_progress_bar', packet => properties.push(packet));
  f.raw._client.emit('craft_progress_bar', { windowId: 7, property: 1, value: 200 });
  f.raw._client.emit('craft_progress_bar', { windowId: 23, property: 1, value: 800 });
  assert.equal(f.bot._client.state, 'play'); assert.equal(f.bot._client.uuid, 'own-id');
  assert.equal(properties.length, 1); assert.equal(properties[0].value, 200);
});

test('gameplay listener introspection does not expose raw transport callbacks or explosion terrain probes', t => {
  const f = fixture(t), internal = () => {}, external = () => {};
  f.raw.on('windowOpen', internal); f.bot.on('windowOpen', external);
  assert.deepEqual(f.bot.listeners('windowOpen'), [external]);
  assert.deepEqual(f.bot.rawListeners('windowOpen'), [external]);
  assert.equal(f.bot._events, undefined);
  f.raw.getExplosionDamages = () => 'hidden terrain';
  assert.equal(f.bot.getExplosionDamages, undefined);
  f.bot.removeListener('windowOpen', external);
  assert(f.raw.listeners('windowOpen').includes(internal));
});

test('small physics movements refresh body contact without rescanning the whole camera cone each tick', t => {
  const f = fixture(t), original = f.raw.blockAt;
  let reads = 0;
  f.raw.blockAt = function (...args) { reads++; return original.apply(this, args); };
  f.controller.refresh();
  const initialScan = reads;
  assert(initialScan > 100);
  reads = 0;
  for (let tick = 0; tick < 10; tick++) {
    f.advance(10); f.raw.entity.position.x += .001; f.raw.entity.yaw += .001;
    f.raw.emit('physicsTick');
  }
  assert(reads < 1000, 'contact updates stay bounded while the full cone is throttled');
  assert.equal(typeof f.bot.perception.refresh, 'function');
  f.put('stone', 0, 65, -2);
  f.raw.emit('blockUpdate', null, f.raw.blockAt(new Vec3(0, 65, -2)));
  assert.equal(f.bot.perception.canSeeBlock(new Vec3(0, 65, -2)), true, 'on-demand visibility stays fresh before the next cone refresh');
});

test('particle IDs cannot impersonate the own body and disclose positions behind walls', t => {
  const f = fixture(t), seen = [];
  f.bot.on('particle', particle => seen.push(particle));
  const particle = { id: f.raw.entity.id, name: 'smoke', position: new Vec3(.5, 65, -4), offset: new Vec3(0, 0, 0), count: 1 };
  f.wall(); f.raw.emit('particle', particle);
  assert.equal(seen.length, 0);
});
