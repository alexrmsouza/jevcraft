'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ops = require('../lib/trial-ops');
async function retry(kept, count = '3', options = {}) {
  const { root = ops.ROOT, env = process.env, say = console.log } = options, platform = require('../lib/platform'), run = ops.runner({ ...options, root });
  count = Number(count); const back = Number(env.BACK ?? 2);
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(back) || back < 1) throw new Error('count and BACK must be positive integers');
  if (!kept) throw new Error('kept death ring required');
  const ring = ops.safePath(root, path.resolve(root, kept)), snapshots = ops.entries(ring).filter(entry => entry.isDirectory()).map(entry => path.join(ring, entry.name)).sort();
  const snapshot = snapshots.slice(-back)[0]; if (!snapshot || !fs.existsSync(path.join(snapshot, 'world'))) throw new Error(`no snapshot in ${kept}`);
  const name = ops.name(path.basename(ring).replace(/^mid-/, '').replace(/-\d*$/, '')), result = [];
  for (let port = 25601; result.length < count && port <= 25620 && !options.signal?.aborted; port++) {
    const server = platform.serverDirectory(root, port); if (!fs.existsSync(server) || await (options.listenerPid || platform.listenerPid)(port)) continue;
    const world = `retry-${name}-${ops.name(path.basename(snapshot))}-${result.length + 1}`;
    ops.safeRemove(server, path.join(server, world));
    const output = await run('midgame.js', ['start', world, path.join(snapshot, 'world'), path.join(snapshot, 'state')], { MIDGAME_PORT: String(port) });
    if (output) say(output.split('\n').at(-1)); await (options.supervise || ops.supervise)(port, { root, env }); result.push({ port, world });
  }
  return result;
}
async function main(argv = process.argv.slice(2), options = {}) { if (ops.help(argv, 'retry.js <kept death ring> [count=3] (BACK=2)')) return; return retry(argv[0], argv[1], options); }
if (require.main === module) ops.cli(main);
module.exports = { retry, main };
