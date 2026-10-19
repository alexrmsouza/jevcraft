'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { listenerPid, isAlive, stopProcess, readProperties, serverDirectory, supervisorFile } = require('../lib/platform');
const ROOT = path.join(__dirname, '../..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function acquireSupervisor(port, { root = ROOT } = {}) {
  const file = supervisorFile(root, port), lock = file.replace(/\.json$/, '.lock'), recovery = `${lock}.recover`;
  const owner = { pid: process.pid, token: randomUUID(), port: Number(port), startedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = target => { try { return JSON.parse(fs.readFileSync(target, 'utf8')); } catch (_) { return null; } };
  const create = target => fs.writeFileSync(target, JSON.stringify(owner), { flag: 'wx' });
  const removeMine = target => { if (record(target)?.token === owner.token) fs.rmSync(target, { force: true }); };
  const busy = () => new Error(`A supervisor is already watching or already starting on ${port}`);
  try { create(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = record(lock);
    // An empty/partial lock can belong to a process still writing its PID.
    if (!prior?.pid || isAlive(prior.pid)) throw busy();
    try { create(recovery); }
    catch (recoveryError) {
      if (recoveryError.code === 'EEXIST') throw new Error(`A supervisor is already starting on ${port}; recovery guard exists at ${recovery}. If its owner crashed, remove that guard after verifying its PID is no longer alive.`);
      throw recoveryError;
    }
    try {
      // Re-read under the recovery guard so concurrent stale-lock cleaners
      // cannot delete a replacement lock acquired by another live process.
      const current = record(lock);
      if (current && (!current.pid || isAlive(current.pid))) throw busy();
      if (fs.existsSync(lock)) fs.rmSync(lock);
      create(lock);
    } finally { removeMine(recovery); }
  }
  try {
    const registered = record(file);
    if (registered?.pid && isAlive(registered.pid)) throw busy();
    fs.writeFileSync(file, JSON.stringify(owner));
  } catch (error) { removeMine(lock); throw error; }
  return () => { removeMine(file); removeMine(lock); };
}

async function tick(port, { root = ROOT, listening = listenerPid, alive = isAlive, stop = stopProcess, now = Date.now, sleep: pause = sleep, launch = require('../lib/arms').launch, say = console.log } = {}) {
  const state = path.join(root, '.bot-state'), pidFile = path.join(state, 'pids', `127.0.0.1-${port}-Jev.pid`);
  if (fs.existsSync(pidFile.replace(/\.pid$/, '.starting'))) return 'starting';
  if (!listening(port)) return 'server-down';
  let world;
  try { world = readProperties(path.join(serverDirectory(root, port), 'server.properties'))['level-name']; } catch (_) { return 'no-world'; }
  const out = ['midgame', 'first-days'].map(kind => path.join(root, 'artifacts', `${kind}-${world}.log`)).find(file => fs.existsSync(file));
  if (!out) return 'no-trial';
  let pid = null;
  try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch (_) {}
  if (pid && alive(pid)) {
    const flightDir = path.join(state, 'flight');
    let files = [];
    try { files = fs.readdirSync(flightDir).filter(f => f.startsWith(`127_0_0_1-${port}-Jev-`) && f.endsWith('.jsonl')).map(f => fs.statSync(path.join(flightDir, f)).mtimeMs); } catch (_) {}
    if (!files.length) return 'no-flight';
    const age = now() - Math.max(...files);
    if (age < 60000) return 'healthy';
    say(`[${port}] flight record quiet ${Math.floor(age / 1000)}s; restarting bot ${pid}`);
    stop(pid); await pause(5000);
    if (alive(pid)) stop(pid, { force: true });
  } else say(`[${port}] no bot; starting one`);
  const launched = launch(port, out, { root });
  say(`[${port}] started ${launched.child?.pid || ''}`);
  return 'restarted';
}
async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) { console.log('node scripts/trials/supervisor.js <port> [--once]\nKeeps a trial bot running and restarts it after 60 seconds without a flight frame.'); return; }
  const port = Number(argv[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('A port between 1 and 65535 is required');
  const clean = acquireSupervisor(port);
  process.once('exit', clean);
  process.once('SIGINT', () => process.exit(0)); process.once('SIGTERM', () => process.exit(0));
  try {
    do {
      if (!argv.includes('--once')) await sleep(15000);
      try { const result = await tick(port); if (result === 'restarted' && !argv.includes('--once')) await sleep(30000); }
      catch (error) { console.error(`[${port}] not started: ${error.message}`); if (!argv.includes('--once')) await sleep(30000); }
    } while (!argv.includes('--once'));
  } finally { clean(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { acquireSupervisor, tick, main };
