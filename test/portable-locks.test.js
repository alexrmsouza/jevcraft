'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const ROOT = path.join(__dirname, '..');
const supervisor = path.join(ROOT, 'scripts/trials/supervisor.js');
const launcher = path.join(ROOT, 'scripts/server/start.js');
const fixture = t => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev locks ü-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })); return directory; };
const waitFor = async predicate => { const end = Date.now() + 10000; while (!predicate()) { if (Date.now() > end) throw new Error('fixture timed out'); await new Promise(resolve => setTimeout(resolve, 25)); } };
const childExit = child => new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
const listen = async t => { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close()); return server; };

test('two simultaneous supervisor processes cannot both claim the same port', async t => {
  const root = fixture(t), script = path.join(root, 'claim.js');
  fs.writeFileSync(script, `const fs = require('node:fs'); const { acquireSupervisor } = require(${JSON.stringify(supervisor)}); let release; process.send('ready'); process.on('message', () => { try { release = acquireSupervisor(25582, { root: ${JSON.stringify(root)} }); process.send('claimed'); setTimeout(() => { release(); process.exit(0); }, 1000); } catch (error) { process.send(error.message); process.exit(1); } });`);
  const children = [0, 1].map(() => spawn(process.execPath, [script], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  for (const child of children) t.after(() => { try { child.kill(); } catch (_) {} });
  const outcomes = [], ready = [];
  const exits = children.map(child => childExit(child));
  for (const child of children) child.on('message', message => { if (message === 'ready') ready.push(child); else outcomes.push(message); });
  await waitFor(() => ready.length === 2);
  for (const child of children) child.send('go');
  const statuses = await Promise.all(exits);
  assert.deepEqual(statuses.sort(), [0, 1]);
  assert.equal(outcomes.filter(message => message === 'claimed').length, 1);
  assert.match(outcomes.find(message => message !== 'claimed'), /already watching|already starting/);
  assert.equal(fs.existsSync(path.join(root, '.bot-state/supervisors/25582.json')), false);
});

test('a dead supervisor lock can be reclaimed and cleanup preserves a replacement owner', t => {
  const { acquireSupervisor } = require('../scripts/trials/supervisor');
  const root = fixture(t), directory = path.join(root, '.bot-state/supervisors');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, '25582.lock'), JSON.stringify({ pid: 2147483647, token: 'dead' }));
  const release = acquireSupervisor(25582, { root });
  const file = path.join(directory, '25582.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port: 25582, token: 'replacement' }));
  release();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'replacement');
});

test('corrupt server metadata permits a fake server relaunch after lock and port guards pass', async t => {
  const dir = fixture(t), probe = await listen(t), port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const fake = path.join(dir, 'fake java.js');
  fs.writeFileSync(fake, "process.stdin.on('data', text => { if(String(text).includes('stop\\n')) process.exit(0); });");
  fs.writeFileSync(path.join(dir, 'server.properties'), `server-port=${port}\r\n`);
  fs.writeFileSync(path.join(dir, '.jev-server.json'), '{"pid":');
  fs.writeFileSync(path.join(dir, 'server-launch.json'), JSON.stringify({ java: process.execPath, args: [fake] }));
  const child = spawn(process.execPath, [launcher, '--directory', dir], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; child.stderr.on('data', data => { errors += data; });
  t.after(() => { try { child.kill(); } catch (_) {} });
  const exited = childExit(child);
  await waitFor(() => { try { return !!JSON.parse(fs.readFileSync(path.join(dir, '.jev-server.json'), 'utf8')).session; } catch (_) { return child.exitCode !== null; } });
  assert.equal(child.exitCode, null, errors);
  require('../scripts/lib/server').writeConsole(dir, 'stop');
  assert.equal(await exited, 0);
  assert.equal(fs.existsSync(path.join(dir, '.jev-server.lock')), false);
});

test('corrupt server metadata never bypasses an occupied port or an active launcher lock', async t => {
  const dir = fixture(t), server = await listen(t), port = server.address().port;
  const file = path.join(dir, '.jev-server.json');
  fs.writeFileSync(file, '{"pid":');
  fs.writeFileSync(path.join(dir, 'server.properties'), `server-port=${port}\r\n`);
  let result = spawnSync(process.execPath, [launcher, '--directory', dir], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already occupied/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"pid":');
  fs.writeFileSync(path.join(dir, '.jev-server.lock'), String(process.pid));
  result = spawnSync(process.execPath, [launcher, '--directory', dir], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /launcher is already running/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"pid":');
});
