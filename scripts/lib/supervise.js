'use strict';
// A trial's bot needs a supervisor (scripts/trials/supervisor.js) or nothing
// starts it again when it quits for a new build: mid-242-bd had none, quit
// at minute 33 and stayed down three hours (note 640). Starting a trial
// starts its port's supervisor when none is running, as retry.sh does.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { isSupervised } = require('./platform');

function ensureSupervisor(port, root, { has = isSupervised, start = defaultStart } = {}) {
  if (has(port, root)) return false;
  start(port, root);
  return true;
}
function defaultStart(port, root) {
  const dir = path.join(root, 'artifacts', 'supervisors');
  fs.mkdirSync(dir, { recursive: true });
  const out = fs.openSync(path.join(dir, `${port}.log`), 'a');
  try { spawn(process.execPath, [path.join(root, 'scripts/trials/supervisor.js'), String(port)], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, out] }).unref(); } finally { fs.closeSync(out); }
}

// The stretches in which a bot left no flight frame: any gap of five
// minutes or more, and the tail to the window's end when the window closed.
function absences(frames, from, to, { gapMs = 5 * 60000, closed = true } = {}) {
  const ts = frames.map(f => f.t).filter(Number.isFinite).sort((a, b) => a - b);
  const out = [];
  let prev = from;
  for (const t of ts) { if (t - prev >= gapMs) out.push({ from: prev, to: t }); prev = t; }
  if (closed && to - prev >= gapMs) out.push({ from: prev, to });
  return out;
}
module.exports = { ensureSupervisor, absences };
