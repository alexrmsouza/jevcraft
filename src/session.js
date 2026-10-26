'use strict';
const DEATH_WORDS = /^(was |were |died|drowned|fell|burned|went up in flames|tried to swim|blew up|hit the ground|starved|suffocated|froze|withered|walked into|experienced kinetic|discovered the floor)/;

const path = require('path');
const fs = require('fs');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { configureMovements } = require('./movement');
const { interpret, GoalStore } = require('./objectives');
const { designerAvailable } = require('./designer');
const { WorldKnowledge } = require('./world-knowledge');
const { DAY } = require('./day');
const { setAside, isSetAside, attemptsFor } = require('./progress');
const { planCatalog } = require('./knowledge');
const { runGoal, runIdle, createSurvival } = require('./work');
const { Task } = require('./skills');
const { parseAddress, chatNames, clarificationReply, CLARIFY_MS } = require('./chat-address');
const { compatibilityPlugin } = require('./compatibility');
const { requestedCommand, createCommandAccess } = require('./commands');
const { classifyCommand } = require('./command-classifier');
const { recordDeath, observeAliveInventory } = require('./recovery');
const { statusMessage } = require('./status');
const { bundleSummary } = require('./item-bundle');
const { friendlyProblem, intakeProblem, recoveryHint, quietRepeats, thinking } = require('./speech');
const { withRequestSignal } = require('./typesafe');
const { suspendPrevious, resumeSaved, waitingCleared } = require('./suspended-tasks');
const { CompanionMemory, position } = require('./memory');
const { BuildRegistry, resolveBuildContinuation } = require('./builds');
const { nextDreamRequest, shouldLaunchDream, DREAMS, FAILED_LAUNCH_MS, dreamTitle, dreamReport, noteCustomAttempt, customVerdict } = require('./dream');
const { immediateThreat } = require('./danger');
const { createReactiveWait } = require('./reactive-wait');
const { createChatPolicy } = require('./chat-policy');
const { createCommunicationPolicy, announce } = require('./communication');
const { createSessionCompanion } = require('./session-companion');
const { localize, displayName } = require('./language');
const { Ledger, withRun, appendSummary } = require('./ledger');

// The planner's verdict on a request, before any work starts: an error
// when no survival method exists for something asked for, otherwise null.
// Only that verdict: a plan that fails for want of a tool or a place is
// work, and runGoal finds its way round those.
function unworkable(bot, spec) {
  if (bot.game?.gameMode !== 'survival' || !['obtain', 'craft', 'bundle'].includes(spec.kind)) return null;
  const wanted = spec.kind === 'bundle' ? (spec.tasks || []).map(t => [t.item, t.count]) : [[spec.item, spec.count]];
  const stock = {};
  for (const item of bot.inventory.items()) stock[item.name] = (stock[item.name] || 0) + item.count;
  for (const [item, count] of wanted) {
    if (!item) continue;
    try { planCatalog(bot.registry, item, count || 1, stock); }
    catch (err) { if (err.name === 'PlanError' && /No supported survival acquisition/.test(err.message)) return err; }
  }
  return null;
}

function createSession(config, client, { stateDirectory = path.join(__dirname, '..', '.bot-state'), recorder, planner,
  runLedger = path.join(stateDirectory, 'run-ledger.md'), companionNow = Date.now } = {}) {
  const identity = `${config.host}-${config.port}-${config.username}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const communication = createCommunicationPolicy({ host: config.host, language: process.env.JEV_LANGUAGE, narration: process.env.JEV_NARRATION,
    personality: process.env.JEV_PERSONALITY, initiative: process.env.JEV_INITIATIVE,
    file: path.join(stateDirectory, `${identity}-communication.json`), admins: process.env.JEV_CHAT_ADMINS });
  let ended = false, spawned = false, resolveClosed;
  const connectedAt = Date.now();
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const bot = mineflayer.createBot({ ...config, respawn: false });
  Object.defineProperties(bot, {
    _jevLanguage: { configurable: true, get: () => communication.language },
    _jevNarration: { configurable: true, get: () => communication.narration },
    _jevPersonality: { configurable: true, get: () => communication.personality },
    _jevInitiative: { configurable: true, get: () => communication.initiative },
  });
  const text = (english, portuguese) => localize(bot, english, portuguese);
  const localizedDreamTitle = standing => dreamTitle(standing, bot);
  const reportDream = (standing, lastGoal) => dreamReport(standing, lastGoal, bot);
  function setWaitingForRequest(waiting) {
    bot._waitingForRequest = waiting;
    if (planner) bot._requestActivityEpoch = (bot._requestActivityEpoch || 0) + 1;
  }
  setWaitingForRequest(Boolean(planner));
  global.__jevBot = bot;
  // The damage types by index, from the registry the server sends before
  // login, for the flight record's damage frames (recorder/observer.js).
  bot._damageTypeNames = [];
  // Freezing, from the server's own word: powder snow has no collision
  // box, and a bot standing in it was not always seen to be (mid-202-f
  // froze to death at y 121 with the way out tried once, note 308).
  // Standing in fire, the same way (vitals.js inFire): mid-229-g burned from
  // eleven health to none in a fire a ghast's fireball lit (note 340).
  // The bot's own hit on a neutral of a group angers the group (anger.js,
  // note 703).
  require('./anger').install(bot);
  bot._client.on('damage_event', packet => {
    if (!bot.entity || packet.entityId !== bot.entity.id) return;
    const type = bot._damageTypeNames?.[packet.sourceTypeId];
    if (type === 'freeze') bot._freezingAt = Date.now();
    if (type === 'in_fire') bot._inFireAt = Date.now();
    // What each lights the bot for, the longer kept (combat-estimate
    // burnLeft): the fire on the bot is in every stance's figures (note 548).
    const lights = require('./combat-estimate').FIRE_SECONDS[type];
    if (lights) bot._alightUntil = Math.max(bot._alightUntil || 0, Date.now() + lights * 1000);
    // A warden's boom, counted for the pocket's question (survival.js
    // wardenSays): mid-230-n was boomed through its pocket's wall and asked
    // again told nothing of it (note 412).
    if (type === 'sonic_boom') (bot._sonicBooms ||= []).push(Date.now());
    // A mob's blow at arm's length (not its shot): the body's own ways that
    // take seconds of footwork stop at it (cauldron.js struck, note 657).
    if (type === 'mob_attack' || type === 'mob_attack_no_aggro') { bot._blowAt = Date.now(); bot._blowBy = bot.entities?.[packet.sourceCauseId - 1]?.name || null; }
  });
  // When each of the bot's own effects came: mineflayer keeps the length the
  // server sent, and what is left of a poison or a wither is that less the
  // time since (combat-estimate effectLeft; note 542).
  bot.on('entityEffect', (entity, effect) => { if (entity === bot.entity && effect) effect.at = Date.now(); });
  // Each shriek of a sculk shrieker darkens the players about it: counted
  // as the warnings toward a warden (sculk.js).
  bot.on('entityEffect', (entity, effect) => {
    if (entity !== bot.entity || effect?.id !== bot.registry?.effectsByName?.darkness?.id) return;
    const shrieks = bot._shrieks ||= [];
    if (!shrieks.length || Date.now() - shrieks.at(-1) > 5000) shrieks.push(Date.now());
  });
  bot._client.on('registry_data', packet => { if (/damage_type/.test(String(packet?.id || '')) && Array.isArray(packet.entries)) packet.entries.forEach((e, i) => { bot._damageTypeNames[i] = String(e.key || e.id || '').replace('minecraft:', ''); }); });
  bot.on('physicsTick', () => { if (!ended) observeAliveInventory(bot); });
  bot.on('handover', event => { if (!ended) console.log(JSON.stringify({ handover: event })); });
  for (const event of ['recovery_advice', 'recovery_result']) bot.on(event, data => {
    if (ended) return;
    const record = data.record || data;
    console.log(JSON.stringify({ [event]: { status: record.status, source: record.source, model: record.model, diagnosis: record.diagnosis,
      jev: record.jev?.judgment, steps: record.steps, outcome: data.outcome || record.outcome, latencyMs: record.latencyMs, usage: record.usage } }));
  });
  bot.loadPlugin(compatibilityPlugin);
  bot.loadPlugin(pathfinder);
  // Every goal the pathfinder is given, by any route (goto calls setGoal),
  // is made whole first: one without isValid crashed the process four
  // times. A plugin, so it is injected after the pathfinder's: wrapped here
  // directly it found no pathfinder yet (plugins inject a tick later) and
  // wrapped nothing.
  bot.loadPlugin(require('./skills').goalGuardPlugin);
  bot.loadPlugin(require('./skills').digGuardPlugin);
  // After the guard, so a dig it refuses never asks the server: a dig is
  // finished only when the server has broken the block (server-truth.js).
  bot.loadPlugin(require('./server-truth').serverTruthPlugin);
  bot.loadPlugin(require('./own-blocks').ownBlocksPlugin);
  // The way in, kept while in the Nether: the walk out with rods goes back
  // along it (walk-out.js, note 762).
  bot.loadPlugin(require('./walk-out').wayInPlugin);
  // The footing of the last three minutes, the retreat's way back (note 793).
  bot.loadPlugin(require('./way-back').plugin);
  bot.loadPlugin(require('./gaze').gazePlugin);
  bot.loadPlugin(require('./riders').ridersPlugin);
  // A window click the window refuses ("invalid operation") is logged with
  // the click and the window, so the craft that made it can be named: it
  // failed crafts twenty and more times a trial in mid-215-c and mid-220-a
  // with no more said than that (2026-09-26).
  bot.once('inject_allowed', () => {
    const click = bot.clickWindow;
    if (typeof click !== 'function') return;
    bot.clickWindow = async (slot, mouseButton, mode, ...rest) => {
      try { return await click.call(bot, slot, mouseButton, mode, ...rest); }
      catch (err) {
        if (/invalid operation/.test(err?.message || '')) {
          const w = bot.currentWindow || bot.inventory;
          console.log(`[window] invalid click ${JSON.stringify({ slot, mouseButton, mode, window: w?.type, inventoryEnd: w?.inventoryEnd, selected: w?.selectedItem?.name ?? null })} ${String(err.stack || '').split('\n').slice(1, 6).map(l => l.trim()).join(' | ')}`);
        }
        throw err;
      }
    };
  });
  // Mineflayer injects its own chat plugin after createBot, which would
  // overwrite a wrapper installed now; the filter goes on once chat exists.
  bot.once('spawn', () => quietRepeats(bot));
  // A world search that holds the event loop, said by its caller (note 772).
  bot.once('spawn', () => { try { require('./slow-calls').install(bot); } catch (_) { /* not watched */ } });
  // A new build is taken at a quiet moment (quiet-restart.js).
  if (!process.env.JEV_NO_QUIET_RESTART) bot.once('spawn', () => require('./quiet-restart').watchRestartRequest(bot, path.join(stateDirectory, 'restart-requested'), { startedAt: connectedAt, port: config.port }));
  const chatPolicy = planner ? createChatPolicy({ host: config.host,
    file: path.join(stateDirectory, `${identity}-chat-policy.json`),
    mode: process.env.JEV_CHAT_MODE, admins: process.env.JEV_CHAT_ADMINS }) : null;
  const commandLog = path.join(stateDirectory, `${identity}-commands.jsonl`);
  bot._client.on('declare_commands', tree => {
    if (ended) return;
    bot.commandTree = tree;
    fs.mkdirSync(path.dirname(commandLog), { recursive: true });
    fs.writeFileSync(path.join(stateDirectory, `${identity}-command-tree.json`), JSON.stringify(tree));
  });
  let commandAccess;
  bot.loadPlugin(() => { commandAccess = createCommandAccess(bot, {
    users: (process.env.MC_COMMAND_USERS || '').split(',').map(name => name.trim()).filter(Boolean),
    audit: event => { fs.mkdirSync(path.dirname(commandLog), { recursive: true }); fs.appendFileSync(commandLog, JSON.stringify(event) + '\n'); },
  }); });
  const store = new GoalStore(path.join(stateDirectory, `${identity}.json`));
  const memoryIdentity = process.env.MC_WORLD_ID ? `${identity}-${process.env.MC_WORLD_ID.replace(/[^a-zA-Z0-9_-]/g, '_')}` : identity;
  // The base, its bed and the shelters are places in one world. Kept per
  // server, a new world on the same port inherited them, and the bot walked
  // home at dusk to a bed that was never there.
  const survivalStore = new GoalStore(path.join(stateDirectory, `${memoryIdentity}-survival.json`));
  const idleStore = new GoalStore(path.join(stateDirectory, `${identity}-idle.json`));
  const memorySeed = store.read(), needsMemoryId = memorySeed && !memorySeed.memoryId;
  const memory = new CompanionMemory(path.join(stateDirectory, `${memoryIdentity}-memory.json`), {
    seedGoal: memorySeed, seedResources: { ...idleStore.read()?.resourceMemory, ...memorySeed?.resourceMemory },
  });
  if (needsMemoryId && memorySeed.memoryId) store.save(memorySeed);
  bot.companionMemory = memory;
  // Structures outlive the goal that built them, so this store is keyed to the
  // world rather than the request and is shared by every later build.
  const builds = new BuildRegistry(path.join(stateDirectory, `${memoryIdentity}-builds.json`));
  bot.buildRegistry = builds;
  // The dream: what the bot works toward when nobody has asked for
  // anything. Kept per world, beside the builds it produces.
  const dreamStore = new GoalStore(path.join(stateDirectory, `${memoryIdentity}-dream.json`));
  const saveDream = standing => { if (!ended) dreamStore.save({ version: 1, ...standing }); };
  // Portals, villages, the End portal and the run's progress: kept per
  // world and handed to every goal, not left on the goal that found them.
  // Seeded from the old per-server goal stores only where they can be this
  // world's: with a world id they may be another world's, and a new world
  // began with the old one's portals and game progress.
  const world = new WorldKnowledge(new GoalStore(path.join(stateDirectory, `${memoryIdentity}-world.json`)),
    { seedFrom: memoryIdentity === identity ? [store.read(), idleStore.read()] : [] });
  // The cost ledger: every Jev call charged to the request or dream it
  // served, kept per world, and summarized to run-ledger.md in the state directory when a run
  // ends. The client feeds it; the session only says which run is paying.
  const ledger = new Ledger(path.join(stateDirectory, `${memoryIdentity}-ledger.json`), {
    age: () => bot.time?.age, onClose: run => { if (runLedger) appendSummary(runLedger, run); } });
  client.ledger = ledger;
  // Whatever is active pays for the calls made on its behalf; with nothing
  // active, an idle bot that has a dream is still that dream's cost.
  const routed = withRun(client, () => active?.goal.ledgerRun ?? dreamStore.read()?.ledgerRun);
  const dreamName = (key, text) => `dream · ${key === 'custom' ? text : DREAMS[key].title}`;
  // The dream's run in the ledger. A standing from before the ledger
  // existed gets one now, dated from when the dream was given.
  function dreamRun(standing) {
    if (!standing?.dream || standing.satisfiedAt || ended) return standing?.ledgerRun;
    const run = ledger.open({ id: standing.ledgerRun, kind: 'dream', name: dreamName(standing.dream, standing.text), startedAt: standing.setAt });
    if (standing.ledgerRun !== run.id) { standing.ledgerRun = run.id; saveDream(standing); }
    return run.id;
  }
  dreamRun(dreamStore.read());
  const readyForDream = () => bot.game?.gameMode === 'creative' ||
    ((bot.game?.dimension !== 'minecraft:overworld' && bot.game?.dimension !== 'overworld' || (bot.time?.timeOfDay ?? 0) < DAY.DUSK) &&
      (bot.health ?? 20) >= 14 && (bot.food ?? 20) >= 12 && !immediateThreat(bot));
  let launchingDream = false;
  // The old goal's copy only where it can be this world's: with a world id
  // the goal store is still per server.
  const survival = createSurvival(bot, { state: survivalStore.read() || (memoryIdentity === identity ? store.read()?.survival : undefined), client: routed });
  if (!survivalStore.read() && store.read()?.status === 'cancelled') survival.state.paused = true;
  const saveSurvival = () => { if (!ended) { survival.state.version = 1; survivalStore.save(survival.state); } };
  if (planner) { survival.state.paused = true; saveSurvival(); }
  let companion;
  const saveGoal = goal => { if (!ended) { memory.recordGoal(goal, bot); companion?.memory.task(goal.from, goal); world.harvest(goal); store.save(goal); } };
  const workStore = { save: goal => { saveGoal(goal); saveSurvival(); } };
  let active = null;
  // A goal going again after a threat escaped its loop (launch's catch).
  let relaunching = false;
  let pending = Promise.resolve();
  let generation = 0;
  let requestController = new AbortController();
  function invalidateRequests() {
    generation++;
    if (planner) bot._requestActivityEpoch++;
    requestController.abort(new Error('Player request interrupted'));
    requestController = new AbortController();
  }
  let ready = false;
  let pendingRequests = 0;
  let observation;
  const reactiveWait = planner ? createReactiveWait({ bot, survival, save: saveSurvival,
    isReady: () => ready && !ended, isBusy: () => Boolean(active) || relaunching }) : null;
  companion = createSessionCompanion({ bot,
    file: path.join(stateDirectory, `${memoryIdentity}-conversation.json`),
    dialogueFile: path.join(stateDirectory, `${memoryIdentity}-dialogue.json`),
    now: companionNow,
    settings: () => ({ language: communication.language, narration: communication.narration,
      personality: communication.personality, initiative: communication.initiative }),
    getGoal: () => active && !active.idle ? active.goal : store.read(),
    getDiscoveries: () => require('./exploration').foundEntries(world.known),
    isReady: () => ready && !ended,
    isWorking: () => Boolean(active && !active.idle && !active.task.cancelled),
    onBlocked: (goal, reason) => {
      const session = active;
      if (!session || session.idle || session.goal !== goal || session.helpPausing || session.task.cancelled) return;
      session.helpPausing = true;
      goal.helpReason = reason;
      if (reason === 'no_progress') goal.lastError = 'No measurable progress on the current task';
      // stop unwinds work before any help is requested. Reactive waiting takes
      // over in launch's finally block; no second executor is started here.
      stop('blocked').catch(console.error);
    },
  });

  async function stop(status = 'cancelled') {
    if (planner && status === 'cancelled') setWaitingForRequest(true);
    if (status === 'cancelled') { survival.state.paused = true; saveSurvival(); }
    if (!active) {
      if (status === 'cancelled') {
        const saved = store.read();
        if (saved && ['pending', 'running', 'recovering', 'blocked'].includes(saved.status)) { saved.status = 'cancelled'; saveGoal(saved); }
      }
      await reactiveWait?.cancel();
      return;
    }
    active.task.cancel();
    if (!active.idle) { active.goal.status = status; workStore.save(active.goal); }
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    bot.stopDigging();
    bot.deactivateItem();
    await active.promise;
  }

  function launch(goal) {
    setWaitingForRequest(false);
    world.hydrate(goal);
    memory.bind(goal);
    goal.memoryContext = memory.context(goal.from);
    survival.state.paused = false; delete survival.state.idleBlocked; delete survival.state.deathBlocked; saveSurvival();
    // The goal's calls are charged to its run: the dream's when the dream
    // launched it, otherwise the request's own, picked back up by id.
    if (goal.dream) goal.ledgerRun = dreamRun(dreamStore.read()) ?? goal.ledgerRun;
    else goal.ledgerRun = ledger.open({ id: goal.ledgerRun, kind: 'request', name: goal.request, startedAt: goal.createdAt }).id;
    const task = new Task(goal.kind, goal.request);
    const session = { task, goal };
    active = session;
    clarifying.clear();
    companion.started(goal);
    session.promise = runGoal(bot, task, goal, workStore, {
      decisionClient: routed, survival,
      onStep: g => {
        if (!session.task.cancelled && companion.safe()) companion.observe(g);
        console.log(JSON.stringify({ status: g.status, step: g.step, decision: g.decisions?.at(-1), position: bot.entity.position, error: g.lastError })); observation?.sample('step', undefined, g);
        // Every step change, not only the one a second the supervisor sees:
        // mid-110-f's staircase and retreat traded seven times in eight
        // seconds, between its looks, and the audit caught what it did not.
        try { if (bot.game?.gameMode !== 'creative') require('./stillness').flipWatch(bot, g); } catch (_) { /* a look missed */ }
      },
    }).catch(err => {
      // A threat or a breath that escaped the goal's own loop is the moment,
      // not the goal: the dream run was parked "blocked" on "Threat nearby:
      // something unseen at 0 blocks" and stood idle for sixteen hours
      // (2026-09-25). It goes again in a few seconds, from where it is.
      // Five in a minute is not a moment, and is parked as before.
      const recent = (goal.relaunches || []).filter(t => Date.now() - t < 60000);
      if (['NeedsSafety', 'NeedsAir'].includes(err.name) && recent.length < 5) {
        goal.relaunches = [...recent, Date.now()]; goal.lastError = err.message; saveGoal(goal);
        observation?.sample('error', { message: err.message, relaunch: true }, goal);
        session.relaunch = true;
        return;
      }
      if (err.name !== 'Cancelled') {
        goal.status = 'blocked'; goal.lastError = err.message; saveGoal(goal);
        observation?.sample('error', { message: err.message }, goal);
        console.error(err);
        if (!planner) announce(bot, `${friendlyProblem(err, { bot })} ${recoveryHint(err, bot)}`, 'important');
      }
    }).finally(() => {
      if (active === session) {
        active = null;
        if (planner && !session.relaunch) { setWaitingForRequest(true); survival.state.paused = true; saveSurvival(); }
      }
      if (session.relaunch) {
        relaunching = true;
        const revision = generation;
        setTimeout(() => { relaunching = false; if (!ended && !active && (!planner || revision === generation)) launch(goal); }, 1500);
        return;
      }
      if (!goal.dream && ['complete', 'blocked'].includes(goal.status)) ledger.close(goal.ledgerRun, goal.status);
      if (!ended && !session.relaunch) {
        if (goal.status === 'blocked') companion.blocked(goal);
        else if (goal.status === 'complete') companion.completed(goal);
      }
      // A custom dream is one request: done when it completes.
      if (goal.dream === 'custom' && goal.status === 'complete' && !ended) settleCustom(dreamStore.read(), goal);
    });
  }

  // A custom dream ends when its request completes, and is set aside after
  // too many attempts that came to nothing: said in chat, never retried forever.
  function settleCustom(standing, lastGoal) {
    const verdict = customVerdict(standing, lastGoal);
    if (!verdict || ended) return false;
    if (verdict === 'done') {
      const { ledgerRun, ...rest } = standing;
      saveDream({ ...rest, satisfiedAt: new Date().toISOString() });
      if (ledgerRun) ledger.close(ledgerRun, 'satisfied');
      announce(bot, text(`I did my dream: ${standing.text}. Tell me to chase it again, or give me a new dream, if you want more.`, `Concluí meu sonho: ${standing.text}. Peça para eu continuar ou me dê um novo sonho se quiser mais.`), 'important');
    } else {
      saveDream({ ...standing, paused: true, pausedBy: 'failures', pausedAt: new Date().toISOString() });
      announce(bot, text(`I could not do my dream (${standing.text}) after ${standing.failures} tries, so I am setting it aside. Say "chase your dream" to try again.`, `Não consegui realizar meu sonho (${standing.text}) após ${standing.failures} tentativas, então vou deixá-lo de lado. Diga "chase your dream" para tentar novamente.`), 'important');
    }
    return true;
  }
  // The custom dream's text, read as a chat request would be, with the world as it is.
  function interpretDreamText(standing, runId) {
    const from = standing.setBy, requestClient = withRun(client, runId);
    const speaker = bot.players[from]?.entity?.position;
    return interpret(requestClient, `${bot.username} ${standing.text}`, from, bot.username, {
      registry: bot.registry, players: Object.keys(bot.players),
      speakerPosition: position(speaker), botPosition: position(bot.entity?.position), dimension: bot.game.dimension,
      memory: { ...memory.context(from), found: require('./exploration').foundEntries(world.known) },
      builds: builds.describe(bot, bot.entity.position, bot.game.dimension),
      continueBuilds: (request, candidates) => resolveBuildContinuation(requestClient, request, candidates, { speaker: position(speaker) }),
      inventory: Object.fromEntries(bot.inventory.items().map(item => [item.name, item.count])),
    });
  }

  // Hand the dream its next request, as if a player had typed it. Jev
  // chooses the milestone from what code enumerates; a failure to choose or
  // an unusable answer falls back to ordinary idling until the cool-down ends.
  async function launchDream(standing) {
    launchingDream = true;
    try {
      if (standing.dream === 'custom') {
        noteCustomAttempt(standing, store.read()); saveDream(standing);
        if (settleCustom(standing, store.read())) return;
      }
      const structures = builds.describe(bot, bot.entity.position, bot.game.dimension);
      const runId = dreamRun(standing);
      const next = await nextDreamRequest(withRun(client, runId), standing, { structures, shelf: require('./schematic-library').library(bot.registry), designer: designerAvailable(bot),
        interpretRequest: () => interpretDreamText(standing, runId) });
      if (ended || active) return;
      if (standing.dream === 'custom') {
        if (next.kind === 'house' && designerAvailable(bot)) next.kind = 'build';
        const impossible = unworkable(bot, next);
        if (impossible) throw Object.assign(new Error(`My dream "${standing.text}" cannot be done here: ${impossible.message}`), { name: 'DreamRequest' });
      }
      standing.lastAttemptAt = Date.now();
      if (!next || next.done) {
        standing.satisfiedAt = new Date().toISOString(); standing.lastScore = next?.villageScore; delete standing.ledgerRun; saveDream(standing);
        ledger.close(runId, 'satisfied');
        announce(bot, text(`I think my dream to ${dreamTitle(standing)} is done for now. Tell me to chase it again if you want more.`, `Acho que meu sonho de ${localizedDreamTitle(standing)} está concluído por enquanto. Peça para eu continuar se quiser mais.`), 'important');
        return;
      }
      attemptsFor(survival).clear('dream_launch', standing.dream); saveDream(standing);
      const goal = { ...next, ledgerRun: runId, version: 1, status: 'pending', createdAt: new Date().toISOString(), suspendedTasks: suspendPrevious(store.read()),
        requesterPosition: null, initialInventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })) };
      saveGoal(goal);
      const firstRung = next.kind === 'win' ? require('./game-progress').nextGameStage(bot, goal).phase?.replaceAll('_', ' ') : null;
      announce(bot, text(`Nothing needs me, so I'm chasing my dream to ${dreamTitle(standing)}${next.villageScore !== undefined && next.villageScore !== null ? ` (the village is ${Math.round(next.villageScore * 100 / 3)}% there)` : ''}${firstRung ? `. First: ${firstRung}.` : `: ${next.request}.`}`, `Estou livre, então vou seguir meu sonho de ${localizedDreamTitle(standing)}.`));
      launch(goal);
    } catch (err) {
      console.error('[dream]', err.message);
      standing.lastAttemptAt = Date.now();
      // Only a text that would not come out as a doable request counts against
      // a custom dream; Jev being unreachable is not the dream's failure.
      const unusable = standing.dream === 'custom' && err.name === 'DreamRequest';
      if (unusable) standing.failures = (standing.failures || 0) + 1;
      saveDream(standing);
      if (unusable) settleCustom(standing, store.read());
      setAside(survival, 'dream_launch', standing.dream, err, FAILED_LAUNCH_MS); saveSurvival();
    } finally { launchingDream = false; }
  }

  function launchIdle() {
    const retained = store.read();
    const standing = dreamStore.read();
    if (standing?.dream && !launchingDream && shouldLaunchDream(standing, retained, { ready: readyForDream(), resting: isSetAside(survival, 'dream_launch', standing.dream) })) { launchDream(standing); return; }
    const goal = { ...(idleStore.read() || {}), version: 1, kind: 'survive', request: 'Stay alive and prepare supplies between player requests',
      retainedRequest: retained?.request, blueprint: retained?.blueprint, survival: survival.state,
      // A dream set aside is not chased by the idle loop either.
      dream: standing?.dream && !standing.satisfiedAt && !standing.paused ? standing.dream : undefined,
      ledgerRun: standing?.dream && !standing.satisfiedAt && !standing.paused ? standing.ledgerRun : undefined };
    world.hydrate(goal);
    memory.bind(goal);
    const task = new Task('survival', goal.request);
    const session = { task, goal, idle: true };
    active = session;
    // The idle loop runs until something else should: a dream whose
    // next request can be launched ends it, and the next tick launches that.
    let checkedAt = 0, launchable = false;
    const until = () => {
      if (Date.now() - checkedAt < 3000) return launchable;
      checkedAt = Date.now();
      const current = dreamStore.read();
      launchable = !!current?.dream && shouldLaunchDream(current, store.read(), { ready: readyForDream(), resting: isSetAside(survival, 'dream_launch', current.dream) });
      return launchable;
    };
    session.promise = runIdle(bot, task, goal, { save: g => { if (!ended) { world.harvest(g); idleStore.save(g); memory.flush(); } saveSurvival(); } }, {
      survival, decisionClient: routed, until,
      onStep: g => { console.log(JSON.stringify({ idle: true, survivalAction: g.survivalAction, decision: g.decisions?.at(-1)?.path, health: bot.health, food: bot.food, position: bot.entity.position, error: g.lastError })); observation?.sample('step', undefined, g); },
    }).catch(err => {
      if (err.name !== 'Cancelled') {
        survival.state.idleBlocked = err.message; saveSurvival();
        observation?.sample('error', { message: err.message }, goal);
        console.error(err); announce(bot, friendlyProblem(err, { bot }), 'important');
      }
    }).finally(() => { if (active === session) active = null; });
  }

  async function resume(revision = generation, options) {
    const respond = message => options?.from ? companion.sayTo(options.from, message) : bot.chat(message);
    await reactiveWait?.cancel();
    if (active?.idle) await stop('interrupted');
    // The dream is what the bot does with nobody's work waiting. A player's
    // stopped or replaced request under it comes first; the dream picks up
    // again, knowing what it knew, once that is done.
    if (active?.goal.dream && !options?.currentOnly) {
      const waiting = resumeSaved({ ...active.goal, status: 'replaced' });
      if (waiting && !waiting.dream) await stop('replaced');
    }
    if (revision !== generation || ended) return;
    if (active) { respond(text('Already working on the saved task.', 'Já estou trabalhando na tarefa salva.')); return; }
    const current = store.read(), saved = resumeSaved(current, options);
    if (!saved || saved.status === 'complete') {
      setWaitingForRequest(Boolean(planner));
      survival.state.paused = Boolean(planner); delete survival.state.idleBlocked; delete survival.state.deathBlocked; saveSurvival();
      respond(planner ? text('Waiting for your next request. I am still watching for danger.', 'Aguardando seu próximo pedido. Continuo atento a perigos.') : text("I'm back! I'll look after myself while I wait for your next task.", 'Voltei! Vou cuidar de mim enquanto aguardo sua próxima tarefa.')); return;
    }
    delete saved.waitingOn;
    saved.helpEpoch = (saved.helpEpoch || 0) + 1;
    delete saved.helpReason;
    if (saved.kind === 'build' && !saved.design) saved.designAttempts = 0;
    if (saved !== current) {
      const message = text(`Back to your earlier task: ${saved.request}.`, `Voltando à sua tarefa anterior: ${saved.request}.`);
      if (options?.automatic) announce(bot, message, 'important'); else respond(message);
    }
    launch(saved);
  }
  // The flight recording: what the bot sees and decides, for the audits.
  observation = recorder?.attach(bot, {
    server: `${config.host}:${config.port}`,
    getGoal: () => active?.goal || store.read() || {},
  });

  // One open question per player, answered within a minute and a half or
  // not at all.
  const clarifying = new Map();

  // A build parked on a block someone else put on its site is taken up
  // again by itself once that block is gone (siteChanged in work.js).
  let waitCheckedAt = 0;
  const idleTimer = setInterval(() => {
    companion.tick();
    if (planner) {
      reactiveWait.tick().catch(error => console.error('[reactive wait]', error.name));
      return;
    }
    const now = Date.now();
    if (ready && !pendingRequests && !launchingDream && (!active || active.idle) && now - waitCheckedAt > 5000) {
      waitCheckedAt = now;
      const saved = resumeSaved(store.read());
      if (waitingCleared(bot, saved)) {
        announce(bot, text(`The ${String(saved.waitingOn.name).replaceAll('_', ' ')} is gone. Back to building!`, `${displayName(saved.waitingOn.name, bot)} saiu do caminho. Voltando à construção!`), 'important');
        resume(generation, { automatic: true }).catch(err => console.error(err));
        return;
      }
    }
    if (ready && !active && !relaunching && !launchingDream && !pendingRequests && !survival.state.paused && !survival.state.idleBlocked) launchIdle();
  }, 500);

  bot._client.on('playerChat', data => {
    if (ended) return;
    const player = Object.values(bot.players).find(p => p.uuid === data.sender);
    if (!player || player.username === bot.username || typeof data.plainMessage !== 'string') return;
    const from = player.username;
    let request = data.plainMessage;
    companion.heard();
    const reply = message => companion.sayTo(from, message);
    const communicationCommand = communication.handleCommand(request, { from, username: bot.username, players: bot.players });
    if (communicationCommand?.handled) { companion.received(from, request); if (communicationCommand.message) reply(communicationCommand.message); return; }
    const chatCommand = chatPolicy?.handleCommand(request, { from, username: bot.username, players: bot.players, language: bot._jevLanguage });
    if (chatCommand?.handled) { companion.received(from, request); if (chatCommand.message) reply(chatCommand.message); return; }
    const memoryCommand = request.trim().match(/^!jev memory(?: (clear))?$/i);
    if (memoryCommand) {
      if (memoryCommand[1]) {
        memory.forget(from, 'all'); companion.memory.forget(from); companion.dialogue.clear(from); clarifying.delete(from);
        reply(text('I cleared your saved conversation and notes for this world.', 'Apaguei sua conversa e suas notas salvas para este mundo.'));
      } else {
        const context = companion.memory.context(from);
        reply(text(`I remember ${context.recentMessages.length} recent messages, ${context.recentTasks.length} tasks, and your saved notes for this world.`,
          `Lembro de ${context.recentMessages.length} mensagens recentes, ${context.recentTasks.length} tarefas e suas notas salvas neste mundo.`));
      }
      return;
    }
    let literal;
    try { literal = requestedCommand(request, bot.username); }
    catch (err) { console.error(err); reply(text('I could not use that command. Please check what you asked me to do.', 'Não consegui usar esse comando. Confira o que você pediu.')); return; }
    let address = parseAddress(request, bot.username);
    // Acknowledgements from other bots must never start new work. New goals
    // require an explicit name; short controls remain convenient when unprefixed.
    const me = String(bot.username || config.username || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const controlEnd = `(,? (now|please|agora|por favor|${me}))*[.!?]?$`;
    const control = new RegExp(`^(stop|cancel|resume|status|pare|parar|cancele|cancelar|retome|retomar|continue)${controlEnd}`, 'i');
    // The answer to a question Jev just asked. "Did you mean short grass or
    // grass block?" got "grass block" back, with no name in front, and the
    // gate dropped it; "Jev grass block" started a new request that had lost
    // the count and the recipient. The reply is read together with the
    // request it answers.
    const known = text => { const name = text.toLowerCase().replace(/\s+/g, '_'); return !!(bot.registry?.itemsByName?.[name] || bot.registry?.blocksByName?.[name] || bot.registry?.entitiesByName?.[name]); };
    const dialogueReply = !literal && !control.test(address.text) && companion.reply(from, address.text, address.explicit);
    if (address.explicit && !dialogueReply) companion.dialogue.clear(from);
    if (dialogueReply && !['clarify', 'request'].includes(dialogueReply.action)) {
      companion.received(from, request);
      if (dialogueReply.action !== 'acknowledge') clarifying.delete(from);
      if (dialogueReply.action === 'resume') {
        if (ready) { invalidateRequests(); companion.clearQuestions(); resume(generation, { from }).catch(console.error); }
        else reply(text('Still loading. Please ask me to resume in a moment.', 'Ainda estou carregando. Peça para retomar daqui a pouco.'));
      } else if (dialogueReply.action === 'cancel') {
        if (dialogueReply.question.kind === 'help') {
          invalidateRequests(); companion.clearQuestions(); stop().catch(console.error);
          reply(text('Okay, I stopped the task. I will still watch for danger.', 'Certo, parei a tarefa. Continuo atento a perigos.'));
        } else reply(text('Okay, I dropped that question.', 'Certo, deixei essa pergunta de lado.'));
      } else if (dialogueReply.action === 'defer') {
        reply(text('Okay, we can come back to this later.', 'Certo, podemos voltar a isso depois.'));
      } else reply(text('Thanks. Say "resume" when you are ready.', 'Obrigado. Diga "resume" quando estiver pronto.'));
      return;
    }
    const answer = dialogueReply?.request || (!literal && !control.test(address.text) && clarificationReply(clarifying.get(from), address, { known }));
    // A new addressed message moves on from the question either way.
    if (answer || address.explicit) clarifying.delete(from);
    if (answer) {
      request = `${bot.username} ${answer}`;
      address = parseAddress(request, bot.username);
    }
    const chatAccepted = chatPolicy ? chatPolicy.accept({ from, username: bot.username, players: bot.players,
      addressed: address.explicit, control: control.test(address.text), clarification: Boolean(answer) })
      : address.explicit || control.test(address.text);
    if (!chatAccepted) return;
    companion.received(from, data.plainMessage);
    // Stop has a synchronous fast path, even while a network request is pending.
    const normalized = address.text;
    const note = normalized.match(/^(?:remember(?: this| that)?|lembre(?:-se)?(?: disso| que)?|lembra(?: que)?|anote)(?:\s*:\s*|\s+)(.{1,256})$/i);
    if (note && !literal) {
      memory.rememberNote(from, note[1]);
      reply(text('I will remember that for this world.', 'Vou me lembrar disso neste mundo.'));
      return;
    }
    const stopping = new RegExp(`^(stop|cancel|pare|parar|cancele|cancelar)${controlEnd}`, 'i').test(normalized);
    const resuming = new RegExp(`^(resume|retome|retomar|continue)${controlEnd}`, 'i').test(normalized);
    // "Stop!" between two players is not addressed to the bot. Unprefixed,
    // it counts from whoever gave the work in hand, or when nobody else is
    // here to be talking to; it froze the bot, self-care included, in the
    // middle of other people's conversations.
    const owner = (active?.goal || store.read())?.from;
    const company = Object.values(bot.players).filter(p => p.username !== bot.username && p.username !== from).length;
    // "Stop Jev", with the name last, is as addressed as "Jev stop".
    const named = chatNames(bot.username || config.username).some(name => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(address.text));
    if ((stopping || resuming) && !address.explicit && !named && owner !== from && company > 0) return;
    if (stopping) {
      companion.clearQuestions(); clarifying.clear();
      invalidateRequests();
      stop().catch(console.error);
      reply(planner ? text('I stopped the task; I will still defend myself. Say "Jev resume" to continue.', 'Parei a tarefa; continuo me defendendo. Diga "Jev resume" para continuar.') : text('Stopped. I saved our progress. Say "Jev resume" to keep going.', 'Parei e salvei nosso progresso. Diga "Jev resume" para continuar.'));
      return;
    }
    if (!ready) { reply(text('Still loading the world; please repeat the request in a moment. Stop is available now.', 'Ainda estou carregando o mundo; repita o pedido daqui a pouco. Você já pode usar stop.')); return; }
    // A literal status request reads local state immediately, even while a
    // previous natural-language request is waiting for a model response.
    if (new RegExp(`^status${controlEnd}`, 'i').test(normalized)) {
      reply(statusMessage(bot, active, store.read())); return;
    }
    if (resuming) {
      companion.clearQuestions(); clarifying.clear();
      invalidateRequests();
      resume(generation, { from }).catch(console.error);
      return;
    }
    // Acknowledge instantly. Everything below can wait on the model, and a
    // motionless bot reads as "it did not hear me" rather than "it is thinking".
    bot.swingArm?.('right');
    const revision = generation;
    const requestPosition = { speakerPosition: position(bot.players[from]?.entity?.position), botPosition: position(bot.entity?.position), dimension: bot.game.dimension };
    // The request pays for its own understanding. One that turns out to
    // start no work folds that cost into the standing bucket instead.
    const run = ledger.open({ kind: 'request', name: request });
    const requestSignal = requestController.signal;
    const requestClient = withRun(withRequestSignal(client, requestSignal), run.id);
    let launched = false;
    pendingRequests++;
    pending = pending.then(async () => {
      if (revision !== generation || ended) return;
      // A catalog or list walk is several calls: look like it is thinking,
      // not like it did not hear. Not over work in hand: the glance turns the
      // head, and a dig in progress needs it where it is.
      const stopThinking = literal || active ? () => {} : thinking(bot);
      const inventory = {};
      for (const item of bot.inventory.items()) inventory[item.name] = (inventory[item.name] || 0) + item.count;
      const nearbyBlocks = [];
      if (planner && !literal) {
        try {
          const positions = bot.findBlocks({ matching: block => /_(log|stem)$/.test(block.name), maxDistance: 16, count: 16 });
          for (const at of positions.slice(0, 16)) { const name = bot.blockAt(at)?.name; if (name && !nearbyBlocks.includes(name)) nearbyBlocks.push(name); }
        } catch (_) { /* no observed nearby wood */ }
      }
      const context = {
        registry: bot.registry, players: Object.keys(bot.players),
        ...requestPosition, memory: { ...memory.context(from), found: require('./exploration').foundEntries(world.known) },
        builds: builds.describe(bot, bot.entity.position, bot.game.dimension),
        continueBuilds: (request, candidates) => resolveBuildContinuation(requestClient, request, candidates,
          { speaker: requestPosition.speakerPosition }),
        inventory, gameMode: bot.game.gameMode, dimension: bot.game.dimension, language: bot._jevLanguage,
        activeGoal: active && !active.idle ? active.goal : store.read(), nearbyBlocks,
        ...companion.context(from),
      };
      const spec = literal ? { kind: 'operator_command' } : await (planner
        ? planner.interpret(request, from, bot.username, context, { signal: requestSignal })
        : interpret(requestClient, request, from, bot.username, context)).finally(stopThinking);
      // What Jev made of the request is the first thing worth seeing about
      // it, whether or not any work follows.
      if (spec && !literal) {
        observation?.sample(spec.kind === 'clarify' ? 'clarify' : 'request', { request, from, kind: spec.kind, message: spec.message,
          clarification: spec.clarification, interpretation: spec.interpretation, itemResolution: spec.itemResolution,
          discoveryResolution: spec.discoveryResolution, buildContinuation: spec.buildContinuation, usage: spec.usage, latencyMs: spec.latencyMs });
      }
      if (!spec || revision !== generation || ended || requestSignal.aborted) return;
      if (planner && !literal) {
        if (!['obtain', 'craft', 'other', 'clarify'].includes(spec.kind) || typeof spec.message !== 'string' ||
          !spec.message.trim() || spec.message.length > 200 || /[\u0000-\u001f\u007f\u2028\u2029]/.test(spec.message) || spec.message.trimStart().startsWith('/') ||
          (['obtain', 'craft'].includes(spec.kind) && (!Object.hasOwn(bot.registry.itemsByName, spec.item) || !Number.isSafeInteger(spec.count) || spec.count < 1 || spec.count > 1024 || typeof spec.deliver !== 'boolean'))) {
          throw new Error('The planner returned an invalid single-goal response.');
        }
      }
      if (spec.kind === 'operator_command') {
        const allowed = (process.env.MC_COMMAND_USERS || '').split(',').map(name => name.trim().toLowerCase());
        if (!allowed.includes(from.toLowerCase())) { reply(text(`${from} is not enabled for Jev's operator commands`, `${from} não tem permissão para pedir comandos de operador ao Jev`)); return; }
        const resolution = literal ? { command: literal } : await classifyCommand(requestClient, bot, request, from);
        if (revision !== generation) return;
        const command = commandAccess.accept(data, { resolvedCommand: resolution.command, interpretation: { routing: spec.interpretation, command: resolution.judgments } });
        if (!command) return;
        // A command is an aside, not a change of plan. Setting the time or the
        // game mode used to abandon whatever Jev was building and leave it
        // waiting to be asked again, which is not what "also do this" means.
        // Anything the command does to the world - a teleport, a mode change -
        // the goal already copes with, because the world changes anyway.
        const feedback = [];
        const collect = (message, position, original, sender) => {
          if (position === 'system' && sender == null && feedback.length < 4) feedback.push(message);
        };
        bot.on('messagestr', collect);
        try {
          reply(text(`Running your command once: ${command.command}`, `Executando seu comando uma vez: ${command.command}`));
          command.dispatch();
          await new Promise(resolve => setTimeout(resolve, 1000));
        } finally { bot.removeListener('messagestr', collect); }
        for (const feedbackMessage of feedback) reply(text(`Command response: ${feedbackMessage}`, `Resposta do comando: ${feedbackMessage}`));
        return;
      }
      if (spec.kind === 'status') {
        reply(statusMessage(bot, active, store.read()));
        return;
      }
      if (spec.kind === 'other') {
        reply(planner ? spec.message : text('Ask for items or a full set, a biome or creature to find, someone to follow, or a structure to build.', 'Peça itens ou um conjunto completo, um bioma ou criatura para encontrar, alguém para seguir ou uma estrutura para construir.'));
        return;
      }
      if (spec.kind === 'memory') {
        reply(memory.handle(spec, { world: world.known, bot }));
        if (active?.goal.from === from) active.goal.memoryContext = memory.context(from);
        observation?.sample('memory', { operation: spec.memory.operation });
        return;
      }
      if (spec.kind === 'dream') {
        const standing = dreamStore.read() || {};
        const { operation, key } = spec.dream;
        const title = standing.dream ? dreamTitle(standing) : null;
        if (operation === 'set_custom') {
          // The text routes as a request; a survival route may still not exist for it.
          const impossible = unworkable(bot, spec.dream.probe);
          if (impossible) { reply(text(`I can't keep that as a dream. ${friendlyProblem(impossible, { bot })}`, `Não posso guardar isso como sonho. ${friendlyProblem(impossible, { bot })}`)); return; }
        }
        if (operation === 'query') {
          reply(reportDream(standing, store.read()));
        } else if (operation === 'clear') {
          if (standing.ledgerRun) ledger.close(standing.ledgerRun, 'cleared');
          saveDream({ dream: null, clearedBy: from, clearedAt: new Date().toISOString() });
          if (active && !active.idle && active.goal.dream) await stop('cancelled');
          reply(text('Okay, no dream for now. I\'ll just look after myself between requests.', 'Certo, sem sonho por enquanto. Vou apenas cuidar de mim entre os pedidos.'));
        } else if (operation === 'pause') {
          if (!standing.dream) reply(text("I don't have a dream to set aside.", 'Não tenho um sonho para deixar de lado.'));
          else {
            saveDream({ ...standing, paused: true, pausedBy: from, pausedAt: new Date().toISOString() });
            if (active && !active.idle && active.goal.dream) await stop('interrupted');
            reply(text(`Okay, I'll set my dream aside for now. Say "chase your dream" when you want me back on it.`, 'Certo, vou deixar meu sonho de lado por enquanto. Diga "chase your dream" quando quiser que eu continue.'));
          }
        } else if (operation === 'resume') {
          if (!standing.dream) reply(reportDream(null));
          else {
            // Chasing a satisfied dream again is a new run; picking up a paused one is not.
            // A custom dream begins afresh from a resume: its earlier finish or failures are behind it.
            const fresh = standing.dream === 'custom' && (standing.satisfiedAt || standing.paused) ? { setAt: new Date().toISOString(), failures: undefined, countedGoal: undefined } : {};
            saveDream({ ...standing, ...fresh, paused: false, satisfiedAt: undefined, resumedBy: from, resumedAt: new Date().toISOString(),
              ledgerRun: standing.satisfiedAt || !standing.ledgerRun ? ledger.open({ kind: 'dream', name: dreamName(standing.dream, standing.text) }).id : standing.ledgerRun });
            // A stop paused the survival loop with everything else; taking the
            // dream up again takes that up too, or nothing would run it.
            survival.state.paused = false; saveSurvival();
            reply(text(`Back to my dream: to ${title}.`, `Voltando ao meu sonho: ${localizedDreamTitle(standing)}.`));
            const saved = store.read();
            if (saved?.dream && (standing.dream !== 'custom' || saved.dream === 'custom') && ['interrupted', 'cancelled', 'blocked'].includes(saved.status) && !active) {
              if (standing.dream === 'custom') saved.dreamSetAt = fresh.setAt ?? standing.setAt;
              launch(saved);
            }
          }
        } else {
          if (standing.ledgerRun && !standing.satisfiedAt) ledger.close(standing.ledgerRun, 'replaced');
          const text = spec.dream.text;
          saveDream({ dream: key, ...(key === 'custom' && { text }), setBy: from, setAt: new Date().toISOString(), ledgerRun: ledger.open({ kind: 'dream', name: dreamName(key, text) }).id });
          reply(key === 'custom' ? localize(bot, `Got it. My dream is to ${text}. I'll do it once, whenever nothing else needs me.`, `Entendido. Meu sonho é ${text}. Vou realizá-lo uma vez quando estiver livre.`)
            : localize(bot, `Got it. My dream is to ${DREAMS[key].title}. I'll chase it whenever nothing else needs me.`, `Entendido. Meu sonho é ${localizedDreamTitle({ dream: key })}. Vou segui-lo quando estiver livre.`));
        }
        observation?.sample('dream', { operation, key, standing: dreamStore.read() });
        return;
      }
      if (spec.kind === 'clarify') {
        const reason = spec.clarification?.reason;
        clarifying.set(from, { request: address.text, options: spec.clarification?.options, until: Date.now() + CLARIFY_MS,
          confirm: ['uncertain_interaction', 'dream_unsure'].includes(reason), which: ['no_item', 'no_discovery_target', 'ambiguous_item', 'incomplete_bundle'].includes(reason) });
        companion.clarify(from, spec, address.text); return;
      }
      if (spec.kind === 'stop') { invalidateRequests(); await stop(); reply(text('Stopped.', 'Parei.')); return; }
      if (spec.kind === 'resume') {
        await resume(revision, { from }); return;
      }
      // In Creative with the generative designer, a plain house is drawn like
      // any other building rather than taken from the built-in catalog.
      if (spec.kind === 'house' && designerAvailable(bot)) spec.kind = 'build';
      // Work no survival route can do is refused here, before it replaces
      // work that can be done. "Get me bedrock" stopped a build, then was
      // parked as impossible, and the build had to be dug out with resume.
      const impossible = unworkable(bot, spec);
      if (impossible) { reply(`${friendlyProblem(impossible, { bot })}${active && !active.idle ? text(" I'll carry on with what I was doing.", ' Vou continuar o que estava fazendo.') : ''}`); return; }
      await stop('replaced');
      if (revision !== generation || ended) return;
      const goal = { ...spec, ledgerRun: run.id, version: 1, status: 'pending', createdAt: new Date().toISOString(),
        suspendedTasks: suspendPrevious(store.read()),
        requesterPosition: bot.players[from]?.entity ? { ...bot.players[from].entity.position } : null,
        initialInventory: bot.inventory.items().map(i => ({ name: i.name, count: i.count })) };
      saveGoal(goal);
      const changing = spec.kind === 'build' && spec.buildContinuation?.name &&
        { edit: text(`I'll work out what to change about ${spec.buildContinuation.name}.`, `Vou planejar as alterações em ${spec.buildContinuation.name}.`),
          finish: text(`I'll carry on with ${spec.buildContinuation.name}.`, `Vou continuar ${spec.buildContinuation.name}.`),
          repair: text(`I'll look ${spec.buildContinuation.name} over and put right what is missing.`, `Vou conferir ${spec.buildContinuation.name} e reparar o que estiver faltando.`),
        }[spec.buildContinuation.mode];
      reply(planner ? spec.message : changing ? changing :
        spec.kind === 'build' ? text("I'll make a plan, find a good spot, and build it for you.", 'Vou planejar, encontrar um bom lugar e construir para você.') :
        spec.kind === 'bundle' ? text(`Working on the whole list: ${bundleSummary(spec)}.`, `Vou cuidar de toda a lista: ${(spec.tasks || []).map(t => `${t.count} ${displayName(t.item, bot)}`).join(', ')}.`) :
        spec.kind === 'find' ? text(`I will look for ${spec.discoveryTarget.name.replaceAll('_', ' ')} and tell you where I find it.`, `Vou procurar ${displayName(spec.discoveryTarget.name, bot)} e avisar onde encontrar.`) :
        spec.kind === 'house' ? text(`Building a small ${spec.material} house with a floor, doorway and roof.`, `Vou construir uma pequena casa de ${displayName(spec.material, bot)}, com piso, entrada e telhado.`) :
        ['obtain', 'craft'].includes(spec.kind) ? text(`I'll get ${spec.count} ${spec.item.replaceAll('_', ' ')}${spec.deliver ? ` for ${from}` : ''}.`, `Vou conseguir ${spec.count} ${displayName(spec.item, bot)}${spec.deliver ? ` para ${from}` : ''}.`) :
        spec.kind === 'visit' ? text(`I'll head to ${spec.destination.label}.`, `Vou até ${spec.destination.label}.`) :
        spec.kind === 'come' ? text(`Coming to ${spec.target}.`, `Indo até ${spec.target}.`) : spec.kind === 'follow' ? text(`Following ${spec.target}; say Jev stop to stop.`, `Vou seguir ${spec.target}; diga Jev stop para parar.`) :
        spec.kind === 'win' ? text("Let's beat the dragon! I'll gather supplies and take it one step at a time.", 'Vamos derrotar o dragão! Vou reunir os recursos e avançar uma etapa por vez.') :
        text("I'll get a Nether portal working, then go through to check it.", 'Vou ativar um portal do Nether e atravessar para conferir.'));
      launch(goal); launched = true;
    }).catch(err => { console.error(err); if (!ended && revision === generation) reply(intakeProblem(err, bot)); }).finally(() => { if (!launched) ledger.fold(run.id); pendingRequests--; });
  });

  bot.once('spawn', async () => {
    try {
      spawned = true;
      configureMovements(bot);
      console.log(`[bot] spawned as ${bot.username} (${bot.version})`);
      // Put back in the boat it left in (boats.js leaveStrandedVehicle): the
      // seat comes a moment after the spawn, and no crossing is under way
      // this soon after joining.
      const joinedAt = Date.now();
      const seated = () => { if (!planner && Date.now() - joinedAt < 5000) require('./boats').leaveStrandedVehicle(bot).then(left => left && console.log('[bot] joined in a boat; got out'), err => console.log(`[bot] joined in a boat and could not get out: ${err.message}`)); };
      bot.once('mount', seated);
      if (bot.vehicle || bot._seatedIn != null) seated();
      // The seat can come by the raw packet alone (compatibility.js), with no mount event.
      bot._client.on('set_passengers', () => { if (bot._seatedIn != null && !bot.vehicle) seated(); });
      await bot.waitForChunksToLoad();
      if (ended || !bot.isAlive) return;
      // The ground about the bot read again before anything resumes: in
      // lava, out at once; in water beside lava, onto dry ground clear of it
      // (lava-escape.js settleAfterJoin, note 756). 25597 came back standing
      // in its poured water a block from lava, was asked the turn's question
      // while the flow carried it in, and died there.
      try { if (!planner) await require('./lava-escape').settleAfterJoin(bot, survival); saveSurvival(); }
      catch (err) { console.error('[join] reading the ground:', err.message); }
      if (ended || !bot.isAlive) return;
      ready = true;
      console.log(JSON.stringify({ sessionReady: true, username: bot.username }));
      if (planner) { announce(bot, text('Waiting for your request. I am still watching for danger. Say "Jev resume" to continue a saved task.', 'Aguardando seu pedido. Continuo atento a perigos. Diga "Jev resume" para continuar uma tarefa salva.')); return; }
      const saved = store.read();
      if (saved && ['running', 'recovering'].includes(saved.status) && !survival.state.paused) {
        announce(bot, survival.state.recovery?.status === 'pending' ? text("I'm back! I'll look for my dropped items, then carry on.", 'Voltei! Vou procurar meus itens perdidos e depois continuar.') : text("I'm back! I'll carry on where I left off.", 'Voltei! Vou continuar de onde parei.'));
        // What was tried, judged by its own clock: moved on by the time the
        // save lay unplayed (a restart, a trial begun from a stage's save).
        require('./tried').resumed(saved, { savedAt: Date.parse(saved.updatedAt) });
        launch(saved);
      } else announce(bot, text('Call me Jev: "Jev come here", "Jev follow me", "Jev craft a chest", or "Jev get me 8 birch stairs".', 'Me chame de Jev: "Jev venha aqui", "Jev me siga", "Jev faça um baú" ou "Jev consiga 8 escadas de bétula".'));
    } catch (err) { console.error('[bot] spawn:', err); bot.quit('Could not initialize the world'); }
  });
  // The game's death message for this bot, kept for the death record: the
  // cause said in the game's words ("was shot by Skeleton").
  bot.on('messagestr', text => {
    const name = bot.username;
    if (name && typeof text === 'string' && text.startsWith(`${name} `) && DEATH_WORDS.test(text.slice(name.length + 1))) {
      bot._deathMessage = { text: text.slice(name.length + 1), at: Date.now() };
      const last = (survival.state.deaths || []).at(-1);
      if (last && !last.cause && Date.now() - Date.parse(last.at) < 5000) last.cause = bot._deathMessage.text;
    }
  });
  bot.on('death', () => {
    companion.death(); clarifying.clear();
    ready = false; invalidateRequests();
    // A dead player can rejoin before respawning. No work has started in this
    // connection, so request respawn directly without recording a second death.
    if (!spawned && survival.state.recovery?.status === 'pending') { bot.respawn(); return; }
    const saved = active && !active.idle ? active.goal : store.read();
    recordDeath(bot, survival.state);
    if (saved && ['pending', 'running', 'recovering'].includes(saved.status)) {
      saved.lastError = 'The bot died; recovering from observed inventory after respawn';
      saved.status = 'recovering';
      saveGoal(saved);
    }
    saveSurvival();
    console.log(JSON.stringify({ death: survival.state.recovery }));
    if (!spawned) { bot.respawn(); return; }
    // Reconnect to discard all old inventory/window promises before respawning.
    // They must not issue a late action against the new life's inventory.
    stop('recovering').catch(console.error);
    bot.quit('Respawning after death');
  });
  function close(reason) {
    if (ended) return;
    if (planner) setWaitingForRequest(true);
    observation?.detach(String(reason || 'connection closed'));
    ready = false; clearInterval(idleTimer); invalidateRequests();
    reactiveWait?.cancel().catch(() => {});
    if (active && !active.task.cancelled) stop('running').catch(console.error);
    // Fence late saves from this connection before a replacement reads state.
    ended = true;
    memory.flush();
    companion.close();
    resolveClosed({ reason, spawned, uptimeMs: Date.now() - connectedAt });
  }
  bot.on('end', reason => close(reason));
  bot.on('kicked', reason => console.error('[bot] kicked:', reason));
  bot.on('error', err => console.error('[bot]', err.message));
  return { bot, closed, companion, shutdown() { close('shutdown'); bot.quit('Shutting down'); } };
}

module.exports = { unworkable, createSession };
