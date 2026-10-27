'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlanner, validatePlannerSpec, getSupportedGoalKinds } = require('../src/planner');

const blocks = [{ id: 1, name: 'oak_planks', boundingBox: 'block', hardness: 2, diggable: true },
  { id: 2, name: 'stone', boundingBox: 'block', hardness: 1.5, diggable: true },
  { id: 3, name: 'water', boundingBox: 'empty', hardness: 100, diggable: false }];
const entities = [{ id: 1, name: 'pig', type: 'animal' }, { id: 2, name: 'item', type: 'other' }];
const registry = { itemsByName: { oak_log: { id: 1 }, oak_planks: { id: 2 }, stone: { id: 3 }, stick: { id: 4 }, water: { id: 5 } },
  blocksByName: Object.fromEntries(blocks.map(block => [block.name, block])), blocksArray: blocks,
  entitiesByName: Object.fromEntries(entities.map(entity => [entity.name, entity])), entitiesArray: entities,
  biomesArray: [{ id: 1, name: 'plains', category: 'plains' }] };
const context = { registry, players: ['Alex', 'Sam'], perception: { coordinates: 'relative' },
  memory: { places: [{ id: 'home-1', label: 'Home', position: { x: 17, y: 64, z: 23 }, dimension: 'overworld' }],
    found: [{ kind: 'village', label: 'Village', position: { x: 120, y: 70, z: 80 }, dimension: 'overworld' }] } };
const payload = patch => ({ target: null, discoveryKind: null, place: null, material: null, tasks: null, ...patch });
const output = (kind, goal = payload(), patch = {}) => ({ kind, goal, item: null, count: null, deliver: null, message: 'I can help with that.', options: [], ...patch });
function fixture(value) {
  const calls = [];
  const planner = createPlanner({ client: { respond: async request => { calls.push(request); return { text: JSON.stringify(value) }; } } });
  return { calls, planner };
}
const interpret = (value, extra = {}) => fixture(value).planner.interpret('Jev help me with this', 'Alex', 'Jev', { ...context, ...extra });

test('come and follow reuse exact online player targets and default to the requester', async () => {
  for (const kind of ['come', 'follow']) {
    const self = await interpret(output(kind));
    assert.equal(self.kind, kind); assert.equal(self.target, 'Alex');
    const other = await interpret(output(kind, payload({ target: 'sAm' })));
    assert.equal(other.target, 'Sam');
    assert(validatePlannerSpec(other, context));
  }
  assert.equal((await interpret(output('follow', payload({ target: 'Offline' })))).kind, 'clarify');
});

test('find accepts only supported local registry biomes, living entities and blocks', async () => {
  for (const [discoveryKind, item] of [['biome', 'plains'], ['entity', 'pig'], ['block', 'stone']]) {
    const spec = await interpret(output('find', payload({ discoveryKind }), { item: `minecraft:${item}` }));
    assert.deepEqual(spec.discoveryTarget, { kind: discoveryKind, name: item });
    assert(validatePlannerSpec(spec, context));
  }
  for (const [discoveryKind, item] of [['entity', 'item'], ['biome', 'invented_biome'], ['block', 'missing_block']]) {
    assert.equal((await interpret(output('find', payload({ discoveryKind }), { item }))).kind, 'clarify');
  }
  await assert.rejects(interpret(output('find', payload({ discoveryKind: 'entity' }), { item: 'mod:pig' })), { code: 'invalid_plan' });
});

test('visit uses a saved place or world discovery and never accepts model-authored coordinates', async () => {
  const home = await interpret(output('visit', payload({ place: 'home-1' })));
  assert.equal(home.kind, 'visit'); assert.equal(home.destination.id, 'home-1');
  assert.deepEqual(home.destination.position, { x: 17, y: 64, z: 23 });
  const village = await interpret(output('visit', payload({ place: 'found:0' })));
  assert.equal(village.destination.label, 'Village');
  assert.equal((await interpret(output('visit', payload({ place: 'Unknown base' })))).kind, 'clarify');
  const visitPlayer = await interpret(output('visit', payload({ target: 'Sam' })));
  assert.equal(visitPlayer.kind, 'come'); assert.equal(visitPlayer.target, 'Sam');
  await assert.rejects(interpret(output('visit', { ...payload({ place: 'Home' }), position: { x: 1, y: 2, z: 3 } })), { code: 'invalid_plan' });
});

test('ambiguous remembered labels ask a question instead of selecting a location silently', async () => {
  const ambiguous = { ...context.memory, places: [...context.memory.places,
    { id: 'home-2', label: 'Home', position: { x: 140, y: 65, z: -20 }, dimension: 'overworld' }] };
  assert.equal((await interpret(output('visit', payload({ place: 'Home' })), { memory: ambiguous })).kind, 'clarify');
});

test('house materials use the existing safe building palette', async () => {
  assert.equal((await interpret(output('house'))).material, 'oak_planks');
  assert.equal((await interpret(output('house', payload({ material: 'minecraft:stone' })))).material, 'stone');
  assert.equal((await interpret(output('house', payload({ material: 'water' })))).kind, 'clarify');
});

test('building continuation reuses only the existing resolver and offered structure anchor', async () => {
  const building = { id: 'build-1', name: 'Cabin', origin: { x: 8, y: 64, z: 12 }, entrance: { x: 10, y: 64, z: 11 } };
  const calls = [], extra = { builds: [building], continueBuilds: async (request, candidates) => {
    calls.push({ request, candidates }); return { mode: 'repair', target: building, placement: 'beside_target' };
  } };
  const spec = await interpret(output('build'), extra);
  assert.equal(calls.length, 1); assert.equal(calls[0].candidates[0], building);
  assert.deepEqual(spec.continueBuild, { id: 'build-1', mode: 'repair' });
  assert.deepEqual(spec.buildAnchor, building.entrance);
  assert(validatePlannerSpec(spec, { ...context, ...extra }));
  await assert.rejects(interpret(output('build'), { builds: [], continueBuilds: async () => ({ mode: 'edit', target: building, placement: 'anywhere' }) }), { code: 'invalid_plan' });
});

test('one item bundle preserves validated obtain/craft outputs, counts and recipients', async () => {
  const tasks = [{ kind: 'obtain', item: 'minecraft:oak_log', count: 4, deliver: false }, { kind: 'craft', item: 'stick', count: 8, deliver: true }];
  const spec = await interpret(output('bundle', payload({ tasks })));
  assert.equal(spec.kind, 'bundle'); assert.equal(spec.tasks.length, 2);
  assert.deepEqual(spec.tasks.map(({ kind, item, count, deliver, from, status }) => ({ kind, item, count, deliver, from, status })), [
    { kind: 'obtain', item: 'oak_log', count: 4, deliver: false, from: 'Alex', status: 'pending' },
    { kind: 'craft', item: 'stick', count: 8, deliver: true, from: 'Alex', status: 'pending' },
  ]);
  assert(validatePlannerSpec(spec, context));
});

test('bundles reject unsupported actions, overflowing counts, duplicated outputs and arbitrary child fields', async () => {
  const task = { kind: 'obtain', item: 'oak_log', count: 4, deliver: false };
  for (const tasks of [Array(9).fill(task), [{ ...task, kind: 'come' }], [{ ...task, count: 1025 }],
    [{ ...task, command: '/op Alex' }], [{ ...task, item: 'mod:oak_log' }], [task, { ...task }]]) {
    await assert.rejects(interpret(output('bundle', payload({ tasks }))), { code: 'invalid_plan' });
  }
});

test('exploration requests expose only a small area budget and no model-authored duration', async () => {
  for (const count of [null, 1, 4]) {
    const spec = await interpret(output('explore', null, { count }));
    assert.equal(spec.kind, 'explore'); assert.equal(spec.count, count ?? 1); assert(validatePlannerSpec(spec, context));
  }
  for (const count of [0, 5, '4']) await assert.rejects(interpret(output('explore', null, { count })), { code: 'invalid_plan' });
  await assert.rejects(interpret({ ...output('explore', null), durationMs: 999999999 }), { code: 'invalid_plan' });
});

test('the production schema is strict while legacy item/chat fixture replies remain accepted', async () => {
  const value = { kind: 'chat', item: null, count: null, deliver: null, message: 'Hello.', options: [] };
  const { planner, calls } = fixture(value);
  assert.equal((await planner.interpret('Jev hello', 'Alex', 'Jev', context)).kind, 'other');
  const schema = calls[0].schema;
  assert.equal(schema.additionalProperties, false); assert(schema.required.includes('goal'));
  assert.equal(schema.properties.goal.anyOf[1].additionalProperties, false);
  assert.equal(schema.properties.goal.anyOf[1].properties.tasks.items.additionalProperties, false);
  assert(getSupportedGoalKinds().includes('follow')); assert(getSupportedGoalKinds().includes('explore'));
});

test('session validation rejects forged unsupported targets, coordinates and unrelated execution fields', async () => {
  const follow = await interpret(output('follow'));
  assert(!validatePlannerSpec({ ...follow, target: 'Offline' }, context));
  assert(!validatePlannerSpec({ ...follow, command: '/op Alex' }, context));
  const build = await interpret(output('build'));
  assert(!validatePlannerSpec({ ...build, buildAnchor: { x: 999, y: 64, z: 999 } }, context));
  const visit = await interpret(output('visit', payload({ place: 'Home' })));
  assert(!validatePlannerSpec({ ...visit, destination: { ...visit.destination, position: { x: 999, y: 64, z: 999 } } }, context));
});

test('relative and off policies remove absolute coordinates from every prompt context source', async () => {
  for (const coordinates of ['relative', 'off']) {
    const { planner, calls } = fixture(output('chat', null));
    await planner.interpret('Jev what do you see?', 'Alex', 'Jev', { ...context,
      botPosition: { x: 1234, y: 64, z: 5678 },
      activeGoal: { kind: 'find', step: { action: 'walk', position: { x: 9876, y: 64, z: 4321 } } },
      conversation: { recentEvents: [{ type: 'walk', at: '2026-10-27T12:00:00.000Z', position: { x: 1111, y: 64, z: 2222 } }] },
      perception: { coordinates, mode: 'player', range: 32, visibleEntities: [{ name: 'pig', distance: 5, direction: 'left', position: { x: 3333, y: 64, z: 4444 } }],
        sounds: [{ sound: 'entity.zombie.ambient', direction: 'right', proximity: 'near', at: 1000 }], secret: 'fixture-secret' },
    });
    const snapshot = JSON.parse(calls[0].input);
    assert.equal(snapshot.position, undefined); assert.equal(snapshot.activeGoal.step.position, undefined);
    assert(snapshot.knownPlaces.every(place => place.position === undefined));
    assert(snapshot.conversation.recentEvents.every(event => event.position === undefined));
    assert.equal(snapshot.perception.entities[0].position, undefined);
    assert.equal(snapshot.perception.sounds[0].name, 'entity.zombie.ambient');
    assert(!calls[0].input.includes('fixture-secret'));
    for (const coordinate of ['1234', '5678', '9876', '4321', '1111', '2222', '3333', '4444']) assert(!calls[0].input.includes(coordinate));
  }
});

test('a late cancelled building resolution cannot return an executable goal', async () => {
  const controller = new AbortController();
  const { planner } = fixture(output('build'));
  await assert.rejects(planner.interpret('Jev build a cabin', 'Alex', 'Jev', { ...context, continueBuilds: async () => {
    controller.abort(); return { mode: 'fresh', placement: 'anywhere' };
  } }, { signal: controller.signal }), { code: 'request_cancelled' });
});
