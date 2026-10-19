'use strict';
const { writeConsoleFile } = require('./lib/server');
// The dragon's pass over a column, measured on the arena (note 1575): the
// death ledger of 2026-10-14 puts 'carried off the column by the dragon's
// body' first (10 of 44 deaths; dragon-112, 114, 120, 121). In the game's
// code the dragon's wings' boxes, grown four blocks each way, push every
// living thing in them 4 / d² sideways and 0.2 up each tick, and hurt it 5
// (EnderDragon.knockBack); a shield does nothing to it, a solid block beside
// the body does. The drill parks the bot on a cobblestone column in the
// dragon's flight band, crouched with the shield up as the live hold stands,
// teleports the dragon beside it, and measures how far the body is carried,
// with no walls, with walls a block high at the feet, and two high.
//   ARENA_DIR=$HOME/Code/jevcraft/.test-combat MC_PORT=25574 PASS_TRIALS=6 node scripts/pass-drill.js
// PASS_MODE=drop measures the step off the column instead: how far out the
// body lands from a fall of DROP blocks at a walk and at a crouch, for the
// trench's length (dragon-122 overshot its trench by a cell from 34 up).
const fs = require('fs'), path = require('path');
const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const { compatibilityPlugin } = require('../src/compatibility');

const port = Number(process.env.MC_PORT || 25574);
if ([25565, 25570, 25576, 25577, 25578, 25579].includes(port) || (port >= 25581 && port <= 25610)) throw new Error('The pass drill needs the arena port');
const consolePath = process.env.ARENA_CONSOLE || path.join(process.env.ARENA_DIR || path.join(__dirname, '..', '.test-combat'), 'console.in');
const username = process.env.ARENA_USER || 'ArenaJev';
const trials = Number(process.env.PASS_TRIALS || 6);
const mode = process.env.PASS_MODE || 'pass';
const dropBlocks = Number(process.env.DROP || 24);
const COL = { x: 20, z: 0, top: 84 }; // the column's cell and its top block; the feet stand at top + 1
const GROUND = 61; // the island's ground about the column (the arena's End is the game's own)
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function command(line) { writeConsoleFile(consolePath, line + '\n'); await sleep(200); }
const end = line => `execute in minecraft:the_end run ${line}`;
const out = [];
const log = data => { const line = JSON.stringify({ at: new Date().toISOString(), ...data }); console.log(line); out.push(data); };

const bot = mineflayer.createBot({ host: '127.0.0.1', port, username, version: '26.1', auth: 'offline' });
bot.loadPlugin(compatibilityPlugin);
let hurt = 0, hurtBy = [];
bot.on('health', () => { /* read in the trial */ });
bot._client.on('damage_event', p => { if (p.entityId === bot.entity?.id) { hurt++; hurtBy.push(p.sourceTypeId); } });
let dead = false;
bot.on('death', () => { dead = true; });
bot.on('respawn', () => { dead = false; });
bot.on('error', e => log({ error: e.message }));
bot.on('kicked', r => log({ kicked: String(r).slice(0, 200) }));

const dragon = () => Object.values(bot.entities).find(e => e.name === 'ender_dragon');
const horizontal = p => Math.hypot(p.x - (COL.x + .5), p.z - (COL.z + .5));
const inEnd = () => /end/.test(String(bot.game?.dimension || ''));

// The End's chunks load only with a player in them: the bot goes first, the
// column is built once they are loaded, and the stand is verified by the blocks.
const solidTop = () => bot.blockAt(new Vec3(COL.x, COL.top, COL.z))?.boundingBox === 'block';
const standing = () => inEnd() && solidTop() && bot.entity.onGround && Math.abs(bot.entity.position.y - (COL.top + 1)) < 0.6 && horizontal(bot.entity.position) < 0.5;
async function settle(ms = 6000) { for (let i = 0; i < ms / 100 && !standing(); i++) await sleep(100); return standing(); }
async function stage() {
  for (const line of [`clear ${username}`, `effect clear ${username}`, `gamemode survival ${username}`, `give ${username} shield 1`,
    end(`tp ${username} ${COL.x + .5} ${COL.top + 1} ${COL.z + .5}`)]) await command(line);
  for (let i = 0; i < 100 && !inEnd(); i++) await sleep(100);
  await bot.waitForChunksToLoad(); await sleep(1500);
  await command(end(`fill ${COL.x - 3} ${COL.top - 2} ${COL.z - 3} ${COL.x + 3} ${COL.top + 5} ${COL.z + 3} air`));
  await command(end(`fill ${COL.x} ${GROUND - 20} ${COL.z} ${COL.x} ${COL.top} ${COL.z} cobblestone`));
  await command(end(`tp ${username} ${COL.x + .5} ${COL.top + 1} ${COL.z + .5}`));
  const ok = await settle();
  log({ staged: ok, position: bot.entity.position, solidTop: solidTop(), under: bot.blockAt(bot.entity.position.offset(0, -1, 0))?.name, dimension: bot.game?.dimension });
  if (!ok) throw new Error('the stand on the column was not made');
}
async function walls(height) {
  const y0 = COL.top + 1;
  if (height === 0) { await command(end(`fill ${COL.x - 1} ${y0} ${COL.z - 1} ${COL.x + 1} ${y0 + 1} ${COL.z + 1} air`)); await command(end(`fill ${COL.x} ${y0} ${COL.z} ${COL.x} ${y0 + 1} ${COL.z} air`)); return; }
  // 3: two-high walls and the roof the live hold lays (note 1445), a closed cell.
  const h = Math.min(height, 2);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) await command(end(`fill ${COL.x + dx} ${y0} ${COL.z + dz} ${COL.x + dx} ${y0 + h - 1} ${COL.z + dz} cobblestone`));
  if (height >= 3) await command(end(`setblock ${COL.x} ${y0 + 2} ${COL.z} cobblestone`));
  for (let i = 0; i < 20 && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => bot.blockAt(new Vec3(COL.x + dx, y0, COL.z + dz))?.boundingBox !== 'block'); i++) await sleep(100);
}
async function reset() {
  await command(end(`tp @e[type=ender_dragon] 0 110 0`));
  await command(end(`fill ${COL.x - 1} ${COL.top + 1} ${COL.z - 1} ${COL.x + 1} ${COL.top + 3} ${COL.z + 1} air`));
  await command(end(`fill ${COL.x} ${GROUND - 20} ${COL.z} ${COL.x} ${COL.top} ${COL.z} cobblestone`));
  await command(end(`tp ${username} ${COL.x + .5} ${COL.top + 1} ${COL.z + .5}`));
  await command(`effect give ${username} minecraft:instant_health 1 10 true`);
  if (dead) { await sleep(4000); }
  if (!await settle()) { await stage(); }
  // The dragon in view before the trial: teleported near first if it is not.
  for (let i = 0; i < 30 && !dragon(); i++) { if (i === 10) await command(end(`tp @e[type=ender_dragon] ${COL.x} ${COL.top + 30} ${COL.z}`)); await sleep(200); }
}
async function hold() {
  const shield = bot.inventory.items().find(i => i.name === 'shield');
  if (shield && bot.inventory.slots?.[45]?.name !== 'shield') { try { await bot.equip(shield, 'off-hand'); } catch (_) { /* in hand */ } }
  bot.setControlState('sneak', true);
  try { bot.activateItem(true); } catch (_) { /* nothing */ }
}
function release() { try { bot.deactivateItem(); } catch (_) { /* nothing */ } bot.clearControlStates(); }

async function passTrial(height, i) {
  await reset(); await walls(height); await sleep(400); await hold();
  const d = dragon(); if (!d) { log({ trial: i, walls: height, error: 'no dragon in view' }); return null; }
  const wallsSeen = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => bot.blockAt(new Vec3(COL.x + dx, COL.top + 1, COL.z + dz))?.boundingBox === 'block').length;
  const h0 = bot.health, p0 = bot.entity.position.clone(); hurt = 0; hurtBy = [];
  let maxOff = 0, minY = p0.y, carriedTo = null;
  const tick = () => { const p = bot.entity.position; maxOff = Math.max(maxOff, horizontal(p)); minY = Math.min(minY, p.y); if (horizontal(p) > 2) carriedTo = carriedTo || p.clone(); };
  bot.on('physicsTick', tick);
  // The dragon's body beside the bot, flying on from there: its wings sweep the column.
  await command(end(`tp @e[type=ender_dragon] ${COL.x + 3.5} ${COL.top + 2} ${COL.z + .5}`));
  for (let t = 0; t < 40; t++) { await sleep(100); if (dead) break; }
  bot.off('physicsTick', tick); release();
  const died = dead;
  const row = { trial: i, walls: height, wallsSeen, standingBefore: true, hurt, healthLost: Math.round((h0 - (died ? 0 : bot.health)) * 10) / 10, maxOff: Math.round(maxOff * 100) / 100, fell: minY < COL.top - 1, minY: Math.round(minY), carriedTo: carriedTo && { x: Math.round(carriedTo.x), y: Math.round(carriedTo.y), z: Math.round(carriedTo.z) }, dead: died, dragonAfter: dragon() && Math.round(dragon().position.distanceTo(bot.entity.position)) };
  log(row); return row;
}

async function dropTrial(sneak, i) {
  await command(end(`tp @e[type=ender_dragon] 0 160 0`));
  const top = GROUND + dropBlocks; // the column's top for this fall
  await command(end(`fill ${COL.x} ${GROUND - 20} ${COL.z} ${COL.x} ${top + 40} ${COL.z} air`));
  await command(end(`fill ${COL.x} ${GROUND - 20} ${COL.z} ${COL.x} ${top} ${COL.z} cobblestone`));
  await command(end(`fill ${COL.x + 1} ${GROUND} ${COL.z - 2} ${COL.x + 12} ${top + 3} ${COL.z + 2} air`)); // clear air east of the column down to the ground
  await command(end(`fill ${COL.x + 1} ${GROUND - 1} ${COL.z - 2} ${COL.x + 12} ${GROUND - 1} ${COL.z + 2} end_stone`)); // a level landing
  await command(end(`tp ${username} ${COL.x + .5} ${top + 1} ${COL.z + .5}`));
  await command(`effect give ${username} minecraft:instant_health 1 10 true`);
  await sleep(800);
  if (dead) { await sleep(3000); await stage(); }
  await bot.lookAt(new Vec3(COL.x + 6, top + 1.6, COL.z + .5), true);
  const edgeX = COL.x + 1; // the first cell east of the column
  let left = null, landed = null, maxVx = 0;
  const tick = () => { const p = bot.entity.position, v = bot.entity.velocity; if (!left && p.x > edgeX) left = { x: p.x, vx: v.x }; maxVx = Math.max(maxVx, v.x); if (left && !landed && bot.entity.onGround && p.y < top - 2) landed = p.clone(); };
  bot.on('physicsTick', tick);
  bot.setControlState('sneak', sneak); bot.setControlState('forward', true);
  for (let t = 0; t < 80 && !landed && !dead; t++) { await sleep(100); if (left && t > 4) bot.setControlState('forward', false); }
  bot.off('physicsTick', tick); bot.clearControlStates();
  const row = { trial: i, mode: 'drop', drop: dropBlocks, sneak, left: left && { vx: Math.round(left.vx * 1000) / 1000 }, maxVx: Math.round(maxVx * 1000) / 1000, landedOut: landed ? Math.round((landed.x - edgeX) * 100) / 100 : null, landedY: landed ? Math.round(landed.y) : null, dead };
  log(row); return row;
}

bot.once('spawn', async () => {
  try {
    await bot.waitForChunksToLoad();
    if (!(bot.health > 0)) await sleep(3000);
    await stage();
    log({ staged: true, position: bot.entity.position, dimension: bot.game?.dimension, dragon: !!dragon() });
    const rows = [];
    if (mode === 'drop') {
      for (let i = 0; i < trials; i++) { rows.push(await dropTrial(false, i)); rows.push(await dropTrial(true, i)); }
      const by = s => rows.filter(r => r && r.sneak === s && r.landedOut !== null).map(r => r.landedOut);
      log({ summary: { drop: dropBlocks, walkLandedOut: by(false), sneakLandedOut: by(true) } });
    } else {
      const heights = (process.env.PASS_WALLS || '0,1,2,3').split(',').map(Number);
      for (let i = 0; i < trials; i++) for (const h of heights) rows.push(await passTrial(h, i));
      const by = h => rows.filter(r => r && r.walls === h);
      const summary = {};
      for (const h of heights) { const rs = by(h); summary[`walls${h}`] = { trials: rs.length, carriedOver2: rs.filter(r => r.maxOff > 2).length, fell: rs.filter(r => r.fell).length, dead: rs.filter(r => r.dead).length, maxOff: rs.map(r => r.maxOff), healthLost: rs.map(r => r.healthLost), hurt: rs.map(r => r.hurt) }; }
      log({ summary });
    }
    fs.mkdirSync(path.join(__dirname, '..', 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'artifacts', `pass-drill-${Date.now().toString(36)}.json`), JSON.stringify(out, null, 1));
  } catch (err) { log({ error: String(err.stack || err).slice(0, 400) }); }
  finally { await command(end(`tp @e[type=ender_dragon] 0 120 0`)); bot.quit(); setTimeout(() => process.exit(0), 500); }
});
