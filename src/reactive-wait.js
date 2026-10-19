'use strict';
const danger = require('./danger'), vitals = require('./vitals'), body = require('./body');
const { Task, Cancelled } = require('./skills');

function emergency(bot) {
  if (!bot.entity?.position || bot.isAlive === false || ['creative', 'spectator'].includes(bot.game?.gameMode)) return null;
  if (require('./terrain').bodyInLava(bot)) return { kind: 'lava' };
  if (vitals.headInBlock(bot)) return { kind: 'head_in_block' };
  if (vitals.inFire(bot) || (vitals.onFire(bot) && !body.outlastsBurning(bot) && !body.held(bot, 'fire'))) return { kind: 'fire' };
  const hot = vitals.onHotFloor(bot); if (hot) return { kind: 'hot_floor', hot };
  if (vitals.inPowderSnow(bot)) return { kind: 'snow' };
  if (vitals.needsAir(bot) && vitals.headSubmerged(bot)) return { kind: 'air' };
  const threat = danger.immediateThreat(bot);
  return threat && !threat.projectile ? { kind: 'mob', threat } : null;
}

async function respond(bot, survival, task, goal, save, event, fresh) {
  task.check();
  event = emergency(bot);
  if (!event) return false;
  const report = action => { goal.survivalAction = { ...action, at: new Date().toISOString() }; save(); };
  const answerBody = (kind, ways, facts = {}) => {
    const check = () => { task.check(); if (!fresh() || emergency(bot)?.kind !== event.kind) throw new Cancelled(task.label); };
    const guarded = Object.fromEntries(Object.entries(ways).map(([key, way]) => [key, { ...way, run: () => { check(); return way.run(); } }]));
    return body.answer(bot, task, kind, guarded, { client: survival.client, goal, save, facts,
      decide: async (id, options) => {
        check();
        const answer = await require('./decisions').decide(id, { ...options, interrupt: () => { check(); options.interrupt?.(); } });
        check(); return answer;
      } });
  };
  if (event.kind === 'lava') {
    const lava = require('./lava-escape');
    if (lava.mustEscape(bot)) await lava.escape(survival, task, goal, save);
    else await answerBody('lava', survival.lavaWays(task, goal, save));
  } else if (event.kind === 'snow') await vitals.outOfPowderSnow(bot, task, report);
  else if (event.kind !== 'mob') {
    const ways = event.kind === 'fire' ? vitals.fireWays(bot, task, report)
      : event.kind === 'head_in_block' ? vitals.headWays(bot, task, report)
      : event.kind === 'hot_floor' ? vitals.hotFloorWays(bot, task, report, event.hot) : vitals.airWays(bot, task, report);
    task.check();
    await answerBody(event.kind, ways, event.kind === 'fire' ? { inFire: vitals.inFire(bot) } : {});
  } else {
    const threats = danger.threats(bot).filter(t => t.visible || t.distance <= 3);
    if (!threats.length) threats.push(event.threat);
    const tree = {
      retreat: { description: 'Escape the immediate attackers using nearby safe footing; do not gather or prepare supplies.', run: () => survival.runAway(task, goal, save, threats) },
      fight: { description: 'Defend against attackers already in reach with the equipment currently carried, for one second.', run: () => survival.swingFor(task, goal, save, 1000) },
    };
    const decision = await survival.decide(task, goal, save, { id: 'encounter_stance', tree,
      state: { health: bot.health, food: bot.food, waitingForPlayer: true, threats: threats.map(t => ({ name: t.entity.name, distance: t.distance })) },
      isFresh: () => fresh() && emergency(bot)?.threat?.entity?.id === event.threat.entity.id });
    task.check();
    if (!decision?.stale && fresh() && emergency(bot)?.threat?.entity?.id === event.threat.entity.id && Object.hasOwn(tree, decision?.path?.[0])) await tree[decision.path[0]].run();
  }
  task.check();
  return true;
}

function createReactiveWait({ bot, survival, save = () => {}, isReady = () => true, isBusy = () => false } = {}) {
  let active = null;
  bot._reactiveWaitActive = false;
  const allowed = () => bot._waitingForRequest === true && isReady() && !isBusy() && bot.isAlive !== false;
  const stopMotion = () => { bot.pathfinder?.setGoal?.(null); bot.clearControlStates?.(); bot.deactivateItem?.(); };
  return {
    async tick() {
      if (!allowed()) return false;
      const event = emergency(bot);
      if (active) { if (!event) active.task.cancel(); return false; }
      if (!event) return false;
      const epoch = bot._requestActivityEpoch, task = new Task('reactive_wait', 'React to immediate danger while waiting for a player request');
      const fresh = () => allowed() && epoch === bot._requestActivityEpoch && !task.cancelled;
      task.interruptCheck = () => { if (!fresh()) throw new Cancelled(task.label); };
      const record = { task, promise: null }; active = record; bot._reactiveWaitActive = true;
      const goal = { kind: 'survive', request: task.description, survival: survival.state };
      record.promise = Promise.resolve().then(() => respond(bot, survival, task, goal, save, event, fresh))
        .catch(error => { if (error.name === 'Cancelled' || task.cancelled || epoch !== bot._requestActivityEpoch) return false; throw error; })
        .finally(() => { if (active === record) { active = null; bot._reactiveWaitActive = false; stopMotion(); } });
      return record.promise;
    },
    async cancel() {
      const record = active; if (!record) return;
      record.task.cancel(); stopMotion();
      await record.promise.catch(() => {});
    },
  };
}

module.exports = { createReactiveWait };
