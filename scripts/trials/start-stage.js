'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ops = require('../lib/trial-ops');
async function startStage(port, asked, options = {}) {
  port = ops.port(port); if (!['nether', 'fortress', 'stronghold', 'dragon'].includes(asked)) throw new Error('stage must be nether, fortress, stronghold or dragon');
  const { root = ops.ROOT, say = console.log, now = Date.now() } = options, platform = require('../lib/platform'), run = ops.runner({ ...options, root, echoStderr: true });
  const stages = ops.safePath(root, path.join(root, '.trial-checkpoints/stages'));
  if (!fs.existsSync(path.join(stages, asked))) throw new Error(`no ${asked} snapshots yet`);
  const arm = (await run('lib/arms.js', ['name', port])).trim(); if (!arm) throw new Error(`the arm of ${port} cannot carry a bot`);
  const pick = (await run('trials/stage-pick.js', [asked], { STAGE_PORT: port, STAGE_ARM: arm, JEV_ROOT: root })).split('\t');
  const [stage, picked] = pick; if (!['nether', 'fortress', 'stronghold', 'dragon'].includes(stage) || !picked) throw new Error(`no usable ${asked} snapshot`);
  const best = ops.safePath(stages, path.resolve(root, picked.trim()));
  if (!fs.existsSync(path.join(best, 'world')) || !fs.existsSync(path.join(best, 'state'))) throw new Error(`incomplete stage snapshot: ${best}`);
  const src = ops.name(path.basename(best).replace(/^mid-/, '').replace(/-\d{6}$/, ''));
  let k = Number(ops.read(path.join(best, 'started'), '0').trim()) + 1; if (!Number.isInteger(k) || k < 1) throw new Error(`invalid started count: ${best}`);
  const server = platform.serverDirectory(root, Number(port));
  while (fs.existsSync(path.join(root, `artifacts/midgame-mid-${src}-${stage}-${k}.log`)) || fs.existsSync(path.join(root, `artifacts/midgame/mid-${src}-${stage}-${k}.json`)) || fs.existsSync(path.join(server, `mid-${src}-${stage}-${k}`))) k++;
  const world = `mid-${src}-${stage}-${k}`; ops.write(path.join(best, 'started'), `${k}\n`);
  fs.appendFileSync(path.join(root, '.trial-checkpoints/stage-starts.log'), `${new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z')}\t${stage}\t${path.basename(best)}\t${arm}\t${asked}\n`);
  const output = await run('midgame.js', ['start', world, path.join(best, 'world'), path.join(best, 'state')], { MIDGAME_PORT: port }); if (output) say(output);
  return { world, stage, snapshot: best, arm, asked };
}
async function main(argv = process.argv.slice(2), options = {}) {
  if (ops.help(argv, 'start-stage.js <port> <nether|fortress|stronghold|dragon> | --list [stage]')) return;
  if (argv[0] === '--list') { const output = await ops.runner(options)('trials/stage-pick.js', argv, { JEV_ROOT: options.root || ops.ROOT }); console.log(output); return output; }
  return startStage(argv[0], argv[1], options);
}
if (require.main === module) ops.cli(main);
module.exports = { startStage, main };
