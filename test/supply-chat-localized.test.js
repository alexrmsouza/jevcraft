'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { displayName } = require('../src/language');

test('a warden warning is Portuguese important narration and retreat still happens with narration off', async () => {
  const { expeditionStep } = require('../src/deep-dark');
  for (const mode of ['off', 'important', 'full']) {
    const said = [], goal = {};
    const bot = { _jevLanguage: 'pt-BR', _jevNarration: mode, entity: { position: new Vec3(0, -52, 0) }, entities: { 1: { name: 'warden', position: new Vec3(2, -52, 0) } }, chat: text => said.push(text) };
    assert.equal(await expeditionStep(bot, {}, goal, () => {}, {}, 'deep_dark'), 'warden');
    assert.ok(goal.deepDark.wardenAt);
    assert.deepEqual(said, mode === 'off' ? [] : [`${displayName('warden', bot)} por perto. Vou sair das profundezas por enquanto.`]);
  }
});

test('vault completion is localized and important while the actual interaction stays unchanged', async () => {
  const { openVault } = require('../src/deep-dark');
  for (const mode of ['off', 'important', 'full']) {
    const said = []; let opened = 0;
    const cell = new Vec3(1, -30, 0), goal = {};
    const bot = { _jevLanguage: 'pt-BR', _jevNarration: mode, chat: text => said.push(text), registry: { blocksByName: { vault: { id: 1 } } }, inventory: { items: () => [{ name: 'trial_key' }] }, findBlocks: () => [cell], equip: async () => {}, blockAt: () => ({ name: 'vault' }), activateBlock: async () => opened++ };
    assert.equal(await openVault(bot, {}, goal, () => {}, { navigate: async () => {} }, cell), true);
    assert.equal(opened, 1);
    assert.ok(goal.vaultsUsed['1,-30,0']);
    assert.deepEqual(said, mode === 'off' ? [] : ['Abri um cofre com uma chave do desafio.']);
  }
});

test('trade results keep quantities and translated item names without leaking through narration off', async () => {
  const { makeTrade } = require('../src/trading');
  for (const mode of ['off', 'important', 'full']) {
    const said = []; let pearls = 0, trades = 0;
    const bot = { _jevLanguage: 'pt-BR', _jevNarration: mode, chat: text => said.push(text), entity: { position: new Vec3(0, 64, 0) }, inventory: { items: () => pearls ? [{ name: 'ender_pearl', count: pearls }] : [] }, openVillager: async () => ({ close() {} }), trade: async () => { trades++; pearls++; } };
    const goal = {}, option = { entity: { id: 1, position: new Vec3(1, 64, 0) }, input: { name: 'emerald', count: 5 }, output: { name: 'ender_pearl', count: 1 }, index: 0, kind: 'buy' };
    assert.equal(await makeTrade(bot, {}, goal, () => {}, option, {}), true);
    assert.equal(trades, 1);
    assert.equal(goal.trading.trades[0].got.count, 1);
    assert.deepEqual(said, mode === 'off' ? [] : [`Troquei 5 ${displayName('emerald', bot)} por 1 ${displayName('ender_pearl', bot)}.`]);
  }
});

test('sheep search progress translates biome and compass direction without changing the chosen destination', async () => {
  const home = require('../src/home-base'), exploration = require('../src/exploration'), decisions = require('../src/decisions');
  const { establishedHome } = require('./fixtures/home-world');
  const trips = exploration.biomeTrips, decide = decisions.decide;
  try {
    exploration.biomeTrips = () => [{ x: 100, z: -100, biome: 'warped_forest', distance: 141, direction: 'north-east', says: 'the warped forest 141 blocks north-east' }];
    decisions.decide = async () => ({ path: ['biome_warped_forest'], stale: false });
    for (const mode of ['off', 'important', 'full']) {
      const w = await establishedHome(), said = [];
      w.bot._jevLanguage = 'pt-BR'; w.bot._jevNarration = mode; w.bot.chat = text => said.push(text);
      await home.searchForSheep(w.bot, w.task, w.goal, w.save, { explore: async () => {} });
      assert.deepEqual(w.goal.woolSearch.toward, { x: 100, z: -100, biome: 'warped_forest' });
      assert.deepEqual(said, mode === 'full' ? ['Não há ovelhas aqui. Vou procurar em Floresta distorcida, na direção nordeste.'] : []);
    }
  } finally { exploration.biomeTrips = trips; decisions.decide = decide; }
});

test('packing progress translates the destination and stored food but still packs in every narration mode', async () => {
  const { establishedHome, registry } = require('./fixtures/home-world');
  const { packLight } = require('../src/trip-kit');
  for (const mode of ['off', 'important', 'full']) {
    const w = await establishedHome({ items: [['diamond_pickaxe', 1], ['cooked_beef', 12], ['cobblestone', 64]] }), said = [], container = [];
    w.bot._jevLanguage = 'pt-BR'; w.bot._jevNarration = mode; w.bot.chat = text => said.push(text);
    w.bot.openContainer = async () => ({ inventoryStart: 27, inventoryEnd: 63,
      items: () => w.bot.inventory.items().map(i => Object.assign(i, { slot: 27 + w.stacks.indexOf(i) })),
      containerItems: () => container.map((i, slot) => ({ ...i, slot })),
      firstEmptyContainerSlot: () => container.length,
      get slots() { return Array(63).fill(null); },
      deposit: async (type, meta, count) => { const name = registry.items[type].name; w.take(name, count); container.push({ name, count, type }); }, close() {},
    });
    await packLight(w.bot, w.task, w.goal, w.save, { ...w.actions, acquireStep: async (bot, task, item, count) => w.give(item, count) }, 'trial_chambers');
    assert.equal(w.goal.caches[0].hold, 'trial_chambers');
    assert.ok(container.some(item => item.name === 'cooked_beef' && item.count === 9));
    if (mode === 'full') {
      assert.match(said.at(-1), /^Vou levar pouca coisa para as câmaras do desafio:/);
      assert.ok(said.at(-1).includes(`9 ${displayName('cooked_beef', w.bot)}`));
    } else assert.deepEqual(said, []);
  }
});

test('enchantment completion translates gear and enchantment without translating persisted state', async () => {
  const { enchantStep } = require('../src/enchanting');
  for (const mode of ['off', 'important', 'full']) {
    const sword = { name: 'diamond_sword', count: 1, enchants: [] }, lapis = { name: 'lapis_lazuli', count: 3 }, said = [], goal = {};
    const bot = { _jevLanguage: 'pt-BR', _jevNarration: mode, chat: text => said.push(text), entity: { position: new Vec3(0, 64, 0) }, entities: {}, health: 20, experience: { level: 10 }, inventory: { items: () => [sword, lapis] },
      openEnchantmentTable: async () => ({ items: () => [sword, lapis], enchantments: [{ level: 5 }], putTargetItem: async () => {}, putLapis: async () => {},
        enchant: async () => { sword.enchants = [{ name: 'sharpness', lvl: 2 }]; }, takeTargetItem: async () => {}, close() {} }),
    };
    assert.equal(await enchantStep(bot, { check() {} }, goal, () => {}, { workstation: async () => ({ position: new Vec3(0, 64, 0) }) }), true);
    assert.deepEqual(goal.enchanting.done[0].enchants, ['sharpness 2']);
    assert.deepEqual(said, mode === 'off' ? [] : [`Encantei ${displayName('diamond_sword', bot)}: Afiação 2.`]);
  }
});
