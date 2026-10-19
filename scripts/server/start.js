'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { isAlive, listenerPid, readProperties, stopProcess } = require('../lib/platform');

function launchOptions(config, env) {
  const java = env.JAVA || config.java || 'java';
  const jar = env.SERVER_JAR || config.jar || 'server.jar';
  const args = config.args ? [...config.args] : ['-Xms1G', '-Xmx2G', '-jar', jar, 'nogui'];
  if (!Array.isArray(config.args ?? args) || args.some(arg => typeof arg !== 'string')) throw new Error('server-launch.json args must be an array of strings');
  if (env.SERVER_JAR && args.includes('-jar')) args[args.indexOf('-jar') + 1] = jar;
  return { java, args };
}

function launch(directory, { env = process.env } = {}) {
  directory = path.resolve(directory);
  const metadata = path.join(directory, '.jev-server.json'), lock = path.join(directory, '.jev-server.lock');
  if (fs.existsSync(lock)) {
    const owner = Number(fs.readFileSync(lock, 'utf8'));
    if (isAlive(owner)) throw new Error(`A server launcher is already running (${owner})`);
    fs.rmSync(lock, { force: true });
  }
  fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
  let child, timer, killTimer;
  const clean = () => {
    clearInterval(timer); clearTimeout(killTimer);
    try { if (JSON.parse(fs.readFileSync(metadata, 'utf8')).launcherPid === process.pid) fs.rmSync(metadata, { force: true }); } catch (_) {}
    try { if (Number(fs.readFileSync(lock, 'utf8')) === process.pid) fs.rmSync(lock, { force: true }); } catch (_) {}
  };
  try {
    let previous;
    try { previous = JSON.parse(fs.readFileSync(metadata, 'utf8')); }
    catch (error) { if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error; }
    if (isAlive(previous?.pid) || isAlive(previous?.launcherPid)) throw new Error('The server is already running');
    const props = fs.existsSync(path.join(directory, 'server.properties')) ? readProperties(path.join(directory, 'server.properties')) : {};
    const port = Number(props['server-port'] || 25565);
    if (listenerPid(port)) throw new Error(`Port ${port} is already occupied`);
    // A crash can truncate metadata. It is overwritten only after this
    // launch owns the lock, the port is free and its Java process spawns.
    let config = {};
    const configFile = path.join(directory, 'server-launch.json');
    if (fs.existsSync(configFile)) config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const { java, args } = launchOptions(config, env);
    const queue = path.join(directory, '.jev-console');
    fs.mkdirSync(queue, { recursive: true });
    const session = randomUUID();
    child = spawn(java, args, { cwd: directory, env, windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') console.error(error.message); });
    child.once('spawn', () => fs.writeFileSync(metadata, JSON.stringify({ pid: child.pid, launcherPid: process.pid, session, port, startedAt: new Date().toISOString() })));
    child.once('error', error => { console.error(`Server launch failed: ${error.message}`); clean(); process.exitCode = 1; });
    child.once('exit', code => { clean(); process.exitCode = code || 0; });
    timer = setInterval(() => {
      for (const file of fs.readdirSync(queue).filter(f => f.endsWith('.cmd')).sort()) {
        if (!child.stdin.writable || child.stdin.destroyed) break;
        const full = path.join(queue, file);
        let command;
        try { command = JSON.parse(fs.readFileSync(full, 'utf8')); }
        catch (_) { console.error(`Invalid queued console command: ${file}`); fs.renameSync(full, `${full}.invalid`); continue; }
        if (command.session === session) child.stdin.write(command.text);
        fs.rmSync(full, { force: true });
      }
    }, 100);
    const stop = () => {
      if (!isAlive(child.pid)) return;
      child.stdin.write('stop\n');
      killTimer ??= setTimeout(() => stopProcess(child.pid, { force: true }), 30000);
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return child;
  } catch (error) { clean(); throw error; }
}
function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) { console.log('node scripts/server/start.js --directory <server directory>\nOptional server-launch.json: {"java":"java","jar":"server.jar","args":["-Xms1G","-Xmx2G","-jar","server.jar","nogui"]}\nJAVA and SERVER_JAR override saved configuration. Console commands use .jev-console/*.cmd.'); return; }
  const index = argv.indexOf('--directory');
  if (index >= 0 && !argv[index + 1]) throw new Error('--directory needs a path');
  launch(index >= 0 ? argv[index + 1] : process.cwd());
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { launchOptions, launch, main };
