'use strict';
const path = require('node:path');
const ops = require('../lib/trial-ops');
function state(verdict) {
  const reasons = verdict.reasons || [], died = reasons.some(reason => /death/.test(reason));
  if (!verdict.done && !died) return 'running';
  if (died) return `died:${verdict.world}:${reasons.filter(reason => /death/.test(reason)).join(',')}`;
  return verdict.reachedAt && 'iron_pickaxe' in verdict.reachedAt ? 'promote' : `weak:${verdict.world}`;
}
function next(root) { return Math.max(0, ...JSON.parse(ops.read(path.join(root, 'artifacts/first-days-trials.json'), '[]')).map(trial => Number(trial.world.replace('first-days-', '')) || 0)) + 1; }
async function settle(options = {}) {
  const { root = ops.ROOT, say = console.log } = options, run = ops.runner({ ...options, root }), results = [];
  for (const dir of ops.serverDirs(root)) {
    const props = ops.properties(dir); if (!(props['level-name'] || '').startsWith('first-days-')) continue;
    const port = ops.port(props['server-port']); let verdict;
    try { verdict = JSON.parse(await run('first-days.js', ['verdict'], { FIRST_DAYS_PORT: port })); } catch (error) { (options.warn || console.error)(`settle ${port}: ${error.message}`); continue; }
    const status = state(verdict); if (status === 'running') continue;
    if (status === 'promote') await (options.promote || require('./promote').promote)(port, 'a', { ...options, root });
    else { say(`${port} ${status}`); const output = await run('first-days.js', ['start', `first-days-${next(root)}`], { FIRST_DAYS_PORT: port }); if (output) say(output.split('\n').at(-1)); }
    results.push({ port, state: status });
  }
  return results;
}
async function main(argv = process.argv.slice(2), options = {}) { if (ops.help(argv, 'settle.js [--once]')) return; return settle(options); }
if (require.main === module) ops.cli(main);
module.exports = { state, next, settle, main };
