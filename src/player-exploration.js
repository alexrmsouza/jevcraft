'use strict';

const { exploreStep, markExplored, areaOf } = require('./exploration');

async function explorationRequestStep(bot, task, goal, save, { navigate, noticeVillage, now = Date.now, explore = exploreStep } = {}) {
  goal.playerExploration ||= { startedAt: now(), visited: [], origin: areaOf(String(bot.game.dimension).replace(/^minecraft:/, ''), bot.entity.position.x, bot.entity.position.z).key };
  const state = goal.playerExploration;
  if (state.visited.length >= (goal.count || 1)) return true;
  if (now() - state.startedAt > 300000) throw Object.assign(new Error('The exploration time budget ended before I reached the requested new areas. I saved what I observed.'),
    { name: 'Blocked', needsPlayer: true, code: 'EXPLORATION_BUDGET' });
  await explore(bot, task, goal, save, { navigate, home: goal.survival?.home?.origin, noticeVillage });
  task.check();
  markExplored(bot, goal, { now: now() });
  const area = areaOf(String(bot.game.dimension).replace(/^minecraft:/, ''), bot.entity.position.x, bot.entity.position.z).key;
  if (area !== state.origin && !state.visited.includes(area)) state.visited.push(area);
  goal.step = { ...goal.step, action: 'explore', visitedAreas: state.visited.length, requestedAreas: goal.count || 1 };
  save();
  return state.visited.length >= (goal.count || 1);
}

module.exports = { explorationRequestStep };
