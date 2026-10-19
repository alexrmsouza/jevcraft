'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ops = require('../lib/trial-ops');
async function harvest(port, options = {}) {
  const { root = ops.ROOT, pause = ops.pause, now = Date.now() } = options, core = require('../lib/platform');
  port = ops.port(port);
  const { listenerPid = core.listenerPid, isAlive = core.isAlive, stopProcess = core.stopProcess, writeConsole = require('../lib/server').writeConsole } = options;
  const server = core.serverDirectory(root, Number(port)), world = ops.name(core.readProperties(path.join(server, 'server.properties'))['level-name']);
  const source = ops.safePath(server, path.join(server, world)); if (!fs.existsSync(source)) throw new Error(`world missing: ${source}`);
  const id = `127_0_0_1-${port}-Jev`, pidfile = ops.safePath(root, path.join(root, `.bot-state/pids/127.0.0.1-${port}-Jev.pid`)), starting = pidfile.replace(/\.pid$/, '.starting');
  ops.write(starting, '');
  try {
    const bot = Number(ops.read(pidfile).trim()); if (bot > 0 && await isAlive(bot)) { await stopProcess(bot, { force: false }); await pause(4000, options.signal); if (await isAlive(bot)) throw new Error(`bot ${bot} still up on ${port}`); }
    const srv = await listenerPid(Number(port));
    if (srv) { writeConsole(server, 'stop'); let i = 0; while (await isAlive(srv) && i++ < 60 && !options.signal?.aborted) await pause(1000, options.signal); }
    if (options.signal?.aborted) throw new Error('harvest aborted');
    if (await listenerPid(Number(port))) throw new Error(`server on ${port} still up`);
    const base = ops.safePath(root, path.join(root, '.trial-sources')); fs.mkdirSync(base, { recursive: true });
    const destination = ops.safePath(base, path.join(base, world)), temporary = ops.safePath(base, path.join(base, `.harvest-${world}-${process.pid}-${now}`));
    try { ops.copyTree(source, temporary); if (fs.existsSync(destination)) ops.safeRemove(base, destination); fs.renameSync(temporary, destination); }
    catch (error) { ops.safeRemove(base, temporary); throw error; }
    const archive = ops.safePath(root, path.join(root, `.bot-state/archive-${id}-${now}`)); fs.mkdirSync(archive, { recursive: true });
    for (const file of ops.stateFiles(root, port)) ops.copyTree(file, path.join(archive, path.basename(file)));
    const relativeSource = path.relative(root, destination).split(path.sep).join('/'), relativeArchive = path.relative(root, archive).split(path.sep).join('/');
    ops.write(`${destination}.archive`, `${relativeArchive}\n`); return { world, source: relativeSource, archive: relativeArchive };
  } finally { fs.rmSync(starting, { force: true }); }
}
async function main(argv = process.argv.slice(2), options = {}) { if (ops.help(argv, 'harvest.js <port>')) return; const result = await harvest(argv[0], options); console.log(`${result.source} ${result.archive}`); return result; }
if (require.main === module) ops.cli(main);
module.exports = { harvest, main };
