'use strict';

const { discoveryCatalog } = require('./discovery');
const { buildPalette } = require('./designer');
const { dimension, position } = require('./memory');
const { localize } = require('./language');

const EXTENDED_KINDS = ['come', 'follow', 'find', 'visit', 'house', 'build', 'bundle', 'explore'];
const GOAL_FIELDS = ['target', 'discoveryKind', 'place', 'material', 'tasks'];
const validId = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value);
const line = (value, maximum = 200) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum &&
  !/[\u0000-\u001f\u007f\u2028\u2029]/.test(value) && !value.trimStart().startsWith('/');
const fail = () => { throw Object.assign(new Error('Invalid supported planner goal.'), { code: 'invalid_goal' }); };
const unsupported = (message, portuguese, context, { reason = 'unsupported_goal', options = [] } = {}) => {
  throw Object.assign(new Error(localize(context.language, message, portuguese)), { code: 'unsupported_goal', reason,
    options: [...new Set(options.filter(value => line(value, 64)))].slice(0, 8) });
};

function canonicalId(value) {
  const name = typeof value === 'string' ? value.replace(/^minecraft:/, '') : value;
  return validId(name) ? name : null;
}

function onlinePlayers(context) {
  const players = Array.isArray(context.players) ? context.players : [];
  return [...new Set(players.slice(0, 128).map(value => typeof value === 'string' ? value : value?.username).filter(value => line(value, 64)))];
}

function knownPlaces(context) {
  const places = Array.isArray(context.memory?.places) ? context.memory.places : [];
  const found = Array.isArray(context.memory?.found) ? context.memory.found : [];
  return [...places.map(entry => ({ ...entry })), ...found.map((entry, index) => ({ ...entry, id: `found:${index}` }))]
    .filter(entry => position(entry.position) && line(entry.label, 80) && line(entry.dimension, 64))
    .map(entry => ({ id: line(entry.id, 96) ? entry.id : entry.label, label: entry.label,
      position: position(entry.position), dimension: dimension(entry.dimension) }));
}

function validDiscovery(registry, target) {
  if (!target || Object.keys(target).some(key => !['kind', 'name'].includes(key)) ||
    !['biome', 'entity', 'block'].includes(target.kind) || !validId(target.name)) return false;
  if (target.kind === 'block') return Object.hasOwn(registry.blocksByName || {}, target.name);
  try {
    const groups = discoveryCatalog(registry, target.kind);
    return Object.values(groups).some(group => Object.values(group.children || {}).some(entry => canonicalId(entry.name) === target.name));
  } catch { return false; }
}

function structuralMaterial(registry, value) {
  const name = canonicalId(value), block = registry.blocksByName?.[name];
  if (!name || !block || !Object.hasOwn(registry.itemsByName || {}, name) || /_(stairs|slab|door)$/.test(name)) return null;
  try { return buildPalette(registry).includes(name) ? name : null; } catch { return null; }
}

function validTasks(tasks, registry) {
  return Array.isArray(tasks) && tasks.length >= 1 && tasks.length <= 8 && tasks.every(task =>
    task && Object.keys(task).every(key => ['kind', 'item', 'count', 'deliver', 'from', 'status'].includes(key)) &&
    ['obtain', 'craft'].includes(task.kind) && validId(task.item) && Object.hasOwn(registry.itemsByName || {}, task.item) &&
    Number.isSafeInteger(task.count) && task.count >= 1 && task.count <= 1024 && typeof task.deliver === 'boolean');
}

function assertPayload(value, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== GOAL_FIELDS.length ||
    GOAL_FIELDS.some(key => !Object.hasOwn(value, key))) fail();
  const used = { come: ['target'], follow: ['target'], find: ['discoveryKind'], visit: ['target', 'place'],
    house: ['material'], build: [], bundle: ['tasks'] }[kind] || [];
  if (GOAL_FIELDS.some(key => !used.includes(key) && value[key] !== null)) fail();
}

async function prepareExtendedGoal(value, spec, context) {
  const payload = value.goal, registry = context.registry;
  assertPayload(payload, value.kind);
  if (['come', 'follow'].includes(value.kind) || value.kind === 'visit' && payload.target !== null) {
    if (value.kind === 'visit' && payload.place !== null) fail();
    const requested = payload.target === null ? spec.from : payload.target;
    if (!line(requested, 64)) fail();
    const target = onlinePlayers(context).find(name => name.toLowerCase() === requested.toLowerCase());
    if (!target) unsupported('Which online player should I go to? Name a player who is connected.', 'Até qual jogador online devo ir? Diga o nome de alguém conectado.', context,
      { reason: 'unknown_player', options: onlinePlayers(context) });
    return { ...spec, kind: value.kind === 'visit' ? 'come' : value.kind, target };
  }
  if (value.kind === 'find') {
    const name = canonicalId(value.item);
    if (!name || !['biome', 'entity', 'block'].includes(payload.discoveryKind)) fail();
    const discoveryTarget = { kind: payload.discoveryKind, name };
    if (!validDiscovery(registry, discoveryTarget)) unsupported('Which supported Minecraft biome, creature or block should I look for?', 'Qual bioma, criatura ou bloco válido do Minecraft devo procurar?', context,
      { reason: 'no_discovery_target' });
    return { ...spec, discoveryTarget };
  }
  if (value.kind === 'visit') {
    if (!line(payload.place, 96) || payload.target !== null) fail();
    const query = payload.place.toLowerCase(), matches = knownPlaces(context).filter(entry => entry.id.toLowerCase() === query || entry.label.toLowerCase() === query);
    if (matches.length !== 1) unsupported('Which saved place should I visit? I need an unambiguous remembered location.', 'Qual lugar salvo devo visitar? Preciso de uma localização lembrada sem ambiguidade.', context,
      { reason: 'unknown_place', options: knownPlaces(context).map(entry => entry.id) });
    return { ...spec, destination: matches[0] };
  }
  if (value.kind === 'house') {
    if (payload.material !== null && !canonicalId(payload.material)) fail();
    const material = structuralMaterial(registry, payload.material || 'oak_planks');
    if (!material) unsupported('Which safe solid building material should I use for the house?', 'Qual material sólido e seguro devo usar na casa?', context);
    return { ...spec, material };
  }
  if (value.kind === 'bundle') {
    if (!Array.isArray(payload.tasks) || payload.tasks.length < 1 || payload.tasks.length > 8) fail();
    const tasks = payload.tasks.map(task => {
      if (!task || typeof task !== 'object' || Array.isArray(task) || Object.keys(task).length !== 4 ||
        !['kind', 'item', 'count', 'deliver'].every(key => Object.hasOwn(task, key))) fail();
      const item = canonicalId(task.item);
      if (!item) fail();
      return { ...task, item };
    });
    if (!validTasks(tasks, registry)) fail();
    const outputs = new Set();
    for (const task of tasks) { const key = `${task.item}:${task.deliver}`; if (outputs.has(key)) fail(); outputs.add(key); }
    return { ...spec, tasks: tasks.map(task => ({ ...task, from: spec.from, status: 'pending' })) };
  }
  if (value.kind === 'build') {
    if (!context.continueBuilds) return spec;
    const continuation = await context.continueBuilds(spec.request, context.builds || []);
    if (!continuation || !['fresh', 'finish', 'repair', 'edit'].includes(continuation.mode) ||
      !['here', 'beside_target', 'anywhere'].includes(continuation.placement)) fail();
    const target = continuation.target && (context.builds || []).find(entry => entry.id === continuation.target.id);
    if (continuation.mode !== 'fresh' && !target) fail();
    const prepared = { ...spec, buildContinuation: { mode: continuation.mode, target: target?.id, name: target?.name,
      placement: continuation.placement, judgments: continuation.judgments } };
    if (['finish', 'repair'].includes(continuation.mode)) prepared.continueBuild = { id: target.id, mode: continuation.mode };
    if (continuation.mode === 'edit') prepared.buildId = target.id;
    if (target && (continuation.placement === 'beside_target' || continuation.mode === 'edit')) {
      const anchor = position(target.entrance || target.origin); if (!anchor) fail(); prepared.buildAnchor = anchor;
    } else if (continuation.placement === 'here' && position(context.speakerPosition)) prepared.buildAnchor = position(context.speakerPosition);
    return prepared;
  }
  fail();
}

function validateExtendedSpec(spec, context) {
  if (!spec || !context?.registry) return false;
  const registry = context.registry;
  if (spec.kind === 'explore') return Number.isSafeInteger(spec.count) && spec.count >= 1 && spec.count <= 4;
  if (['come', 'follow'].includes(spec.kind)) return onlinePlayers(context).includes(spec.target);
  if (spec.kind === 'find') return validDiscovery(registry, spec.discoveryTarget);
  if (spec.kind === 'visit') return spec.destination && Object.keys(spec.destination).every(key => ['id', 'label', 'position', 'dimension'].includes(key)) &&
    knownPlaces(context).some(entry => entry.id === spec.destination.id && entry.label === spec.destination.label &&
    entry.dimension === spec.destination.dimension && JSON.stringify(entry.position) === JSON.stringify(spec.destination.position));
  if (spec.kind === 'house') return structuralMaterial(registry, spec.material) === spec.material;
  if (spec.kind === 'bundle') return validTasks(spec.tasks, registry) && spec.tasks.every(task => task.from === spec.from && task.status === 'pending');
  if (spec.kind !== 'build') return false;
  if (spec.continueBuild && Object.keys(spec.continueBuild).some(key => !['id', 'mode'].includes(key))) return false;
  if (spec.buildContinuation && (!['fresh', 'finish', 'repair', 'edit'].includes(spec.buildContinuation.mode) ||
    !['here', 'beside_target', 'anywhere'].includes(spec.buildContinuation.placement))) return false;
  if (spec.continueBuild || spec.buildId || spec.buildContinuation?.target) {
    const id = spec.continueBuild?.id || spec.buildId || spec.buildContinuation.target;
    if (!(context.builds || []).some(entry => entry.id === id)) return false;
  }
  if (spec.buildAnchor) {
    const anchors = [context.speakerPosition, ...(context.builds || []).flatMap(entry => [entry.entrance, entry.origin])].map(position).filter(Boolean);
    if (!anchors.some(anchor => JSON.stringify(anchor) === JSON.stringify(position(spec.buildAnchor)))) return false;
  }
  return !spec.continueBuild || ['finish', 'repair'].includes(spec.continueBuild.mode);
}

module.exports = { EXTENDED_KINDS, GOAL_FIELDS, canonicalId, onlinePlayers, knownPlaces, prepareExtendedGoal, validateExtendedSpec };
