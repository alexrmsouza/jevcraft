'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { isAlive, listenerPid, readProperties } = require('./platform');
let sequence = 0;

function writeConsole(directory, text) {
  let state;
  try { state = JSON.parse(fs.readFileSync(path.join(directory, '.jev-server.json'), 'utf8')); } catch (_) {}
  if (!state?.session || !isAlive(state.pid) || !isAlive(state.launcherPid)) throw new Error(`Server console is not ready in ${directory}; start it with node scripts/server/start.js --directory <directory> and wait for it to be ready`);
  const queue = path.join(directory, '.jev-console');
  fs.mkdirSync(queue, { recursive: true });
  const name = `${String(Date.now()).padStart(16, '0')}-${String(sequence++).padStart(8, '0')}-${process.pid}-${randomUUID()}`;
  const temporary = path.join(queue, `${name}.tmp`), target = path.join(queue, `${name}.cmd`);
  fs.writeFileSync(temporary, JSON.stringify({ session: state.session, text: String(text).replace(/\r\n/g, '\n').replace(/\n*$/, '\n') }), { flag: 'wx' });
  fs.renameSync(temporary, target);
  return target;
}
function writeConsoleFile(consolePath, text) {
  try { if (fs.statSync(consolePath).isFIFO()) { fs.writeFileSync(consolePath, String(text).replace(/\n*$/, '\n')); return consolePath; } } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return writeConsole(path.dirname(consolePath), text);
}
function serverRunning(directory) {
  try { const state = JSON.parse(fs.readFileSync(path.join(directory, '.jev-server.json'), 'utf8')); if (isAlive(state.pid)) return true; } catch (_) {}
  try { return !!listenerPid(readProperties(path.join(directory, 'server.properties'))['server-port'] || 25565); } catch (_) { return false; }
}
function startServer(directory, { root = path.join(__dirname, '../..'), env = process.env, log, detached = true } = {}) {
  directory = path.resolve(directory);
  const output = fs.openSync(log || path.join(directory, 'launcher.log'), 'a');
  let child;
  try { child = spawn(process.execPath, [path.join(root, 'scripts/server/start.js'), '--directory', directory], { cwd: directory, env, detached, windowsHide: true, stdio: ['ignore', output, output] }); } finally { fs.closeSync(output); }
  if (detached) child.unref();
  return child;
}
module.exports = { writeConsole, writeConsoleFile, startServer, serverRunning };
