'use strict';
const { writeConsoleFile } = require('./lib/server');
// The dragon's landing and take-off by the fountain, measured on the arena
// (note 1614): the death ledger of 2026-10-14 puts 'fall after the dragon's
// body (carried)' first (dragon-148 to 151, four of the five deaths from 08:57
// to 09:14Z), two of them a body in the open within twenty of the fountain as
// the dragon came down or rose (149, 151). The hole two deep (note 1592) is
// offered on the game's code read: the wings' boxes, grown four each way,
// push what they hold 4 / d² a tick and 0.2 up, and a body two deep in the
// ground should sit below them. This drill stands the bot in the open at
// eleven blocks from the fountain and again in a hole two deep there, sets
// the dragon landing (DragonPhase 3) and then taking off (4), and measures
// how far the body is moved, how much it loses, and whether it dies.
//   ARENA_DIR=$HOME/Code/jevcraft/.test-combat MC_PORT=25574 PERCH_TRIALS=3 node scripts/perch-drill.js
// PERCH_MODES=open,hole (default both), run_side,run_front (the sprint to the head's stand from 13 blocks, square to the dragon or along its line); PERCH_AT=11 (blocks east of the fountain); PERCH_SNEAK=0 stands without the crouch.
const fs = require('fs'), path = require('path');
const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const { compatibilityPlugin } = require('../src/compatibility');

const port = Number(process.env.MC_PORT || 25574);
if ([25565, 25570, 25576, 25577, 25578, 25579].includes(port) || (port >= 25581 && port <= 25610)) throw new Error('The perch drill needs the arena port');
const consolePath = process.env.ARENA_CONSOLE || path.join(process.env.ARENA_DIR || path.join(__dirname, '..', '.test-combat'), 'console.in');
const username = process.env.ARENA_USER || 'ArenaJev';
const trials = Number(process.env.PERCH_TRIALS || 3);
const modes = (process.env.PERCH_MODES || 'open,hole').split(',');
const AT = Number(process.env.PERCH_AT || 11);
const GROUND = Number(process.env.PERCH_GROUND || 62);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function command(line) { writeConsoleFile(consolePath, line + '\n'); await sleep(200); }
const end = line => `execute in minecraft:the_end run ${line}`;
const out = [];
const log = data => { const line = JSON.stringify({ at: new Date().toISOString(), ...data }); console.log(line); out.push(data); };

const bot = mineflayer.createBot({ host: '127.0.0.1', port, username, version: '26.1', auth: 'offline' });
bot.loadPlugin(compatibilityPlugin);
let hurt = [];
bot._client.on('damage_event', p => { if (p.entityId === bot.entity?.id) hurt.push(p.sourceTypeId); });
let dead = false;
bot.on('death', () => { dead = true; });
bot.on('respawn', () => { dead = false; });
bot.on('error', e => log({ error: e.message }));
bot.on('kicked', r => log({ kicked: String(r).slice(0, 200) }));

const dragon = () => Object.values(bot.entities).find(e => e.name === 'ender_dragon');
const phaseKey = () => bot.registry.entitiesByName.ender_dragon.metadataKeys.indexOf('phase');
const phase = () => { const d = dragon(); const v = d && d.metadata && d.metadata[phaseKey()]; return typeof v === 'number' ? v : null; };
const inEnd = () => /end/.test(String(bot.game?.dimension || ''));
const solid = p => bot.blockAt(p)?.boundingBox === 'block';

// The ground east of the fountain: the first solid block down from 80 at (AT, 0).
function groundAt(x, z) { for (let y = 80; y >= 40; y--) if (solid(new Vec3(x, y, z))) return y; return null; }

async function stage(mode) {
  hurt = [];
  for (const line of [`clear ${username}`, `effect clear ${username}`, `gamemode survival ${username}`, end(`tp @e[type=ender_dragon] 0 140 0`),
    end(`tp ${username} ${AT + .5} 70 .5`)]) await command(line);
  for (let i = 0; i < 100 && !inEnd(); i++) await sleep(100);
  await bot.waitForChunksToLoad(); await sleep(1500);
  // The ground set, not read (the island's top by the fountain is 62 in the arena's End; a hole dug in a trial before read as the ground and the next went two deeper): end stone from 56 to GROUND over five by five, air above it.
  const g = GROUND;
  await command(end(`fill ${AT - 2} ${g - 6} -2 ${AT + 2} ${g} 2 end_stone`));
  await command(end(`fill ${AT - 2} ${g + 1} -2 ${AT + 2} ${g + 5} 2 air`));
  let feetY = g + 1;
  if (mode === 'hole') { await command(end(`fill ${AT} ${g - 1} 0 ${AT} ${g} 0 air`)); feetY = g - 1; }
  await command(end(`tp ${username} ${AT + .5} ${feetY} .5`));
  await sleep(800);
  await command(`effect give ${username} minecraft:instant_health 1 10 true`);
  await sleep(600);
  if (process.env.PERCH_SNEAK !== '0') bot.setControlState('sneak', true); else bot.setControlState('sneak', false);
  for (let i = 0; i < 40 && !(bot.entity.onGround && Math.abs(bot.entity.position.y - feetY) < 0.3); i++) await sleep(100);
  return { feetY, ground: g };
}

async function setPhase(n) { await command(end(`data merge entity @e[type=ender_dragon,limit=1] {DragonPhase:${n}}`)); }

async function trial(mode, n) {
  const { feetY, ground } = await stage(mode);
  const start = bot.entity.position.clone(); const health0 = bot.health;
  // The dragon brought over the fountain and set landing.
  await command(end(`tp @e[type=ender_dragon] 0 ${ground + 20} 0`));
  await sleep(300);
  await setPhase(3);
  let perchedAt = null, maxOff = 0, minY = feetY, maxY = feetY, lost = 0, phases = new Set();
  const t0 = Date.now();
  const sample = () => { const p = bot.entity.position; maxOff = Math.max(maxOff, Math.hypot(p.x - start.x, p.z - start.z)); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); lost = Math.max(lost, health0 - bot.health); const ph = phase(); if (ph !== null) phases.add(ph); };
  // Landing: up to 30 s for a perched phase (5, 6, 7).
  while (Date.now() - t0 < 30000 && !dead) { sample(); const ph = phase(); if ([5, 6, 7].includes(ph)) { perchedAt = Date.now() - t0; break; } await sleep(50); }
  const landing = { seconds: Math.round((Date.now() - t0) / 100) / 10, perched: perchedAt !== null, maxOff: Math.round(maxOff * 10) / 10, lost: Math.round(lost * 10) / 10, hurt: hurt.length, dead };
  // The run modes (note 1617): once perched, the bot is set 13 blocks from the dragon, in front along its head's line or square to its side, and sprints to the stand 7.2 forward on the line; measured: the lift, the loss, and whether the head came within the sword's reach (3 of the eyes).
  if (/^run_/.test(mode) && perchedAt !== null) {
    const d0 = dragon(); const yaw = d0.yaw || 0; const axis = { x: Math.sin(yaw), z: Math.cos(yaw) }; const side = { x: axis.z, z: -axis.x };
    const from = mode === 'run_front' ? { x: d0.position.x + axis.x * 13, z: d0.position.z + axis.z * 13 } : { x: d0.position.x + side.x * 13, z: d0.position.z + side.z * 13 };
    const stand = { x: d0.position.x + axis.x * 7.2, z: d0.position.z + axis.z * 7.2 };
    bot.setControlState('sneak', false);
    await command(end(`tp ${username} ${from.x.toFixed(1)} ${GROUND + 1} ${from.z.toFixed(1)}`)); await command(`effect give ${username} minecraft:instant_health 1 10 true`); await sleep(900);
    const s0 = bot.entity.position.clone(); const h0 = bot.health; maxOff = 0; maxY = s0.y; lost = 0; hurt = [];
    const headAt = () => { const d = dragon(); return d && new Vec3(d.position.x + Math.sin(d.yaw || 0) * 6.5, d.position.y - 1, d.position.z + Math.cos(d.yaw || 0) * 6.5); };
    let reach = 99; const tr = Date.now(); const yaws = [];
    while (Date.now() - tr < 6000 && !dead) {
      // The stand followed live: the perched dragon turns to the player, and the head's line with it.
      const dl = dragon(); if (dl) { const a = { x: Math.sin(dl.yaw || 0), z: Math.cos(dl.yaw || 0) }; stand.x = dl.position.x + a.x * 7.2; stand.z = dl.position.z + a.z * 7.2; yaws.push(Math.round((dl.yaw || 0) * 100) / 100); }
      const p = bot.entity.position; const dx = stand.x - p.x, dz = stand.z - p.z; const dist = Math.hypot(dx, dz);
      await bot.lookAt(new Vec3(stand.x, p.y + 1.6, stand.z), true);
      bot.setControlState('forward', dist > 0.6); bot.setControlState('sprint', dist > 2);
      maxOff = Math.max(maxOff, Math.hypot(p.x - s0.x, p.z - s0.z)); maxY = Math.max(maxY, p.y); lost = Math.max(lost, h0 - bot.health);
      const h = headAt(); if (h) reach = Math.min(reach, h.distanceTo(p.offset(0, 1.62, 0)));
      if (dist <= 0.6) break;
      await sleep(50);
    }
    bot.setControlState('forward', false); bot.setControlState('sprint', false);
    const p = bot.entity.position;
    log({ mode, trial: n, from: [Math.round(from.x), Math.round(from.z)], stand: [Math.round(stand.x * 10) / 10, Math.round(stand.z * 10) / 10], dragonYaw: Math.round(yaw * 100) / 100, yawsSeen: [yaws[0], yaws[Math.floor(yaws.length / 2)], yaws[yaws.length - 1]], run: { seconds: Math.round((Date.now() - tr) / 100) / 10, maxY: Math.round(maxY * 10) / 10, lost: Math.round(lost * 10) / 10, hurt: hurt.length, hurtBy: hurt.slice(0, 6), dead, reachToHead: Math.round(reach * 10) / 10, endedAt: [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, Math.round(p.z * 10) / 10], standOff: Math.round(Math.hypot(stand.x - p.x, stand.z - p.z) * 10) / 10 } });
    await command(end(`tp @e[type=ender_dragon] 0 140 0`));
    if (dead) await sleep(2000);
    return;
  }
  // Perched three seconds, then the take-off.
  const holdMs = Number(process.env.PERCH_HOLD || 3000); const clouds = [];
  const t1 = Date.now(); while (Date.now() - t1 < holdMs && !dead) { sample(); for (const e of Object.values(bot.entities)) if (e.name === 'area_effect_cloud' && e.isValid !== false && !clouds.some(c => c.id === e.id)) clouds.push({ id: e.id, at: e.position.floored(), afterMs: Date.now() - t1 }); await sleep(50); }
  const perchedSample = { maxOff: Math.round(maxOff * 10) / 10, lost: Math.round(lost * 10) / 10, hurt: hurt.length };
  await setPhase(4);
  const t2 = Date.now(); while (Date.now() - t2 < 8000 && !dead) { sample(); await sleep(50); }
  sample();
  const d = dragon();
  log({ mode, trial: n, at: AT, feetY, landing, perched: perchedSample, after: { maxOff: Math.round(maxOff * 10) / 10, minY: Math.round(minY * 10) / 10, maxY: Math.round(maxY * 10) / 10, lost: Math.round(lost * 10) / 10, hurt: hurt.length, hurtBy: hurt.slice(0, 6), dead, phases: [...phases], dragonAt: d ? d.position.floored() : null, clouds: clouds.slice(0, 4), holdMs } });
  await command(end(`tp @e[type=ender_dragon] 0 140 0`));
  if (dead) { await sleep(2000); }
}

bot.once('spawn', async () => {
  try {
    await sleep(1500);
    for (const mode of modes) for (let n = 1; n <= trials; n++) await trial(mode, n);
    const sum = mode => { const rows = out.filter(r => r.mode === mode); if (!rows.length) return null; if (rows[0].run) return { trials: rows.length, maxY: rows.map(r => r.run.maxY), lost: rows.map(r => r.run.lost), reachToHead: rows.map(r => r.run.reachToHead), standOff: rows.map(r => r.run.standOff), dead: rows.filter(r => r.run.dead).length }; return { trials: rows.length, perched: rows.filter(r => r.landing.perched).length, dead: rows.filter(r => r.after.dead).length, maxOff: rows.map(r => r.after.maxOff), lost: rows.map(r => r.after.lost), hurt: rows.map(r => r.after.hurt) }; };
    log({ summary: Object.fromEntries(modes.map(m => [m, sum(m)])) });
  } catch (err) { log({ error: err.stack || err.message }); }
  finally { await command(end(`tp @e[type=ender_dragon] 0 120 0`)); bot.quit(); setTimeout(() => process.exit(0), 500); }
});
