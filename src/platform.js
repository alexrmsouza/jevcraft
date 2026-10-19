'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repoRoot = path.join(__dirname, '..');

function listenerPid(port, { platform = process.platform, run = spawnSync } = {}) {
  port = Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const options = { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
  const diagnostics = [];
  const ask = (command, args) => {
    let result; try { result = run(command, args, options); } catch (error) { result = { error }; }
    if (result.error) diagnostics.push(`${command}: ${result.error.code || result.error.message}`);
    else if (result.status !== 0) diagnostics.push(`${command}: exit ${result.status}${result.stderr ? ` (${String(result.stderr).trim()})` : ''}`);
    return result;
  };
  const unavailable = () => { throw new Error(`Cannot determine the TCP listener on port ${port}; ${diagnostics.join('; ')}. Install/enable a listener discovery utility or check its permissions.`); };
  if (platform === 'win32') {
    const result = ask('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`]);
    const pid = Number(String(result.stdout || '').trim());
    if (!result.error && result.status === 0 && Number.isInteger(pid) && pid > 0) return pid;
    if (!result.error && result.status === 0 && !String(result.stdout || '').trim()) return null;
    const netstat = ask('netstat.exe', ['-ano', '-p', 'tcp']);
    if (netstat.error || netstat.status !== 0) return unavailable();
    for (const line of String(netstat.stdout || '').split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols[0] === 'TCP' && cols[1]?.endsWith(`:${port}`) && cols[3] === 'LISTENING' && /^\d+$/.test(cols[4])) return Number(cols[4]);
    }
    return null;
  }
  const lsof = ask('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN']);
  if (!lsof.error && (lsof.status === 0 || lsof.status === 1 && !String(lsof.stderr || '').trim())) {
    const text = String(lsof.stdout || '').trim(), pid = Number(text.split(/\s+/)[0]);
    if (!text) return null;
    if (Number.isInteger(pid) && pid > 0) return pid;
    diagnostics.push('lsof: invalid PID output');
  }
  const ss = ask('ss', ['-H', '-ltnp', `sport = :${port}`]);
  if (ss.error || ss.status !== 0) return unavailable();
  const text = String(ss.stdout || '').trim(); if (!text) return null;
  const found = text.match(/\bpid=(\d+)/);
  if (found && Number(found[1]) > 0) return Number(found[1]);
  diagnostics.push('ss: listener found but PID is unavailable (check process ownership/permissions)');
  return unavailable();
}
function isAlive(pid) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function stopProcess(pid, { force = false } = {}) {
  if (!isAlive(pid)) return false;
  try { process.kill(Number(pid), force ? 'SIGKILL' : 'SIGTERM'); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}
const supervisorFile = (root, port) => path.join(root, '.bot-state', 'supervisors', `${Number(port)}.json`);
function isSupervised(port, root = repoRoot) {
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) return false;
  try { const registration = JSON.parse(fs.readFileSync(supervisorFile(root, port), 'utf8')); return Number(registration.port) === Number(port) && isAlive(registration.pid); } catch (_) { return false; }
}
function readProperties(file) {
  const props = {};
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^\s*[#!]/.test(line)) continue;
    const match = line.match(/^\s*([^=:#\s]+)\s*[=:]\s*(.*?)\s*$/);
    if (match) props[match[1]] = match[2];
  }
  return props;
}
const serverDirectory = (root, port) => path.join(root, Number(port) === 25581 ? '.clean-run' : `.clean-run-${Number(port)}`);
module.exports = { listenerPid, isAlive, stopProcess, supervisorFile, isSupervised, readProperties, serverDirectory };
