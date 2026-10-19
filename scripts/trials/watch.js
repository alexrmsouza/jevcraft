'use strict';
const ops = require('../lib/trial-ops');
function needsAttention(verdict) { return !verdict.jevDownNow && Boolean(verdict.done || (verdict.reasons || []).some(reason => !/^(died|held) /.test(reason) && /death|loop|stranded|^cut: /.test(reason))); }
async function scan(requested, options = {}) {
  const { root = ops.ROOT, trial = process.env.TRIAL || 'midgame', say = console.log } = options;
  if (!['midgame', 'first-days'].includes(trial)) throw new Error('TRIAL must be midgame or first-days');
  const run = ops.runner({ ...options, root });
  for (const port of await ops.ports(requested, { ...options, root, prefix: trial === 'midgame' ? 'mid-' : 'first-days-' })) {
    if (options.signal?.aborted) break;
    let text; try { text = await run(`${trial}.js`, ['verdict'], { [trial === 'midgame' ? 'MIDGAME_PORT' : 'FIRST_DAYS_PORT']: port }); } catch (error) { if (options.signal?.aborted) break; (options.warn || console.error)(`watch ${port}: ${error.message}`); continue; }
    let verdict; try { verdict = JSON.parse(text); } catch { continue; }
    if (needsAttention(verdict)) { say(`attention on ${port}`); say(text.split('\n').slice(0, 30).join('\n')); return { port, verdict }; }
  }
  return null;
}
async function main(argv = process.argv.slice(2), options = {}) {
  if (ops.help(argv, 'watch.js <port ...|auto> [--once]')) return;
  const parsed = ops.options(argv); if (!parsed.args.length) throw new Error('specify ports or auto');
  return ops.loop(async () => await scan(parsed.args, options) ? false : undefined, { ...options, once: parsed.once, every: 60000 });
}
if (require.main === module) ops.cli(main);
module.exports = { needsAttention, scan, main };
