'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const ops = require('../lib/trial-ops');
function files(dir) { return ops.entries(dir).flatMap(entry => { const file = path.join(dir, entry.name); return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : []; }); }
function removeRecordings(root, hours, now) {
  for (const server of ops.serverDirs(root)) { const dir = ops.safePath(server, path.join(server, 'recordings')); for (const file of files(dir)) if (now - fs.statSync(file).mtimeMs > hours * 3600000) ops.safeRemove(dir, file);
    function empty(parent, depth = 0) { for (const e of ops.entries(parent)) if (e.isDirectory()) empty(path.join(parent, e.name), depth + 1); if (depth >= 3 && !ops.entries(parent).length) ops.safeRemove(dir, parent); } empty(dir);
  }
}
// Readers never rewrite a file held by an appending writer. An active file
// stays in place; each gzip stores only bytes since its last saved offset.
// This protects records, but reclaiming active-file space requires restarting
// its writer or a cooperative rotation protocol. No silent copy-and-truncate.
async function snapshot(file, { root, now, offsets }) {
  const before = fs.statSync(file), key = path.relative(root, file), prior = offsets[key];
  const from = prior && prior.ino === String(before.ino) && prior.dev === String(before.dev) && prior.offset <= before.size ? prior.offset : 0;
  if (from === before.size) return null;
  const ext = path.extname(file), output = `${file.slice(0, -ext.length)}.part-${ops.utc(now)}-${from}-${before.size}${ext}.gz`, temp = `${output}.tmp`;
  ops.safePath(root, output);
  try { await pipeline(fs.createReadStream(file, { start: from, end: before.size - 1 }), zlib.createGzip(), fs.createWriteStream(temp, { flags: 'wx' })); fs.renameSync(temp, output); }
  catch (error) { fs.rmSync(temp, { force: true }); throw error; }
  offsets[key] = { ino: String(before.ino), dev: String(before.dev), offset: before.size };
  return output;
}
async function inactiveLog(file, options) {
  const { root, now, offsets } = options, before = fs.statSync(file), output = `${file}.gz`, temp = `${output}.tmp`;
  if (fs.existsSync(output)) return snapshot(file, options); // Do not replace an earlier archive.
  try { await pipeline(fs.createReadStream(file, { end: before.size - 1 }), zlib.createGzip(), fs.createWriteStream(temp, { flags: 'wx' }));
    const after = fs.statSync(file); fs.renameSync(temp, output);
    if (before.size === after.size && before.mtimeMs === after.mtimeMs && !await options.active(file)) { ops.safeRemove(path.join(root, 'artifacts'), file); delete offsets[path.relative(root, file)]; }
    else offsets[path.relative(root, file)] = { ino: String(before.ino), dev: String(before.dev), offset: before.size };
  } catch (error) { fs.rmSync(temp, { force: true }); throw error; }
  return output;
}
async function janitor(options = {}) {
  const { root = ops.ROOT, now = Date.now(), freeGb = ops.freeGb, say = console.log, liveLogBytes = 500 * 1024 ** 2, oldLogBytes = 1024 ** 2, missingLogBytes = 300 * 1024 ** 2 } = options;
  const platform = require('../lib/platform');
  const artifacts = ops.safePath(root, path.join(root, 'artifacts')); fs.mkdirSync(artifacts, { recursive: true });
  const offsetFile = ops.safePath(artifacts, path.join(artifacts, '.janitor-offsets.json')); let offsets; try { offsets = JSON.parse(ops.read(offsetFile, '{}')); } catch { throw new Error(`invalid janitor offset state: ${offsetFile}`); }
  const dirs = ops.serverDirs(root), running = dirs.map(dir => ops.properties(dir)['level-name']).filter(Boolean);
  const active = options.active || (async file => {
    const world = path.basename(file).replace(/^midgame-/, '').replace(/\.log$/, '');
    for (const dir of dirs) { const props = ops.properties(dir); if (props['level-name'] !== world) continue; const p = props['server-port']; const pid = Number(ops.read(path.join(root, `.bot-state/pids/127.0.0.1-${p}-Jev.pid`)).trim()); if (pid && platform.isAlive(pid) || p && await platform.listenerPid(Number(p))) return true; }
    return false;
  });
  const snapshots = []; removeRecordings(root, 8, now);
  for (const entry of ops.entries(artifacts)) {
    if (!entry.isFile() || !/^midgame-.*\.log$/.test(entry.name)) continue;
    const file = ops.safePath(artifacts, path.join(artifacts, entry.name)), stat = fs.statSync(file), old = now - stat.mtimeMs > 3 * 3600000;
    let output;
    if (old && stat.size > oldLogBytes && !await active(file)) output = await inactiveLog(file, { root, now, offsets, active });
    else if (stat.size > liveLogBytes) output = await snapshot(file, { root, now, offsets });
    if (output) snapshots.push(output);
  }
  const missing = ops.safePath(artifacts, path.join(artifacts, 'missing-options.jsonl'));
  if (fs.existsSync(missing) && fs.statSync(missing).size > missingLogBytes) { const output = await snapshot(missing, { root, now, offsets }); if (output) snapshots.push(output); }
  ops.write(offsetFile, `${JSON.stringify(offsets, null, 2)}\n`);
  const base = ops.safePath(root, path.join(root, '.trial-checkpoints'));
  for (const e of ops.entries(base)) if (e.isDirectory() && e.name.startsWith('mid-') && !running.includes(e.name)) { const dir = ops.safePath(base, path.join(base, e.name)); if (now - fs.statSync(dir).mtimeMs > 12 * 3600000) ops.safeRemove(base, dir); }
  const free = freeGb(root); say(`${new Date(now).toISOString()} free ${free.toFixed(1)}G`);
  if (free < 12) { removeRecordings(root, 2, now); say('low disk: recordings older than 2h removed'); }
  if (free < 6) { removeRecordings(root, 1, now); say('very low disk: recordings older than 1h removed'); }
  if (snapshots.length) say('Log archives saved; active originals are retained until their writers stop.');
  return { freeGb: free, snapshots };
}
async function main(argv = process.argv.slice(2), options = {}) { if (ops.help(argv, 'janitor.js [--once] (single maintenance pass; safe to schedule every 20 minutes)')) return; return janitor(options); }
if (require.main === module) ops.cli(main);
module.exports = { files, removeRecordings, snapshot, janitor, main };
