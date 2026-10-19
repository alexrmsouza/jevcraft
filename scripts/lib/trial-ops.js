'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const ROOT = path.resolve(__dirname, '../..');

function read(file, fallback = '') { try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }
function entries(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
function name(value) { if (!/^[\w.-]+$/.test(value || '') || value === '.' || value === '..') throw new Error(`invalid world/stage name: ${value}`); return value; }
function port(value) { const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid port: ${value}`); return String(n); }
function safePath(base, file) {
  base = path.resolve(base); file = path.resolve(file);
  const relative = path.relative(base, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`path must be a descendant of ${base}: ${file}`);
  // Check the allowlist root and every ancestor, including junctions on Windows.
  let current = path.parse(base).root;
  for (const part of path.relative(current, file).split(path.sep)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`symbolic link in managed path: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return file;
}
function safeRemove(base, file) { fs.rmSync(safePath(base, file), { recursive: true, force: true }); }
function copyTree(source, target) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`refusing to copy symbolic link: ${source}`);
  try { if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`refusing to overwrite symbolic link: ${target}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat.isDirectory()) { fs.mkdirSync(target, { recursive: true }); for (const entry of entries(source)) copyTree(path.join(source, entry.name), path.join(target, entry.name)); }
  else if (stat.isFile()) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target); }
}
function serverDirs(root = ROOT) { return entries(root).filter(e => e.isDirectory() && /^\.clean-run(?:-\d+)?$/.test(e.name)).map(e => path.join(root, e.name)); }
function properties(dir) { try { return require('./platform').readProperties(path.join(dir, 'server.properties')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; } }
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function utc(now = Date.now()) { return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
function freeGb(root) { const stat = fs.statfsSync(root); return Number(stat.bavail) * Number(stat.bsize) / 1024 ** 3; }
async function pause(ms, signal) { if (signal?.aborted) return; try { await delay(ms, undefined, { signal }); } catch (error) { if (error.name !== 'AbortError') throw error; } }
async function run(script, args = [], env = {}, { root = ROOT, timeout, signal, inherit = false, echoStderr = false, execFile: execute = execFile } = {}) {
  const file = path.join(root, 'scripts', script);
  if (inherit) return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args.map(String)], { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true, signal });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve('') : reject(new Error(`${script} exited ${code}`)));
  });
  // A start may need to stop an old server, prepare a world and wait for Java.
  // Its normal budget exceeds two minutes; only read commands have that cap.
  const deadline = timeout ?? (args[0] === 'start' ? 0 : 120000);
  return new Promise((resolve, reject) => execute(process.execPath, [file, ...args.map(String)], { cwd: root, env: { ...process.env, ...env }, timeout: deadline, signal, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => { if (echoStderr && stderr) process.stderr.write(stderr); return error ? reject(Object.assign(error, { stderr })) : resolve(stdout.trim()); }));
}
function runner(options = {}) { return options.run || ((script, args, env) => run(script, args, env, options)); }
function cli(main) { main().catch(error => { console.error(error.message); process.exitCode = 1; }); }
function help(argv, usage) { if (!argv.includes('--help') && !argv.includes('-h')) return false; console.log(`usage: node scripts/trials/${usage}`); return true; }
function options(argv) { return { once: argv.includes('--once'), args: argv.filter(a => a !== '--once') }; }
async function loop(action, { once = false, signal, every = 1000 } = {}) { while (!signal?.aborted) { const result = await action(); if (once || result === false) return result; await pause(every, signal); } }
function stateFiles(root, portNumber) { const id = `127_0_0_1-${port(portNumber)}-Jev`; return entries(path.join(root, '.bot-state')).filter(e => e.isFile() && e.name.startsWith(id) && e.name.endsWith('.json')).map(e => path.join(root, '.bot-state', e.name)); }
async function ports(requested, { root = ROOT, prefix = '', listenerPid = require('./platform').listenerPid } = {}) {
  if (requested[0] !== 'auto') return requested.map(port);
  const found = [];
  for (const dir of serverDirs(root)) { const props = properties(dir); if ((props['level-name'] || '').startsWith(prefix) && props['server-port'] && await listenerPid(Number(props['server-port']))) found.push(port(props['server-port'])); }
  return found;
}
function supervise(portNumber, { root = ROOT, env = process.env } = {}) {
  const core = require('./platform');
  if (core.isSupervised(Number(portNumber), root)) return null;
  const logfile = path.join(root, 'artifacts/supervisors', `${portNumber}.log`); fs.mkdirSync(path.dirname(logfile), { recursive: true });
  const fd = fs.openSync(logfile, 'a');
  try { const child = spawn(process.execPath, [path.join(root, 'scripts/trials/supervisor.js'), String(portNumber)], { cwd: root, env, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] }); child.unref(); return child; }
  finally { fs.closeSync(fd); }
}
module.exports = { ROOT, read, entries, name, port, safePath, safeRemove, copyTree, serverDirs, properties, write, utc, freeGb, pause, run, runner, cli, help, options, loop, stateFiles, ports, supervise };
