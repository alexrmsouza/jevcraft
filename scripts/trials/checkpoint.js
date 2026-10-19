'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ops = require('../lib/trial-ops');
const DEATH = / Jev (was|died|fell|drowned|blew|burned|hit the|tried|walked into|suffocated|experienced|went|froze|starved|withered|discovered)/;
function setting(env, key, fallback) { const n = Number(env[key] ?? fallback); if (!Number.isFinite(n) || n < 0 || ['CHECKPOINT_KEEP', 'DEATH_SNAPS'].includes(key) && (!Number.isInteger(n) || n < 1)) throw new Error(`${key} must be a ${key.endsWith('KEEP') || key.endsWith('SNAPS') ? 'positive integer' : 'nonnegative number'}`); return n; }
function config(env = process.env) { return { every: setting(env, 'CHECKPOINT_S', 30) * 1000, keep: setting(env, 'CHECKPOINT_KEEP', 10), deathSnaps: setting(env, 'DEATH_SNAPS', 3), deathHours: setting(env, 'DEATH_HOURS', 6), freeGb: setting(env, 'FREE_GB', 25) }; }
function directories(dir) { return ops.entries(dir).filter(entry => entry.isDirectory()).map(entry => path.join(dir, entry.name)); }
function prune(options = {}) {
  const { root = ops.ROOT, now = Date.now(), freeGb = ops.freeGb, say = console.log } = options;
  const cfg = { ...config(options.env), ...options.config }, base = ops.safePath(root, path.join(root, '.trial-checkpoints'));
  const deaths = path.join(base, 'deaths');
  for (const dir of directories(deaths)) if (now - fs.statSync(dir).mtimeMs > cfg.deathHours * 3600000) ops.safeRemove(deaths, dir);
  const oldest = directories(deaths).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  while (oldest.length && freeGb(root) < cfg.freeGb) { const dir = oldest.shift(); ops.safeRemove(deaths, dir); say(`${new Date(now).toISOString()} disk under ${cfg.freeGb} GB free: removed ${dir}`); }
}
function stageAllowed(world, milestone) {
  if (/-((nether)|(fortress)|(stronghold)|(dragon))-\d/.test(world) && milestone === 'nether') return false;
  if (/-(fortress|stronghold|dragon)-\d/.test(world) && !['stronghold', 'dragon'].includes(milestone)) return false;
  return !((/-stronghold-\d/.test(world) && milestone === 'stronghold') || (/-dragon-\d/.test(world) && milestone === 'dragon'));
}
async function scan(requested, options = {}) {
  const { root = ops.ROOT, now = Date.now(), pause = ops.pause, say = console.log } = options;
  const platform = require('../lib/platform'), { writeConsole = require('../lib/server').writeConsole, listenerPid = platform.listenerPid } = options;
  const cfg = { ...config(options.env), ...options.config }, run = ops.runner({ ...options, root });
  const base = ops.safePath(root, path.join(root, '.trial-checkpoints')); prune({ ...options, config: cfg, root, now });
  const result = [];
  for (const port of await ops.ports(requested, { ...options, root, prefix: 'mid-', listenerPid })) {
    if (options.signal?.aborted) break;
    const server = platform.serverDirectory(root, Number(port));
    if (!await listenerPid(Number(port)) || fs.existsSync(path.join(root, `.bot-state/pids/127.0.0.1-${port}-Jev.starting`))) continue;
    const world = ops.name(platform.readProperties(path.join(server, 'server.properties'))['level-name']);
    const worldDir = ops.safePath(server, path.join(server, world)); if (!fs.existsSync(worldDir)) continue;
    const own = ops.safePath(base, path.join(base, world)), ring = path.join(own, 'ring'), lastFile = path.join(base, `.port-${port}`), last = ops.read(lastFile).trim();
    if (last && last !== world) { const oldRing = ops.safePath(base, path.join(base, ops.name(last), 'ring')); if (fs.existsSync(oldRing)) ops.safeRemove(base, oldRing); }
    ops.write(lastFile, `${world}\n`);
    const deaths = ops.read(path.join(server, 'logs/latest.log')).split('\n').filter(line => DEATH.test(line)).length;
    const seenFile = path.join(own, 'deaths-seen'); let seen = Number(ops.read(seenFile, String(deaths))); if (deaths < seen) seen = 0;
    const at = ops.utc(now).slice(9, 15);
    if (deaths > seen && fs.existsSync(ring)) {
      const kept = ops.safePath(base, path.join(base, 'deaths', `${world}-${at}`)); fs.mkdirSync(kept, { recursive: true });
      for (const dir of directories(ring).sort().slice(-cfg.deathSnaps)) ops.copyTree(dir, path.join(kept, path.basename(dir)));
      say(`${new Date(now).toISOString()} death on ${world}: kept ${directories(kept).length} snapshots in ${kept}`);
    }
    ops.write(seenFile, `${deaths}\n`); writeConsole(server, 'save-all flush'); await pause(2000, options.signal); if (options.signal?.aborted) break;
    let dest = path.join(ring, at), suffix = 1; while (fs.existsSync(dest)) dest = path.join(ring, `${at}-${suffix++}`);
    ops.safePath(base, dest); fs.mkdirSync(path.join(dest, 'state'), { recursive: true });
    try {
      ops.copyTree(worldDir, path.join(dest, 'world')); ops.safeRemove(dest, path.join(dest, 'world/session.lock'));
      for (const file of ops.stateFiles(root, port)) ops.copyTree(file, path.join(dest, 'state', path.basename(file)));
    } catch (error) { ops.safeRemove(base, dest); throw error; }
    const milestones = (options.milestones ? await options.milestones(port) : await run('trials/milestone.js', [port])).trim().split(/\s+/).filter(Boolean);
    for (const milestone of milestones) {
      if (!['nether', 'fortress', 'stronghold', 'dragon'].includes(milestone) || !stageAllowed(world, milestone)) continue;
      const marker = path.join(own, `milestone-${milestone}`); if (fs.existsSync(marker)) continue;
      const stage = ops.safePath(base, path.join(base, 'stages', milestone, `${world}-${path.basename(dest)}`)); ops.copyTree(dest, stage); ops.write(marker, ''); say(`${world} reached ${milestone}: kept ${stage}`);
    }
    const snapshots = directories(ring).sort(); for (const old of snapshots.slice(0, Math.max(0, snapshots.length - cfg.keep))) ops.safeRemove(base, old);
    result.push(dest);
  }
  return result;
}
async function main(argv = process.argv.slice(2), options = {}) { if (ops.help(argv, 'checkpoint.js <port ...|auto> [--once] (CHECKPOINT_S=30 CHECKPOINT_KEEP=10 DEATH_SNAPS=3 DEATH_HOURS=6 FREE_GB=25)')) return; const parsed = ops.options(argv); if (!parsed.args.length) throw new Error('specify ports or auto'); return ops.loop(() => scan(parsed.args, options), { ...options, once: parsed.once, every: config(options.env).every }); }
if (require.main === module) ops.cli(main);
module.exports = { config, prune, stageAllowed, scan, main };
