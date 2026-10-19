'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const speech = require('../src/speech');
const { statusMessage } = require('../src/status');
const pt = { _jevLanguage: 'pt-BR', _jevNarration: 'off' };

test('activity and completion use the live language and translated Minecraft names', () => {
  assert.equal(speech.activity({ action: 'collect', item: 'oak_log' }, pt), 'Estou coletando Tronco de Carvalho.');
  assert.equal(speech.activity({ action: 'craft', item: 'diamond_pickaxe' }, 'pt-BR'), 'Estou fazendo Picareta de Diamante.');
  assert.equal(speech.activity({ action: 'hunt_mob', entity: 'cow', item: 'leather' }, pt), 'Estou caçando Vaca para conseguir Couro.');
  assert.equal(speech.completion({ kind: 'obtain', count: 2, item: 'diamond', deliver: true }, pt), 'Você recebeu 2 Diamante!');
  assert.equal(speech.completion({ kind: 'find', discoveryTarget: { name: 'cow' }, discovery: { found: { position: { x: 1.2, y: 64, z: -1.2 } } } }, pt), 'Encontrei Vaca! Está em 1, 64, -2.');
  const bot = { _jevLanguage: 'en-US' };
  assert.equal(speech.activity({ action: 'come' }, bot), "I'm coming to you.");
  bot._jevLanguage = 'pt-BR';
  assert.equal(speech.activity({ action: 'come' }, bot), 'Estou indo até você.');
});

test('Portuguese blocked explanations translate dynamic blocks and preserve useful coordinates', () => {
  const error = Object.assign(new Error('The building site changed'), { waitOn: { name: 'oak_slab', x: 3, y: 64, z: -2 } });
  assert.equal(speech.friendlyProblem(error, { bot: pt }), 'Há Laje de Carvalho em 3, 64, -2 no lugar da construção, e não fui eu que coloquei.');
  assert.match(speech.recoveryHint(error, pt), /Quebre esse bloco/);
  assert.match(speech.friendlyProblem(new Error('No route from here passes beside lava'), { language: 'pt-BR' }), /borda da lava/);
  assert.match(speech.friendlyProblem(new Error('TypeSafe API timed out'), { bot: pt }), /pensar agora/);
  assert.match(speech.intakeProblem(new Error('TypeSafe request timed out'), pt), /Jev stop.*Jev status/);
  assert.match(speech.recoveryHint(undefined, pt), /Diga "Jev resume"/);
  assert.match(speech.friendlyProblem(new Error('No measurable progress on {"action":"find_fortress"}'), { bot: pt, known: { x: 10.2, z: 20.1 } }), /fortaleza.*10, 20.*aproximar/);
});

test('all built-in activity branches have Portuguese wording', () => {
  const actions = ['boat_travel', 'reach_shore', 'prepare_build_site', 'craft', 'mine', 'collect', 'deliver', 'store_delivery', 'collect_nearby_resource', 'smelt', 'cook_food', 'make_obsidian', 'refuel_furnace', 'explore', 'approach_discovery', 'approach_found_creature', 'come', 'follow', 'visit', 'eat', 'eat_food', 'return_to_surface', 'ascend_to_surface', 'prepare_expedition_food', 'tunnel', 'return_to_mine', 'persist', 'hunt_mob', 'stalk_mob', 'find_fortress', 'recover_before_combat', 'equip_combat', 'prepare_combat_equipment', 'home_site', 'level_site', 'pour_water', 'return_home', 'place_bed', 'claim_bed', 'place_chest', 'till', 'plant', 'build_pen', 'gather_wool', 'restock', 'stash_valuables', 'sleep', 'stay_up', 'return_to_portal', 'enter_nether', 'return_overworld', 'unknown'];
  for (const action of actions) {
    const step = { action, item: 'diamond', entity: 'cow', name: 'cow' };
    assert.notEqual(speech.activity(step, pt), speech.activity(step), action);
    assert.doesNotMatch(speech.activity(step, pt), /I'm |I'll |There's |Heading |Making /, action);
  }
});

test('Portuguese status replies stay available with narration off and translate bundle progress', () => {
  const goal = { kind: 'bundle', status: 'running', tasks: [{ item: 'diamond', status: 'complete' }, { item: 'white_bed' }], step: { action: 'combined_request', detail: { action: 'craft', item: 'white_bed' } } };
  assert.equal(statusMessage(pt, { goal }), 'Estou fazendo Cama Branca. 1 de 2 itens concluídos. Próximo: Cama Branca.');
  assert.equal(statusMessage(pt, null, { status: 'complete' }), 'Terminei sua última tarefa.');
  assert.match(statusMessage(pt, null, { status: 'cancelled' }), /Parei.*Jev resume/);
  assert.equal(statusMessage(pt, null, null), 'Estou pronto. O que vamos fazer?');
  const win = { kind: 'win', status: 'running', gameProgress: { phase: 'iron_armour' }, step: { action: 'tunnel', target: { y: 16 } }, survival: { home: { origin: { x: 10, z: 20 }, bed: { claimedAt: 'now' } } } };
  assert.match(statusMessage(pt, { goal: win }), /^Zerando o jogo, na etapa de armadura de ferro\..*y=16.*Base em 10, 20/);
});

test('automatic work blockages respect narration off and important without hiding direct status', async () => {
  const { runGoal } = require('../src/work');
  for (const narration of ['off', 'important', 'full']) {
    const said = [];
    const bot = { _jevLanguage: 'pt-BR', _jevNarration: narration, game: { dimension: 'overworld' }, pathfinder: { movements: {} }, chat: text => said.push(text) };
    const goal = { kind: 'obtain', item: 'diamond', count: 1 };
    await runGoal(bot, {}, goal, { save() {} }, { maxSteps: 0, survival: { state: {} }, recoveryAdviser: {} });
    require('../src/stillness').unwatchStalls(bot);
    assert.equal(said.length, narration === 'off' ? 0 : 1, narration);
    if (said.length) assert.match(said[0], /demorando.*progresso.*Jev resume/);
    assert.match(statusMessage(bot, null, goal), /Jev resume/, narration);
  }
});

test('routine building progress is Portuguese only in full narration and does not affect the task', async () => {
  const { EventEmitter } = require('node:events');
  const { designedBuildStep } = require('../src/work');
  for (const narration of ['off', 'important', 'full']) {
    const said = [], bot = new EventEmitter();
    Object.assign(bot, { _jevLanguage: 'pt-BR', _jevNarration: narration, chat: text => said.push(text), buildRegistry: { find: () => ({ id: 'fixture', name: 'Cabana', blueprint: { blocks: [] } }) } });
    const goal = { continueBuild: { id: 'fixture', mode: 'repair' } }; let saves = 0;
    assert.equal(await designedBuildStep(bot, {}, goal, () => saves++), false);
    assert.equal(goal.step.action, 'repair_building');
    assert.ok(saves > 0);
    assert.equal(bot.listenerCount('blockPlaced'), 0);
    assert.deepEqual(said, narration === 'full' ? ['Vou conferir Cabana e repor o que estiver faltando.'] : []);
  }
});

test('automatic task completion is important, with Portuguese output and no extra model calls', async () => {
  const { EventEmitter } = require('node:events');
  const { Vec3 } = require('vec3');
  const { runGoal } = require('../src/work');
  const registry = require('minecraft-data')('26.1');
  for (const narration of ['off', 'important', 'full']) {
    const said = [], bot = new EventEmitter();
    Object.assign(bot, { _jevLanguage: 'pt-BR', _jevNarration: narration, registry, chat: text => said.push(text), health: 20, food: 20,
      game: { dimension: 'overworld', gameMode: 'creative', difficulty: 'normal' }, entity: { id: 1, position: new Vec3(0.5, 64, 0.5) }, entities: {}, time: { timeOfDay: 3000 },
      pathfinder: { movements: { blocksCantBreak: new Set() } }, inventory: { items: () => [{ name: 'dirt', count: 1, type: registry.itemsByName.dirt.id }], slots: Array(46).fill(null) },
      findBlocks: () => [], findBlock: () => null, blockAt: p => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty', position: p, skyLight: 15, light: 15 }) });
    const goal = { kind: 'obtain', item: 'dirt', count: 1, deliver: false };
    const result = await runGoal(bot, { check() {} }, goal, { save() {} }, { maxSteps: 1, survival: { state: {}, step: async () => false }, recoveryAdviser: {} });
    require('../src/stillness').unwatchStalls(bot);
    assert.equal(result.ok, true);
    assert.equal(goal.status, 'complete');
    assert.equal(said.includes('Consegui 1 Terra.'), narration !== 'off');
    assert.doesNotMatch(said.join(' '), /I've got|You got|I'm /);
  }
});
