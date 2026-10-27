'use strict';

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const hazards = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'powder_snow']);
const clear = block => block && block._jevUnknown !== true && block.boundingBox === 'empty' && !hazards.has(block.name) && !/water/.test(block.name);
const targetOf = goal => Number.isFinite(goal?.x) && Number.isFinite(goal?.z)
  ? { x: goal.x, y: Number.isFinite(goal.y) ? goal.y : null, z: goal.z } : null;
const distance = (a, b) => Math.hypot(a.x - b.x, b.y === null ? 0 : a.y - b.y, a.z - b.z);
const blocked = () => Object.assign(new Error('I cannot find a walkable route in the terrain I have observed. Please show me a way through.'),
  { name: 'Blocked', needsPlayer: true, code: 'OBSERVED_ROUTE_REQUIRED' });

function nextObservedWaypoint(bot, target) {
  const here = bot.entity.position, base = here.floored(), before = distance(here, target), choices = [];
  for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) {
    const flat = Math.hypot(x, z);
    if (flat < 3 || flat > 8) continue;
    for (let y = -2; y <= 1; y++) {
      const at = base.offset(x, y, z), floor = bot.blockAt(at.offset(0, -1, 0));
      if (!floor || floor._jevUnknown || floor.boundingBox !== 'block' || hazards.has(floor.name)) continue;
      if (!clear(bot.blockAt(at)) || !clear(bot.blockAt(at.offset(0, 1, 0)))) continue;
      const position = at.offset(.5, 0, .5), remaining = distance(position, target);
      if (before - remaining >= 2) choices.push({ position, remaining });
    }
  }
  return choices.sort((a, b) => a.remaining - b.remaining)[0]?.position || null;
}

// Long trips reveal their route one observed leg at a time. The route finder
// still verifies each leg; selecting a waypoint never treats unknown as air.
async function observedNavigation(bot, task, goal, options, walk) {
  const target = targetOf(goal);
  if (bot.perception?.mode !== 'player' || !target || distance(bot.entity.position, target) <= 14) return walk(goal, options);
  const deadline = Date.now() + Math.min(180000, Math.max(1000, options.timeoutMs || 90000));
  let legs = 0;
  while (distance(bot.entity.position, target) > 14 && legs++ < 32 && Date.now() < deadline) {
    task.check();
    if (options.stopWhen?.()) return;
    const here = bot.entity.position.clone();
    await bot.lookAt?.(new Vec3(target.x, here.y + 1, target.z), false);
    bot.perception.refresh?.();
    let waypoint = nextObservedWaypoint(bot, target);
    if (!waypoint) throw blocked();
    await walk(new goals.GoalNear(waypoint.x, waypoint.y, waypoint.z, 1),
      { ...options, timeoutMs: Math.min(12000, Math.max(1, deadline - Date.now())), stallMs: Math.min(options.stallMs || 8000, 8000) });
    task.check();
    if (bot.entity.position.distanceTo(here) < .5) throw blocked();
  }
  if (distance(bot.entity.position, target) > 14) throw blocked();
  return walk(goal, { ...options, timeoutMs: Math.max(1, deadline - Date.now()) });
}

module.exports = { nextObservedWaypoint, observedNavigation };
