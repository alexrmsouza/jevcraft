'use strict';
// Static checks supplement the native integration tests; they never run a bot.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

function sourceProblems(file, source) {
  if (file === 'scripts/check-portability.js') return [];
  const problems = [];
  if (/\bexecSync\s*\(|(?<!\.)\bexec\s*\(\s*['"`]/.test(source)) problems.push('use execFile/spawn with an argument array instead of shell command strings');
  if (file !== 'src/platform.js' && /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*['"](?:sh|bash|lsof|pgrep|pkill|mkfifo|nice|zip|unzip)['"]/.test(source)) problems.push('Unix subprocess outside the platform adapter');
  if (/\b(?:writeFileSync|appendFileSync)\s*\(\s*(?:consolePath|CONSOLE)\s*,/.test(source) && file !== 'scripts/lib/server.js') problems.push('server commands must use the portable console transport');
  return problems.map(problem => `${file}: ${problem}`);
}

function check(root = ROOT) {
  const problems = [], files = [];
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  for (const directory of ['src', 'scripts', 'test']) walk(path.join(root, directory));
  for (const file of fs.readdirSync(root)) if (file.endsWith('.js')) files.push(path.join(root, file));
  let javascript = 0, shell = 0;
  for (const absolute of files) {
    const file = path.relative(root, absolute).split(path.sep).join('/');
    if (file.endsWith('.js')) {
      javascript++;
      const source = fs.readFileSync(absolute, 'utf8').replace(/^#![^\n]*\n/, '');
      try { new vm.Script(Module.wrap(source), { filename: file }); } catch (error) { problems.push(`${file}: ${error.message}`); }
      if (!file.startsWith('test/')) problems.push(...sourceProblems(file, source));
    } else if (file.endsWith('.sh')) {
      shell++;
      const name = path.basename(file, '.sh');
      const executable = fs.readFileSync(absolute, 'utf8').split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'));
      if (executable.length !== 1 || executable[0] !== `exec node "$(dirname "$0")/${name}.js" "$@"` || !fs.existsSync(absolute.replace(/\.sh$/, '.js'))) problems.push(`${file}: shell entrypoints must delegate to a Node entrypoint`);
    }
  }
  const tracked = execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const names = new Map();
  for (const record of tracked.split('\0').filter(Boolean)) {
    const [header, file] = record.split('\t');
    if (!file) continue;
    const previous = names.get(file.toLowerCase());
    if (previous && previous !== file) problems.push(`${file}: case collision with ${previous}`);
    names.set(file.toLowerCase(), file);
    if (file.split('/').some(part => /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) problems.push(`${file}: filename cannot be checked out on Windows`);
    if (header.startsWith('120000 ')) {
      const target = execFileSync('git', ['show', `:${file}`], { cwd: root, encoding: 'utf8' }).trim();
      if (path.posix.isAbsolute(target) || path.win32.isAbsolute(target)) problems.push(`${file}: tracked absolute symlink`);
    }
  }
  return { javascript, shell, problems };
}

function main() {
  const result = check();
  console.log(`Checked ${result.javascript} JavaScript files, ${result.shell} shell wrappers and tracked Windows filenames.`);
  if (result.problems.length) { console.error(result.problems.join('\n')); process.exitCode = 1; }
}
if (require.main === module) main();
module.exports = { sourceProblems, check, main };
