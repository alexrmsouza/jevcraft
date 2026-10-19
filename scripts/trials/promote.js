'use strict';
const ops = require('../lib/trial-ops');
function promotable(verdict) { return Boolean(verdict.done && !(verdict.reasons || []).some(reason => /death|^died /.test(reason))); }
async function promote(port, letter = 'a', options = {}) {
  port = ops.port(port); if (!/^[a-z]+$/.test(letter)) throw new Error('letter must contain lowercase letters');
  const { root = ops.ROOT, say = console.log } = options, run = ops.runner({ ...options, root });
  const verdict = JSON.parse(await run('first-days.js', ['verdict'], { FIRST_DAYS_PORT: port }));
  if (!promotable(verdict)) throw new Error(`not promotable: ${JSON.stringify({ done: verdict.done, reasons: verdict.reasons })}`);
  const harvested = await (options.harvest || require('./harvest').harvest)(port, { ...options, root });
  const n = harvested.source.split('first-days-').at(-1); if (!/^\d+$/.test(n)) throw new Error(`invalid first-days source: ${harvested.source}`);
  const world = `mid-${n}-${letter}`, output = await run('midgame.js', ['start', world, harvested.source, harvested.archive], { MIDGAME_PORT: port });
  if (output) say(output); return { world, ...harvested };
}
async function main(argv = process.argv.slice(2), options = {}) { if (ops.help(argv, 'promote.js <port> [letter]')) return; return promote(argv[0], argv[1], options); }
if (require.main === module) ops.cli(main);
module.exports = { promotable, promote, main };
