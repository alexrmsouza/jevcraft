'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ops = require('../lib/trial-ops');
const LETTERS = 'abcdefghijkmnpqrstuvwxyz'.split('');
async function startFresh(port, source, options = {}) {
  const { root = ops.ROOT, say = console.log, fallback } = options;
  port = ops.port(port); const run = ops.runner({ ...options, root, echoStderr: true });
  if (source === 'pair') {
    const owed = (await run('lib/arms.js', ['owed-fresh', port])).trim();
    if (owed) { source = owed; say(`pair: source ${owed} is owed by this port's arm`); }
    else if (fallback) { source = fallback; say(`pair: nothing owed; source ${fallback}`); }
    else throw new Error('pair: nothing owed and no fallback source; nothing started');
  }
  if (!/^\d+$/.test(source || '')) throw new Error('source number required');
  const src = `.trial-sources/first-days-${source}`, archiveFile = path.join(root, `${src}.archive`);
  if (!fs.existsSync(archiveFile)) throw new Error(`no source ${src}`);
  const archive = ops.read(archiveFile).trim();
  for (const a of LETTERS) for (const b of ['', ...LETTERS]) {
    const world = `mid-${source}-${a}${b}`;
    if (fs.existsSync(path.join(root, `artifacts/midgame/${world}.json`)) || ops.serverDirs(root).some(dir => fs.existsSync(path.join(dir, world)))) continue;
    const output = await run('midgame.js', ['start', world, src, archive], { MIDGAME_PORT: port });
    if (output) say(output); return { world, source: src, archive };
  }
  throw new Error(`no free name for ${source}`);
}
async function main(argv = process.argv.slice(2), options = {}) { if (ops.help(argv, 'start-fresh.js <port> <source number|pair> [fallback]')) return; return startFresh(argv[0], argv[1], { ...options, fallback: argv[2] }); }
if (require.main === module) ops.cli(main);
module.exports = { startFresh, main, LETTERS };
