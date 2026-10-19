'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { zipSync, strToU8 } = require('fflate');
const setup = require('../scripts/lib/server-setup');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev setup espaço '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test('JDK downloads select the actual OS and architecture', () => {
  assert.deepEqual(setup.platformTarget('win32', 'x64'), { os: 'windows', architecture: 'x64', extension: 'zip' });
  assert.deepEqual(setup.platformTarget('darwin', 'arm64'), { os: 'mac', architecture: 'aarch64', extension: 'tar.gz' });
  assert.deepEqual(setup.platformTarget('linux', 'x64'), { os: 'linux', architecture: 'x64', extension: 'tar.gz' });
  assert.throws(() => setup.platformTarget('unknown', 'x64'), /Unsupported/);
});
test('server preparation requires EULA acceptance and preserves an existing configuration', t => {
  const directory = temporary(t);
  assert.throws(() => setup.prepareServer(directory, { port: 25690, java: 'java', jar: 'server.jar' }), /EULA/);
  assert.equal(fs.existsSync(path.join(directory, 'eula.txt')), false);
  setup.prepareServer(directory, { port: 25690, java: 'C:/Java espaço/bin/java.exe', jar: 'C:/Minecraft/server.jar', acceptEula: true });
  assert.equal(fs.readFileSync(path.join(directory, 'eula.txt'), 'utf8'), 'eula=true\n');
  const launch = JSON.parse(fs.readFileSync(path.join(directory, 'server-launch.json'), 'utf8'));
  assert.equal(launch.java, 'C:/Java espaço/bin/java.exe');
  assert.equal(launch.jar, 'C:/Minecraft/server.jar');
  assert.match(fs.readFileSync(path.join(directory, 'server.properties'), 'utf8'), /^server-port=25690$/m);
  fs.writeFileSync(path.join(directory, 'server.properties'), 'server-port=25691\r\nlevel-name=my-world\r\n');
  setup.prepareServer(directory, { port: 25690, java: 'other-java', jar: 'other.jar' });
  assert.equal(fs.readFileSync(path.join(directory, 'server.properties'), 'utf8'), 'server-port=25691\r\nlevel-name=my-world\r\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'server-launch.json'), 'utf8')), launch);
});
test('arena preparation creates the flat world and native launcher configuration', t => {
  const directory = temporary(t);
  setup.prepareServer(directory, { port: 25692, java: 'java', jar: 'arena.jar', arena: true, acceptEula: true });
  const properties = fs.readFileSync(path.join(directory, 'server.properties'), 'utf8');
  assert.match(properties, /^level-name=arena$/m);
  assert.match(properties, /^level-type=minecraft\\:flat$/m);
  assert.equal(fs.existsSync(path.join(directory, 'logs')), true);
});
test('downloads verify their checksum before replacing a file', async t => {
  const directory = temporary(t), destination = path.join(directory, 'server.jar');
  const bytes = Buffer.from('verified server fixture');
  const fetchImpl = async () => new Response(bytes);
  await setup.downloadFile('https://fixture.invalid/server.jar', destination, { hash: createHash('sha256').update(bytes).digest('hex'), fetchImpl });
  assert.deepEqual(fs.readFileSync(destination), bytes);
  await assert.rejects(setup.downloadFile('https://fixture.invalid/bad.jar', destination, { hash: '0'.repeat(64), fetchImpl }), /checksum/i);
  assert.deepEqual(fs.readFileSync(destination), bytes);
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.part')), false);
});
test('Windows JDK ZIP extraction handles spaces and rejects paths outside its directory', t => {
  const directory = temporary(t);
  const archive = zipSync({ 'jdk-25/bin/java.exe': strToU8('java fixture'), 'jdk-25/release': strToU8('JAVA_VERSION="25"') });
  const executable = setup.extractWindowsJdk(archive, path.join(directory, 'jdk'));
  assert.equal(fs.readFileSync(executable, 'utf8'), 'java fixture');
  const unsafe = zipSync({ '../outside.txt': strToU8('outside') });
  assert.throws(() => setup.extractWindowsJdk(unsafe, path.join(directory, 'bad')), /outside|archive path/i);
  assert.equal(fs.existsSync(path.join(directory, 'outside.txt')), false);
});

test('tool setup follows compatible upstream metadata and verifies each downloaded artifact', async t => {
  const directory = temporary(t), target = path.join(directory, 'tools');
  const files = {
    'https://fixture.invalid/jdk.zip': zipSync({ 'jdk-25/bin/java.exe': strToU8('fixture java') }),
    'https://fixture.invalid/server.jar': Buffer.from('vanilla'),
    'https://fixture.invalid/fabric.jar': Buffer.from('fabric'),
    'https://fixture.invalid/mod.jar': Buffer.from('mod'),
  };
  const hash = (url, algorithm) => createHash(algorithm).update(files[url]).digest('hex');
  const requests = [];
  const fetchImpl = async url => {
    requests.push(String(url));
    if (files[url]) return new Response(files[url]);
    if (String(url).includes('api.adoptium.net')) return Response.json([{ binary: { package: { link: 'https://fixture.invalid/jdk.zip', checksum: hash('https://fixture.invalid/jdk.zip', 'sha256') } } }]);
    if (String(url).includes('version_manifest_v2')) return Response.json({ versions: [{ id: '26.1.2', url: 'https://fixture.invalid/version.json' }] });
    if (url === 'https://fixture.invalid/version.json') return Response.json({ downloads: { server: { url: 'https://fixture.invalid/server.jar', sha1: hash('https://fixture.invalid/server.jar', 'sha1') } } });
    if (String(url).endsWith('/versions/installer')) return Response.json([{ version: '1.1.0', stable: true }]);
    if (String(url).endsWith('/versions/loader/26.1.2')) return Response.json([{ loader: { version: '0.19.5', stable: true } }]);
    if (String(url).endsWith('/server/jar')) return new Response(files['https://fixture.invalid/fabric.jar']);
    if (String(url).includes('api.modrinth.com')) return Response.json([
      { game_versions: ['old'], loaders: ['fabric'], files: [{ primary: true, url: 'wrong' }] },
      { game_versions: ['26.1.2'], loaders: ['fabric'], files: [{ primary: true, url: 'https://fixture.invalid/mod.jar', filename: `mod-${String(url).split('/').at(-2)}.jar`, hashes: { sha512: hash('https://fixture.invalid/mod.jar', 'sha512') } }] },
    ]);
    throw new Error(`Unexpected fixture URL: ${url}`);
  };
  const javaRun = command => command === 'java' ? { status: 0, stderr: 'openjdk version "23.0.1"' } : { status: 0, stderr: 'openjdk version "25.0.1"' };
  const result = await setup.ensureTools({ root: directory, tools: target, platform: 'win32', arch: 'x64', env: {}, fetchImpl, javaRun, say() {} });
  assert.equal(fs.readFileSync(result.serverJar, 'utf8'), 'vanilla');
  assert.equal(fs.readFileSync(result.fabricJar, 'utf8'), 'fabric');
  assert.equal(result.mods.length, 3);
  assert.match(result.java, /java\.exe$/);
  assert.ok(requests.some(url => url.includes('os=windows') && url.includes('architecture=x64')));
  assert.ok(requests.some(url => url.endsWith('/26.1.2/0.19.5/1.1.0/server/jar')));
  const cached = await setup.ensureTools({ root: directory, tools: target, platform: 'win32', arch: 'x64', env: {}, fetchImpl: async () => { throw new Error('cached setup must not download'); }, javaRun, say() {} });
  assert.equal(cached.serverJar, result.serverJar);
});

test('explicit old Java is rejected instead of silently replaced', async t => {
  await assert.rejects(setup.ensureTools({ root: temporary(t), env: { JAVA: 'old java' }, javaRun: () => ({ status: 0, stderr: 'java version "23.0.1"' }), fetchImpl: async () => { throw new Error('must not download'); } }), /JAVA.*25/);
});

test('setup tools-only never accepts the EULA or creates server directories', async t => {
  const cli = require('../scripts/trials/setup');
  const root = temporary(t), tools = path.join(root, 'custom tools');
  let options;
  await cli.main(['--tools-only', '--tools', tools, '--vanilla'], { root, env: {}, say() {}, ensureToolsImpl: async input => { options = input; return { java: 'java', serverJar: 'server.jar' }; } });
  assert.equal(options.tools, tools);
  assert.equal(options.vanilla, true);
  assert.equal(fs.existsSync(path.join(root, '.clean-run')), false);
  assert.deepEqual(fs.readdirSync(root), []);
  await assert.rejects(cli.main([], { root, env: {}, say() {}, ensureToolsImpl: async () => { throw new Error('must not download'); } }), /EULA/);
});

test('setup writes native trial configs and preserves edits on rerun', async t => {
  const cli = require('../scripts/trials/setup');
  const root = temporary(t), tools = path.join(root, 'tools'), mods = path.join(tools, 'mods');
  fs.mkdirSync(mods, { recursive: true });
  const mod = path.join(mods, 'replay.jar'); fs.writeFileSync(mod, 'fixture');
  const options = { root, env: {}, say() {}, ensureToolsImpl: async () => ({ java: 'java25', serverJar: path.join(tools, 'server.jar'), fabricJar: path.join(tools, 'fabric.jar'), mods: [{ file: mod }] }) };
  await cli.main(['2', '--accept-eula'], options);
  const server = path.join(root, '.clean-run');
  assert.equal(fs.readFileSync(path.join(server, 'mods', 'replay.jar'), 'utf8'), 'fixture');
  assert.match(fs.readFileSync(path.join(server, 'fabric-server-launcher.properties'), 'utf8'), /serverJar=.*server.jar/);
  const config = path.join(server, 'config', 'server-replay', 'config.json');
  fs.writeFileSync(config, '{"custom":true}');
  await cli.main(['2'], options);
  assert.equal(fs.readFileSync(config, 'utf8'), '{"custom":true}');
  assert.equal(fs.existsSync(path.join(root, '.clean-run-25582', 'server-launch.json')), true);
});

test('arena native entrypoint prepares a flat server and uses the managed launcher', async t => {
  const cli = require('../scripts/trials/arena-start');
  const root = temporary(t); let launch;
  const child = new (require('node:events').EventEmitter)();
  await cli.main(['--accept-eula'], { root, env: { ARENA_PORT: '25575' }, say() {}, ensureToolsImpl: async () => ({ java: 'java25', serverJar: 'fixture.jar' }), startServerImpl: (directory, options) => { launch = { directory, options }; return child; }, serverRunningImpl: directory => { assert.equal(fs.existsSync(path.join(directory, 'server.properties')), true, 'port check must read the prepared custom arena port'); return false; } });
  assert.equal(launch.directory, path.join(root, '.test-combat'));
  assert.equal(launch.options.detached, false);
  assert.equal(launch.options.log, path.join(root, '.test-combat', 'logs', 'arena-console.log'));
  assert.match(fs.readFileSync(path.join(launch.directory, 'server.properties'), 'utf8'), /^server-port=25575$/m);
  child.emit('exit', 0);
});

test('CLI help has no filesystem or download effects', async t => {
  const root = temporary(t);
  const options = { root, env: {}, say() {}, ensureToolsImpl: async () => { throw new Error('help must not download'); } };
  await require('../scripts/trials/setup').main(['--help'], options);
  await require('../scripts/trials/arena-start').main(['--help'], options);
  assert.deepEqual(fs.readdirSync(root), []);
});
