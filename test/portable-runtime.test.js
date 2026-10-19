'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const root = path.join(__dirname, '..');
const fixture = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev space ü-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })); return dir; };
const readyConsole = dir => fs.writeFileSync(path.join(dir, '.jev-server.json'), JSON.stringify({ pid: process.pid, launcherPid: process.pid, session: 'fixture' }));
async function serverFixture(t) {
  const dir = fixture(t), reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const { port } = reservation.address();
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  fs.writeFileSync(path.join(dir, 'server.properties'), `server-port=${port}\r\n`);
  return dir;
}

test('platform reads CRLF properties and verifies supervisor registration', t => {
  const p = require('../src/platform');
  const dir = fixture(t), props = path.join(dir, 'server.properties');
  fs.writeFileSync(props, '# comment\r\nserver-port=25581\r\nlevel-name=mid-world\r\n');
  assert.deepEqual(p.readProperties(props), { 'server-port': '25581', 'level-name': 'mid-world' });
  assert.equal(p.isAlive(process.pid), true);
  assert.equal(p.isAlive(0), false);
  const file = p.supervisorFile(dir, 25581);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port: 25581 }));
  assert.equal(p.isSupervised(25581, dir), true);
  assert.equal(p.isSupervised(25582, dir), false);
  assert.equal(p.serverDirectory(dir, 25581), path.join(dir, '.clean-run'));
});

test('listener lookup parses Windows and Unix commands with a finite timeout', () => {
  const { listenerPid } = require('../src/platform');
  const calls = [];
  const run = (file, args, options) => { calls.push({ file, args, options }); return { status: 0, stdout: '  1234\r\n' }; };
  assert.equal(listenerPid(25581, { platform: 'win32', run }), 1234);
  assert.ok(calls[0].options.timeout > 0);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(listenerPid('25581;bad', { run }), null);
  assert.equal(listenerPid(25581, { platform: 'linux', run }), 1234);
});

test('Linux listener lookup uses ss when lsof is unavailable and distinguishes a free port', () => {
  const { listenerPid } = require('../src/platform');
  const calls = [], run = (file, args) => { calls.push([file, args]); return file === 'lsof' ? { error: Object.assign(new Error('not found'), { code: 'ENOENT' }), status: null } : { status: 0, stdout: 'LISTEN 0 4096 127.0.0.1:25581 0.0.0.0:* users:(("java",pid=4321,fd=6))\n' }; };
  assert.equal(listenerPid(25581, { platform: 'linux', run }), 4321);
  assert.deepEqual(calls.map(c => c[0]), ['lsof', 'ss']);
  assert(calls[1][1].some(arg => arg.includes('25581')));
  assert.equal(listenerPid(25581, { platform: 'linux', run: () => ({ status: 1, stdout: '', stderr: '' }) }), null, 'lsof exit 1 with no diagnostics means no listener');
  assert.equal(listenerPid(25581, { platform: 'linux', run: file => file === 'lsof' ? { error: { code: 'ENOENT' } } : { status: 0, stdout: '' } }), null, 'ss empty success means no listener');
});

test('listener lookup reports unavailable discovery rather than treating the port as free', () => {
  const { listenerPid } = require('../src/platform');
  const unavailable = () => ({ status: null, error: Object.assign(new Error('not found'), { code: 'ENOENT' }) });
  assert.throws(() => listenerPid(25581, { platform: 'linux', run: unavailable }), /cannot determine.*25581.*lsof.*ss/i);
  assert.throws(() => listenerPid(25581, { platform: 'win32', run: unavailable }), /cannot determine.*25581.*powershell.*netstat/i);
  const timeout = () => ({ status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) });
  assert.throws(() => listenerPid(25581, { platform: 'linux', run: timeout }), /ETIMEDOUT/);
  assert.throws(() => listenerPid(25581, { platform: 'linux', run: file => file === 'lsof' ? unavailable() : { status: 0, stdout: 'LISTEN 0 128 0.0.0.0:25581 0.0.0.0:*\n' } }), /PID.*unavailable|cannot determine/i);
});

test('Windows discovery can use netstat when PowerShell is unavailable', () => {
  const { listenerPid } = require('../src/platform');
  const run = file => file === 'powershell.exe' ? { error: { code: 'ENOENT' } } : { status: 0, stdout: '  TCP    127.0.0.1:25581    0.0.0.0:0    LISTENING    3210\r\n' };
  assert.equal(listenerPid(25581, { platform: 'win32', run }), 3210);
  assert.equal(listenerPid(25582, { platform: 'win32', run }), null);
});

test('console commands are queued independently without overwrite', t => {
  const { writeConsole } = require('../scripts/lib/server');
  const dir = fixture(t);
  readyConsole(dir);
  writeConsole(dir, 'say first\n'); writeConsole(dir, 'say second\n');
  const queued = fs.readdirSync(path.join(dir, '.jev-console')).filter(f => f.endsWith('.cmd')).sort();
  assert.equal(queued.length, 2);
  assert.deepEqual(queued.map(f => JSON.parse(fs.readFileSync(path.join(dir, '.jev-console', f), 'utf8'))), [{ session: 'fixture', text: 'say first\n' }, { session: 'fixture', text: 'say second\n' }]);
});

test('console file adapter queues normal paths and preserves batched commands', t => {
  const { writeConsoleFile } = require('../scripts/lib/server');
  const dir = fixture(t), file = path.join(dir, 'custom-console.in');
  readyConsole(dir);
  fs.writeFileSync(file, 'old regular file');
  writeConsoleFile(file, 'say one'); writeConsoleFile(file, 'say two\r\nsay three');
  assert.equal(fs.readFileSync(file, 'utf8'), 'old regular file');
  const queue = path.join(dir, '.jev-console');
  const commands = fs.readdirSync(queue).filter(f => f.endsWith('.cmd')).sort().map(f => JSON.parse(fs.readFileSync(path.join(queue, f), 'utf8')).text);
  assert.deepEqual(commands, ['say one\n', 'say two\nsay three\n']);
});

test('server launcher drives a fake process through a path with spaces and exits on stop', async t => {
  const { writeConsole, startServer, serverRunning } = require('../scripts/lib/server');
  const dir = await serverFixture(t);
  const fake = path.join(dir, 'fake java.js');
  fs.writeFileSync(fake, "let text=''; process.stdin.on('data', data => { text += data; require('fs').appendFileSync('received.txt', data); if(text.includes('stop\\n')) process.exit(0); });");
  fs.writeFileSync(path.join(dir, 'server-launch.json'), JSON.stringify({ java: process.execPath, args: [fake] }));
  assert.throws(() => writeConsole(dir, 'say too early'), /console is not ready/i);
  fs.mkdirSync(path.join(dir, '.jev-console'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.jev-console', '0000000000000000-stale.cmd'), JSON.stringify({ session: 'previous-world', text: 'stop\n' }));
  const child = startServer(dir, { root, detached: false });
  t.after(() => { try { child.kill(); } catch (_) {} });
  const until = async fn => { const end = Date.now() + 10000; while (!fn()) { if (Date.now() > end) throw new Error('launcher timed out'); await new Promise(r => setTimeout(r, 50)); } };
  await until(() => serverRunning(dir));
  const state = JSON.parse(fs.readFileSync(path.join(dir, '.jev-server.json'), 'utf8'));
  assert.match(state.session, /^[0-9a-f-]{36}$/);
  const duplicate = spawnSync(process.execPath, [path.join(root, 'scripts/server/start.js'), '--directory', dir], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(duplicate.status, 0);
  writeConsole(dir, 'say hello'); writeConsole(dir, 'stop');
  await until(() => child.exitCode !== null);
  assert.equal(serverRunning(dir), false);
  assert.equal(fs.readFileSync(path.join(dir, 'received.txt'), 'utf8'), 'say hello\nstop\n');
});

test('explicit Java and jar environment override server-launch.json', () => {
  const { launchOptions } = require('../scripts/server/start');
  const options = launchOptions({ java: 'saved-java', jar: 'saved.jar' }, { JAVA: 'override-java', SERVER_JAR: 'override.jar' });
  assert.equal(options.java, 'override-java');
  assert.deepEqual(options.args, ['-Xms1G', '-Xmx2G', '-jar', 'override.jar', 'nogui']);
});

test('launcher help has no filesystem side effects', t => {
  const dir = fixture(t);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/server/start.js'), '--help'], { cwd: dir, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /server-launch.json/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('launcher cleans its lock and timers after an executable fails to spawn', async t => {
  const dir = await serverFixture(t);
  fs.writeFileSync(path.join(dir, 'server-launch.json'), JSON.stringify({ java: path.join(dir, 'missing-java.exe') }));
  const child = spawn(process.execPath, [path.join(root, 'scripts/server/start.js'), '--directory', dir], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('spawn failure kept the launcher alive')); }, 10000);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exit, 1);
  assert.match(stderr, /Server launch failed/);
  assert.equal(fs.existsSync(path.join(dir, '.jev-server.lock')), false);
  assert.equal(fs.existsSync(path.join(dir, '.jev-server.json')), false);
});

test('supervisor leaves starts, down servers and fresh flights alone; restarts a stale bot', async t => {
  const { tick } = require('../scripts/trials/supervisor');
  const dir = fixture(t), port = 25582;
  const server = path.join(dir, '.clean-run-25582'), state = path.join(dir, '.bot-state');
  fs.mkdirSync(server, { recursive: true });
  fs.mkdirSync(path.join(state, 'pids'), { recursive: true });
  fs.mkdirSync(path.join(state, 'flight'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(server, 'server.properties'), 'level-name=mid-test\r\nserver-port=25582\r\n');
  fs.writeFileSync(path.join(dir, 'artifacts', 'midgame-mid-test.log'), '');
  const pid = path.join(state, 'pids', '127.0.0.1-25582-Jev.pid');
  const flight = path.join(state, 'flight', '127_0_0_1-25582-Jev-test.jsonl');
  fs.writeFileSync(pid, '1234'); fs.writeFileSync(flight, '');
  const launched = [], killed = [];
  const options = { root: dir, listening: () => 42, alive: () => true, now: () => Date.now(), stop: (p, o) => killed.push([p, o]), sleep: async () => {}, launch: (p, out) => { launched.push([p, out]); return { child: { pid: 999 } }; }, say: () => {} };
  assert.equal(await tick(port, { ...options, listening: () => null }), 'server-down');
  fs.writeFileSync(pid.replace('.pid', '.starting'), '1');
  assert.equal(await tick(port, options), 'starting');
  fs.rmSync(pid.replace('.pid', '.starting'));
  assert.equal(await tick(port, options), 'healthy');
  assert.equal(launched.length, 0);
  fs.utimesSync(flight, new Date(Date.now() - 120000), new Date(Date.now() - 120000));
  assert.equal(await tick(port, options), 'restarted');
  assert.deepEqual(killed, [[1234, undefined], [1234, { force: true }]]);
  assert.equal(launched.length, 1);
  assert.equal(launched[0][0], port);
});

test('listener lookup finds a real native Windows or Unix TCP listener', async t => {
  const server = require('node:net').createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  assert.equal(require('../src/platform').listenerPid(server.address().port), process.pid);
});
