'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Resolve lazily: reports and --dry runs do not need an installed client.
function replayDirectory({ explicit, env = process.env, platform = process.platform, home = os.homedir(), required = false } = {}) {
  let directory = explicit || env.REPLAY_RECORDINGS;
  if (!directory) {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const prism = platform === 'win32' ? path.join(appData, 'PrismLauncher')
      : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'PrismLauncher')
        : path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'PrismLauncher');
    const instance = path.join(prism, 'instances', 'Jev Replays');
    const vanilla = platform === 'win32' ? path.join(appData, '.minecraft')
      : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'minecraft') : path.join(home, '.minecraft');
    const roots = platform === 'darwin' ? ['minecraft', '.minecraft'] : ['.minecraft', 'minecraft'];
    const candidates = [...roots.map(root => path.join(instance, root, 'replay_recordings')), path.join(vanilla, 'replay_recordings')];
    directory = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) || candidates[0];
  }
  directory = path.resolve(directory);
  if (required && (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory())) {
    throw new Error(`Replay folder missing: ${directory}. Install ReplayMod and set REPLAY_RECORDINGS to your instance's replay_recordings folder.`);
  }
  return directory;
}

module.exports = { replayDirectory };
