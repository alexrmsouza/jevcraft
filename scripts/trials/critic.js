'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ops = require('../lib/trial-ops');
const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(node scripts/*)', 'Bash(ls:*)', 'PowerShell(node scripts/*)', 'PowerShell(Get-ChildItem:*)'];
async function critique(options = {}) {
  const { root = ops.ROOT, env = process.env, now = Date.now(), spawn = require('cross-spawn') } = options;
  const dir = ops.safePath(root, path.join(root, 'artifacts/critic')); fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(path.join(dir, 'stop'))) return false;
  let file = path.join(dir, `critic-${ops.utc(now).slice(0, 13)}Z.md`); let suffix = 1; while (fs.existsSync(file)) file = path.join(dir, `critic-${ops.utc(now)}-${suffix++}.md`);
  const temp = `${file}.tmp`, fd = fs.openSync(temp, 'wx'); let child;
  try {
    child = spawn(env.CLAUDE_BIN || 'claude', ['-p', '--model', 'claude-opus-5-5', '--allowedTools', ...ALLOWED_TOOLS], { cwd: root, env, windowsHide: true, signal: options.signal, stdio: ['pipe', fd, fd] });
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
    child.stdin.on('error', () => {}); child.stdin.end(ops.read(path.join(root, 'scripts/trials/critic-prompt.md')));
    const code = await done; return { file, code };
  } finally { fs.closeSync(fd); if (fs.existsSync(temp)) fs.renameSync(temp, file); }
}
async function main(argv = process.argv.slice(2), options = {}) {
  if (ops.help(argv, 'critic.js [minutes-between=20] [--once] (CLAUDE_BIN defaults to claude on PATH; artifacts/critic/stop stops the loop)')) return;
  const parsed = ops.options(argv), minutes = Number(parsed.args[0] || 20); if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('minutes-between must be positive');
  return ops.loop(() => critique(options), { ...options, once: parsed.once, every: minutes * 60000 });
}
if (require.main === module) ops.cli(main);
module.exports = { ALLOWED_TOOLS, critique, main };
