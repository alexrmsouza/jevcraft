'use strict';
const { writeConsoleFile } = require('./lib/server');
// The two-block climb on a one-wide column's top, measured on the arena
// (2026-10-15): the climb out of the breath laid one of two and the body did
// not rise, or rose and was found a cell off its column, in 25588's
// dragon-214, 215, 216, 220, 221, 222, 245 ('the block was not placed in
// three jumps (on ground true, end_stone in hand; the jump reached 1.17 over
// the start, the body at 1.25 at the place; the cell at the feet is
// end_stone)'). This drill stands the bot on a column one wide and H high,
// asks pillarUp for two, and records the blocks laid, where the body ends,
// its offset from the column's middle and whether it is still on the column.
//   ARENA_DIR=$HOME/Code/jevcraft/.test-combat MC_PORT=25574 CLIMB_TRIALS=10 node scripts/climb-drill.js
// CLIMB_H=4 (the column's height), CLIMB_AT=40 (x and z of the column), CLIMB_OFF=0 (the body's start offset from the middle, east), CLIMB_SETTLE=1 (wait for the body to stand still before the climb).
const fs = require('fs'), path = require('path');
const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const { compatibilityPlugin } = require('../src/compatibility');
const { Task } = require('../src/skills');

const port = Number(process.env.MC_PORT || 25574);
if ([25565, 25570, 25576, 25577, 25578, 25579].includes(port) || (port >= 25581 && port <= 25610)) throw new Error('The climb drill needs the arena port');
const consolePath = process.env.ARENA_CONSOLE || path.join(process.env.ARENA_DIR || path.join(__dirname, '..', '.test-combat'), 'console.in');
const username = process.env.ARENA_USER || 'ArenaJev';
const trials = Number(process.env.CLIMB_TRIALS || 10);
const H = Number(process.env.CLIMB_H || 4);
const AT = Number(process.env.CLIMB_AT || 40);
const OFF = Number(process.env.CLIMB_OFF || 0);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function command(line) { writeConsoleFile(consolePath, line + '\n'); await sleep(200); }
const end = line => `execute in minecraft:the_end run ${line}`;
const log = data => console.log(JSON.stringify({ at: new Date().toISOString(), ...data }));

const bot = mineflayer.createBot({ host: '127.0.0.1', port, username, version: '26.1', auth: 'offline' });
bot.loadPlugin(compatibilityPlugin);
bot.on('error', e => log({ error: e.message }));
bot.on('kicked', r => log({ kicked: String(r).slice(0, 200) }));
const inEnd = () => /end/.test(String(bot.game?.dimension || ''));
const solid = p => bot.blockAt(p)?.boundingBox === 'block';

async function stage() {
  for (const line of [`clear ${username}`, `effect clear ${username}`, `gamemode survival ${username}`, end(`tp @e[type=ender_dragon] 0 160 0`), end(`tp ${username} ${AT + .5} 80 ${AT + .5}`)]) await command(line);
  for (let i = 0; i < 100 && !inEnd(); i++) await sleep(100);
  await bot.waitForChunksToLoad(); await sleep(1200);
  const g = 60;
  await command(end(`fill ${AT - 4} ${g - 4} ${AT - 4} ${AT + 4} ${g} ${AT + 4} end_stone`));
  await command(end(`fill ${AT - 4} ${g + 1} ${AT - 4} ${AT + 4} ${g + H + 6} ${AT + 4} air`));
  await command(end(`fill ${AT} ${g + 1} ${AT} ${AT} ${g + H} ${AT} cobblestone`));
  await command(`give ${username} minecraft:cobblestone ${Number(process.env.CLIMB_GIVE || 16)}`);
  await command(`give ${username} minecraft:iron_pickaxe 1`);
  const top = g + H + 1;
  // CLIMB_WALLS=1: the pocket's walls, two high on the four sides of the column's top cell.
  // CLIMB_WALLS=lee: a wall on the side away from the dragon (east) at the heights the climb rises through, feet+1 to feet+4.
  if (process.env.CLIMB_WALLS === 'lee') await command(end(`fill ${AT + 1} ${g + H + 1} ${AT} ${AT + 1} ${g + H + 4} ${AT} cobblestone`));
  if (process.env.CLIMB_WALLS === '1') for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) await command(end(`fill ${AT + dx} ${g + H} ${AT + dz} ${AT + dx} ${g + H + 2} ${AT + dz} cobblestone`));
  await command(end(`tp ${username} ${(AT + .5 + OFF).toFixed(2)} ${top} ${AT + .5}`));
  await command(`effect give ${username} minecraft:instant_health 1 10 true`);
  for (let i = 0; i < 40 && !(bot.entity.onGround && Math.abs(bot.entity.position.y - top) < 0.3); i++) await sleep(100);
  await sleep(400);
  return { top };
}

bot.once('spawn', async () => {
  await sleep(2000);
  const pr = require('../src/pillar-recovery');
  const results = [];
  for (let t = 0; t < trials; t++) {
    const { top } = await stage();
    const start = bot.entity.position.clone();
    const task = new Task('climb-drill', 'climb drill');
    let laid = 0, err = null;
    const t0 = Date.now();
    const track = process.env.CLIMB_TRACK === '1' ? setInterval(() => { const q = bot.entity.position, v = bot.entity.velocity; console.log(`track ${Date.now() - t0}ms pos ${q.x.toFixed(2)} ${q.y.toFixed(2)} ${q.z.toFixed(2)} v ${v.x.toFixed(2)} ${v.y.toFixed(2)} ${v.z.toFixed(2)} ground ${bot.entity.onGround} hp ${bot.health}`); }, 200) : null;
    // CLIMB_HURT=1: the breath's ticks during the climb, dealt as the dragon's indirect magic from a dragon set 12 blocks west, every half second for two seconds.
    let hurting = null;
    if (process.env.CLIMB_HURT === '1') {
      await command(end(`tp @e[type=ender_dragon] ${AT - 40} ${top + 30} ${AT + .5}`));
      let n = 0; hurting = setInterval(() => { if (n++ < 4) command(end(`damage ${username} 1 minecraft:indirect_magic by @e[type=ender_dragon,limit=1]`)); }, 500);
    }
    let lee = null;
    if (process.env.CLIMB_LEE === '1') lee = await pr.leeWall(bot, task, new Vec3(AT - 40, top + 30, AT + .5));
    // CLIMB_CLOUD=1: a real harming cloud, its centre 1.5 west of the column at the feet's level, as the breath's.
    if (process.env.CLIMB_DRAGON_DX) await command(end(`tp @e[type=ender_dragon] ${AT + Number(process.env.CLIMB_DRAGON_DX)} ${top + 20} ${AT + .5}`));
    if (process.env.CLIMB_CLOUD === '1') await command(end(`summon area_effect_cloud ${AT + .5 + Number(process.env.CLIMB_CLOUD_DX || -1.5)} ${top} ${AT + .5} {Radius:2.5f,Duration:200,RadiusPerTick:0f,potion_contents:{custom_effects:[{id:"minecraft:instant_damage",amplifier:0b,duration:1}]}}`));
    // CLIMB_UP=N (default 2): how many to climb. CLIMB_ENCLOSE=1: the ring at the feet and the head on every level (note 1753), the ring blocks counted.
    const up = Number(process.env.CLIMB_UP || 2); bot._ringLaid = 0;
    try { laid = await pr.pillarUp(bot, task, Math.floor(start.y) + up, { maxBlocks: up, threats: false, wet: true, dig: async () => {}, enclose: process.env.CLIMB_ENCLOSE === '1' }); } catch (e) { err = String(e.message || e).slice(0, 80); }
    if (hurting) { clearInterval(hurting); await command(end(`tp @e[type=ender_dragon] 0 160 0`)); }
    await sleep(600);
    if (track) clearInterval(track);
    const p = bot.entity.position, off = Math.hypot(AT + .5 - p.x, AT + .5 - p.z);
    const onColumn = Math.floor(p.x) === AT && Math.floor(p.z) === AT && solid(new Vec3(AT, Math.floor(p.y) - 1, AT));
    const r = { trial: t + 1, laid, ring: bot._ringLaid || 0, rose: Math.round((p.y - start.y) * 100) / 100, endY: Math.round(p.y * 100) / 100, startY: top, offset: Math.round(off * 100) / 100, onColumn, ms: Date.now() - t0, err, lee };
    log(r); results.push(r);
  }
  const UP = Number(process.env.CLIMB_UP || 2); const ok = results.filter(r => r.laid >= UP && r.onColumn && r.rose >= UP - 0.1).length;
  log({ summary: { trials, twoUpOnColumn: ok, oneOrNone: results.filter(r => r.laid < 2).length, offColumn: results.filter(r => !r.onColumn).length, offsetStart: OFF, height: H } });
  bot.quit(); setTimeout(() => process.exit(0), 500);
});
