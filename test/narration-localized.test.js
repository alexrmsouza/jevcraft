'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const narration = require('../src/narration');
const pt = () => { const said = []; return { _jevLanguage: 'pt-BR', _jevNarration: 'full', chat: line => said.push(line), said }; };

test('Portuguese work narration translates dynamic names, including combined inner steps', () => {
  narration.setRandom(() => 0);
  const bot = pt();
  const mine = narration.stepLine({}, { action: 'mine', drops: 'oak_log', count: 16 }, null, null, bot);
  assert.match(mine, /16/); assert.match(mine, /tronco de carvalho/i); assert.doesNotMatch(mine, /oak|I need/);
  const craft = narration.stepLine({}, { action: 'combined_request', detail: { action: 'craft', item: 'diamond_pickaxe' } }, null, null, bot);
  assert.match(craft, /picareta de diamante/i); assert.doesNotMatch(craft, /diamond|I'll/);
  assert.match(narration.stepLine({}, { action: 'hunt_mob', entity: 'zombie', item: 'rotten_flesh' }, null, null, bot), /zumbi.*carne podre/i);
});

test('Portuguese survival variants cover every original event and contextual catalog', () => {
  const catalog = require('../src/locales/narration-pt-BR');
  assert.deepEqual(Object.keys(catalog.SURVIVAL).sort(), Object.keys(narration.SURVIVAL).sort());
  assert.deepEqual(Object.keys(catalog.SURVIVAL_ELSEWHERE).sort(), Object.keys(narration.SURVIVAL_ELSEWHERE).sort());
  for (const key of ['SURVIVAL', 'SURVIVAL_ELSEWHERE', 'SURVIVAL_BY_NIGHT', 'STOCKING']) {
    assert.deepEqual(Object.keys(catalog[key]).sort(), Object.keys(narration[key]).sort(), key);
    for (const action of Object.keys(narration[key])) assert.equal(Array.isArray(catalog[key][action]) ? catalog[key][action].length : 1,
      Array.isArray(narration[key][action]) ? narration[key][action].length : 1, `${key}.${action}`);
  }
  const sample = { threats: ['zombie'], item: 'porkchop', target: 'blaze', what: 'fortress', distance: 80 };
  for (const action of Object.keys(narration.SURVIVAL)) {
    const variants = narration.survivalLines(action, { language: 'pt-BR' });
    const values = Array.isArray(variants) ? variants : [variants];
    for (const value of values) assert.equal(typeof (typeof value === 'function' ? value({}, sample) : value), 'string', action);
  }
  const escaped = narration.pick(narration.survivalLines('escape_threat', { language: 'pt-BR' }), null, {}, sample);
  assert.match(escaped, /zumbi/i); assert.doesNotMatch(escaped, /zombie/);
});

test('every English work action and idle choice has a Portuguese variant', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/narration.js'), 'utf8');
  const actions = [...source.matchAll(/case '([^']+)'/g)].map(match => match[1]);
  const bot = pt();
  for (const action of new Set(actions)) {
    const step = { action, item: 'iron_ingot', drops: 'oak_log', count: 3, crop: 'wheat', entity: 'zombie', phase: 'stone_tools', choice: 'stock_wood', detail: { action: 'mine', block: 'oak_log' } };
    const english = narration.stepLine({}, step);
    if (english) {
      const portuguese = narration.stepLine({}, step, null, null, bot);
      assert.equal(typeof portuguese, 'string', action);
      assert.notEqual(portuguese, english, action);
    }
  }
  for (const choice of ['cook_food', 'stone_tools', 'stock_wood', 'torches', 'long_game', 'tend_farm', 'harvest_and_bake', 'breed_cows', 'lure_cows', 'stock_stash']) {
    const step = { action: 'idle', choice, item: 'stone_pickaxe', phase: 'stone_tools' };
    assert.notEqual(narration.stepLine({}, step, null, null, bot), narration.stepLine({}, step), choice);
  }
});

test('off suppresses all unsolicited narration without deferring it to a later mode', () => {
  const bot = pt(); bot._jevNarration = 'off';
  const goal = { step: { action: 'craft', item: 'bread' }, survivalAction: { action: 'out_of_fire', at: 'fire' } };
  assert.equal(narration.narrate(bot, goal, { now: 1000 }), null);
  bot._jevNarration = 'full';
  assert.equal(narration.narrate(bot, goal, { now: 10000 }), null);
  assert.deepEqual(bot.said, []);
});

test('important suppresses routine progress but permits danger, failure and resolution', () => {
  narration.setRandom(() => 0);
  const bot = pt(); bot._jevNarration = 'important';
  assert.equal(narration.narrate(bot, { step: { action: 'craft', item: 'bread' } }, { now: 1000 }), null);
  assert.equal(narration.narrate(bot, { survivalAction: { action: 'search_food', at: 'food' } }, { now: 1000 }), null);
  assert.match(narration.narrate(bot, { survivalAction: { action: 'out_of_fire', at: 'fire' } }, { now: 1000 }), /fogo|queimando/i);
  assert.match(narration.narrate(bot, { survivalAction: { action: 'no_shelter_here', at: 'blocked' } }, { now: 1000 }), /abrigo|abrigar/i);
  const goal = { survivalAction: { action: 'escape_threat', at: 'escape', threats: ['zombie'] } };
  assert.match(narration.narrate(bot, goal, { now: 1000 }), /zumbi/i);
  assert.equal(narration.narrate(bot, goal, { now: 14000 }), 'Acho que despistei.');
  assert.equal(bot.said.length, 4);
});

test('Portuguese keeps variants, chat gap, escape repeat suppression and live language switching', () => {
  const bot = pt(), goal = { survivalAction: { action: 'escape_threat', at: 'a', threats: ['zombie'] } };
  narration.setRandom(() => 0);
  const first = narration.narrate(bot, goal, { now: 1000 }); assert.match(first, /zumbi/i);
  goal.survivalAction = { action: 'out_of_fire', at: 'b' };
  assert.equal(narration.narrate(bot, goal, { now: 2000 }), null);
  assert.match(narration.narrate(bot, goal, { now: 5000 }), /fogo/i);
  const variants = narration.survivalLines('sleep', { language: 'pt-BR' });
  assert.notEqual(narration.pick(variants, narration.pick(variants, null)), narration.pick(variants, null));
  goal.survivalAction = { action: 'escape_threat', at: 'c', threats: ['zombie'] };
  bot._jevLanguage = 'en-US';
  assert.equal(narration.narrate(bot, goal, { now: 9000 }), null, 'same threat is not new just because language changed');
  goal.step = { action: 'craft', item: 'bread' }; goal.survivalAction = null;
  assert.equal(narration.narrate(bot, goal, { now: 13000 }), "I'll make a bread.");
});

test('Portuguese respects dimension, night and fed-context restrictions', () => {
  assert.equal(narration.linesFor('sleep', { dimension: 'the_nether', language: 'pt-BR' }), null);
  for (const action of ['seal_shelter', 'sheltered', 'leave_shelter', 'return_to_surface']) {
    assert.doesNotMatch(narration.linesFor(action, { dimension: 'the_nether', language: 'pt-BR' }).join(' '), /manhã|amanhecer|sol|anoitec/i, action);
  }
  assert.doesNotMatch(narration.linesFor('leave_shelter', { morning: false, language: 'pt-BR' }).join(' '), /manhã|sol|amanhecer/i);
  assert.doesNotMatch(narration.linesFor('gather_food', { fed: true, language: 'pt-BR' }).join(' '), /fome|faminto/i);
  assert.match(narration.linesFor('return_to_surface', { morning: false, language: 'pt-BR' }).join(' '), /noite|escuro/i);
});

test('localized fortress finds retain the same place-based repeat suppression', () => {
  const bot = pt(), goal = { step: { action: 'find_fortress', found: { x: 10, z: 10 }, fortress: { x: 10, z: 10, firstAt: 1 } } };
  narration.setRandom(() => 0);
  assert.match(narration.narrate(bot, goal, { now: 1000 }), /fortaleza/i);
  goal.step = { action: 'mine', block: 'stone' }; narration.narrate(bot, goal, { now: 5000 });
  goal.step = { action: 'find_fortress', found: { x: 15, z: 15 }, fortress: { x: 15, z: 15, firstAt: 2 } };
  assert.equal(narration.narrate(bot, goal, { now: 9000 }), null);
});

test('Portuguese localizes landmarks, failure reasons and fortress search directions', () => {
  const bot = pt(); narration.setRandom(() => 0);
  const landmark = { survivalAction: { action: 'landmark_found', kind: 'desert_temple', what: 'desert temple at 10, 20', position: { x: 10, z: 20 }, at: 'temple' } };
  assert.match(narration.narrate(bot, landmark, { now: 1000 }), /templo do deserto em 10, 20/);
  const failure = { survivalAction: { action: 'sleep_failed', reason: 'The server refused the sleep: block.minecraft.bed.not_safe', at: 'bed' } };
  assert.match(narration.narrate(bot, failure, { now: 1000 }), /monstros/);
  const search = { fortressSearch: { lastHeading: 3 }, step: { action: 'find_fortress', legs: 4 } };
  assert.match(narration.narrate(bot, search, { now: 1000 }), /trecho 4, rumo ao norte/);
  const known = { fortressSearch: { fortressAt: { x: 25, z: 40 }, lastHeading: 0 }, step: { action: 'find_fortress', legs: 2 } };
  assert.match(narration.narrate(bot, known, { now: 1000 }), /25, 40.*trecho 2, rumo ao leste/);
  assert.match(narration.stepLine({}, { action: 'game_progression', phase: 'obtain_blaze_rods' }, null, null, bot), /conseguir varas de blaze/);
});

test('important preserves progress failures but does not replay muted routine work when set to full', () => {
  const bot = pt(); bot._jevNarration = 'important';
  const goal = { step: { action: 'mine', block: 'stone' }, survivalAction: { action: 'search_food', at: 'food' } };
  assert.equal(narration.narrate(bot, goal, { now: 1000 }), null);
  bot._jevNarration = 'full';
  assert.equal(narration.narrate(bot, goal, { now: 5000 }), null);
  bot._jevNarration = 'important';
  goal.step = { action: 'refuel_furnace' };
  assert.match(narration.narrate(bot, goal, { now: 9000 }), /combustível/);
});
