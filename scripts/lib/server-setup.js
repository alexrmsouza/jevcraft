'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { unzipSync } = require('fflate');

const VERSION = '26.1.2';
const MODS = ['P7dR8mSH', 'Ha28R6CL', 'qCvSZ8ra'];

function platformTarget(platform = process.platform, arch = process.arch) {
  const os = { win32: 'windows', darwin: 'mac', linux: 'linux' }[platform];
  const architecture = { x64: 'x64', arm64: 'aarch64' }[arch];
  if (!os || !architecture) throw new Error(`Unsupported Java platform: ${platform}/${arch}. Set JAVA to a Java 25+ executable.`);
  return { os, architecture, extension: platform === 'win32' ? 'zip' : 'tar.gz' };
}

async function fileHash(file, algorithm = 'sha256') {
  const digest = createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function downloadFile(url, destination, { hash, algorithm = 'sha256', fetchImpl = fetch } = {}) {
  if (hash && fs.existsSync(destination) && await fileHash(destination, algorithm) === hash.toLowerCase()) return { file: destination, hash: hash.toLowerCase(), algorithm };
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(300000), headers: { 'User-Agent': 'jevcraft-local-server-setup' } });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.part`, digest = createHash(algorithm);
  try {
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, done) { digest.update(chunk); done(null, chunk); } }), fs.createWriteStream(temporary, { flags: 'wx' }));
    const actual = digest.digest('hex');
    if (hash && actual !== hash.toLowerCase()) throw new Error(`Checksum mismatch for ${url}: expected ${hash}, received ${actual}`);
    fs.renameSync(temporary, destination);
    return { file: destination, hash: actual, algorithm };
  } finally { fs.rmSync(temporary, { force: true }); }
}

async function metadata(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60000), headers: { 'User-Agent': 'jevcraft-local-server-setup' } });
  if (!response.ok) throw new Error(`Metadata request failed (${response.status}): ${url}`);
  return response.json();
}

function findJava(directory, executable = process.platform === 'win32' ? 'java.exe' : 'java') {
  if (!fs.existsSync(directory)) return null;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === executable && path.basename(directory) === 'bin') return file;
    if (entry.isDirectory()) { const found = findJava(file, executable); if (found) return found; }
  }
  return null;
}

function extractWindowsJdk(archive, directory) {
  const entries = unzipSync(archive), root = path.resolve(directory);
  const targets = Object.keys(entries).map(name => {
    const normalized = name.replaceAll('\\', '/');
    if (normalized.startsWith('/') || normalized.includes(':') || normalized.includes('\0') || normalized.split('/').some(part => part === '..')) throw new Error(`Unsafe archive path outside JDK directory: ${name}`);
    const target = path.resolve(root, normalized);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`Unsafe archive path: ${name}`);
    for (let current = target; current.startsWith(root); current = path.dirname(current)) {
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Unsafe archive path through a link: ${name}`);
      if (current === root) break;
    }
    return { name, target, directory: normalized.endsWith('/') };
  });
  fs.mkdirSync(root, { recursive: true });
  for (const entry of targets) {
    if (entry.directory) fs.mkdirSync(entry.target, { recursive: true });
    else { fs.mkdirSync(path.dirname(entry.target), { recursive: true }); fs.writeFileSync(entry.target, entries[entry.name]); }
  }
  const java = findJava(root, 'java.exe');
  if (!java) throw new Error('Downloaded Windows JDK does not contain bin/java.exe');
  return java;
}

function javaVersion(command, run = spawnSync) {
  try {
    const result = run(command, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const match = `${result.stdout || ''}\n${result.stderr || ''}`.match(/(?:openjdk|java) version "(\d+)(?:[.\-"])/i);
    return result.status === 0 && match ? Number(match[1]) : 0;
  } catch (_) { return 0; }
}

function writeMissing(file, text) {
  try { fs.writeFileSync(file, text, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
}

function acceptedEula(directory) {
  try { return /^\s*eula\s*=\s*true\s*$/m.test(fs.readFileSync(path.join(directory, 'eula.txt'), 'utf8')); } catch (_) { return false; }
}

function prepareServer(directory, { java, jar, port, arena = false, acceptEula = false } = {}) {
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('Server port must be an integer from 1 to 65535');
  if (!acceptEula && !acceptedEula(directory)) throw new Error('Minecraft EULA acceptance required. Read https://aka.ms/MinecraftEULA and pass --accept-eula to accept.');
  fs.mkdirSync(path.join(directory, 'logs'), { recursive: true });
  if (acceptEula && !acceptedEula(directory)) fs.writeFileSync(path.join(directory, 'eula.txt'), 'eula=true\n');
  const properties = [`server-port=${port}`, 'online-mode=false', 'difficulty=normal', 'gamemode=survival', 'spawn-protection=0', `level-name=${arena ? 'arena' : 'world'}`,
    ...(arena ? ['level-type=minecraft\\:flat', 'generate-structures=false'] : []), `motd=Jev ${arena ? 'arena' : 'trial'} ${port}`, 'enable-command-block=false', 'allow-flight=true',
    ...(arena ? ['view-distance=6', 'simulation-distance=6', 'pause-when-empty-seconds=0', 'max-tick-time=60000'] : [])];
  writeMissing(path.join(directory, 'server.properties'), `${properties.join('\n')}\n`);
  writeMissing(path.join(directory, 'server-launch.json'), `${JSON.stringify({ java, jar }, null, 2)}\n`);
  return directory;
}

async function ensureTools({ root = path.join(__dirname, '../..'), tools, version = VERSION, vanilla = false, env = process.env, platform = process.platform, arch = process.arch, fetchImpl = fetch, javaRun = spawnSync, runFile = execFileSync, say = console.log } = {}) {
  if (!/^[\w.+-]+$/.test(version)) throw new Error('Invalid Minecraft version');
  tools = path.resolve(tools || env.JEV_TOOLS || path.join(root, '.tools'));
  if (env.JAVA && javaVersion(env.JAVA, javaRun) < 25) throw new Error(`JAVA must point to Java 25 or newer: ${env.JAVA}`);
  const target = platformTarget(platform, arch), manifestFile = path.join(tools, `manifest-${version}.json`);
  let cached;
  try { cached = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (_) {}
  if (cached?.version === version && cached.platform === platform && cached.arch === arch && (vanilla || cached.fabricJar && cached.mods?.length === MODS.length)) {
    const artifacts = cached.artifacts || [];
    if (artifacts.length && (await Promise.all(artifacts.map(async artifact => fs.existsSync(artifact.file) && await fileHash(artifact.file, artifact.algorithm) === artifact.hash))).every(Boolean)) {
      const java = env.JAVA || cached.java;
      if (javaVersion(java, javaRun) >= 25) return { ...cached, java };
    }
  }
  fs.mkdirSync(tools, { recursive: true });
  let java = env.JAVA || (javaVersion('java', javaRun) >= 25 ? 'java' : null);
  const artifacts = [];
  if (!java) {
    const installed = findJava(path.join(tools, 'jdk25'), platform === 'win32' ? 'java.exe' : 'java');
    if (installed && javaVersion(installed, javaRun) >= 25) java = installed;
    else {
      say(`Preparing project-local Java 25 for ${target.os}/${target.architecture}`);
      const query = new URLSearchParams({ architecture: target.architecture, os: target.os, image_type: 'jdk', jvm_impl: 'hotspot', heap_size: 'normal', vendor: 'eclipse' });
      const assets = await metadata(`https://api.adoptium.net/v3/assets/latest/25/hotspot?${query}`, fetchImpl);
      const pkg = assets[0]?.binary?.package;
      if (!pkg?.link || !pkg.checksum) throw new Error(`No verified Java 25 package for ${target.os}/${target.architecture}`);
      const archive = path.join(tools, `jdk25.${target.extension}`);
      await downloadFile(pkg.link, archive, { hash: pkg.checksum, fetchImpl });
      const stage = fs.mkdtempSync(path.join(tools, 'jdk25-extract-'));
      try {
        if (platform === 'win32') extractWindowsJdk(fs.readFileSync(archive), stage);
        else runFile('tar', ['-xzf', archive, '-C', stage], { stdio: 'inherit' });
        const extracted = findJava(stage, platform === 'win32' ? 'java.exe' : 'java');
        if (!extracted || javaVersion(extracted, javaRun) < 25) throw new Error('Downloaded JDK could not run Java 25');
        const relative = path.relative(stage, extracted), destination = path.join(tools, 'jdk25');
        if (fs.existsSync(destination)) throw new Error(`Existing Java directory is incompatible: ${destination}. Rename it and retry setup.`);
        fs.renameSync(stage, destination);
        java = path.join(destination, relative);
      } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    }
  }
  const manifest = await metadata('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', fetchImpl);
  const entry = manifest.versions.find(item => item.id === version);
  if (!entry) throw new Error(`Minecraft ${version} was not found in Mojang's manifest`);
  const minecraft = await metadata(entry.url, fetchImpl), server = minecraft.downloads?.server;
  if (!server?.url || !server.sha1) throw new Error(`No verified server download for Minecraft ${version}`);
  const serverJar = path.join(tools, `server-${version}.jar`);
  artifacts.push(await downloadFile(server.url, serverJar, { hash: server.sha1, algorithm: 'sha1', fetchImpl }));
  let fabricJar = null;
  const mods = [];
  if (!vanilla) {
    const [installers, loaders] = await Promise.all([metadata('https://meta.fabricmc.net/v2/versions/installer', fetchImpl), metadata(`https://meta.fabricmc.net/v2/versions/loader/${version}`, fetchImpl)]);
    const installer = installers.find(item => item.stable !== false)?.version, loader = loaders.find(item => item.loader?.stable)?.loader?.version || loaders[0]?.loader?.version;
    if (!installer || !loader) throw new Error(`No compatible Fabric installer/loader for Minecraft ${version}`);
    fabricJar = path.join(tools, `fabric-server-${version}.jar`);
    const previous = cached?.artifacts?.find(item => item.file === fabricJar);
    artifacts.push(await downloadFile(`https://meta.fabricmc.net/v2/versions/loader/${version}/${loader}/${installer}/server/jar`, fabricJar, { hash: previous?.hash, algorithm: 'sha256', fetchImpl }));
    for (const project of MODS) {
      const versions = await metadata(`https://api.modrinth.com/v2/project/${project}/version`, fetchImpl);
      const compatible = versions.find(item => item.game_versions?.includes(version) && item.loaders?.includes('fabric'));
      const mod = compatible?.files?.find(item => item.primary);
      const algorithm = mod?.hashes?.sha512 ? 'sha512' : 'sha1', hash = mod?.hashes?.[algorithm];
      if (!mod?.url || !hash || !mod.filename || path.basename(mod.filename) !== mod.filename || /[\\/:]/.test(mod.filename)) throw new Error(`No verified compatible Fabric file for Modrinth project ${project}, Minecraft ${version}`);
      const artifact = await downloadFile(mod.url, path.join(tools, 'mods', mod.filename), { hash, algorithm, fetchImpl });
      artifacts.push(artifact); mods.push(artifact);
    }
  }
  const result = { version, platform, arch, java, serverJar, fabricJar, mods, artifacts };
  const temporary = `${manifestFile}.part`;
  fs.writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`);
  fs.renameSync(temporary, manifestFile);
  return result;
}

module.exports = { VERSION, MODS, platformTarget, downloadFile, extractWindowsJdk, javaVersion, prepareServer, acceptedEula, ensureTools, writeMissing };
