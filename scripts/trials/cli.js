'use strict';
const COMMANDS = ['setup', 'arena-start', 'supervisor', 'checkpoint', 'critic', 'harvest', 'janitor', 'promote', 'retry', 'settle', 'spectate', 'start-fresh', 'start-stage', 'watch'];
async function main(argv = process.argv.slice(2), { say = console.log } = {}) {
  if (!argv.length || ['--help', '-h', 'help'].includes(argv[0])) {
    say(`npm run trial -- <command> [arguments]\nCommands: ${COMMANDS.join(', ')}\nUse <command> --help for arguments. See docs/platforms.md for setup and prerequisites.`);
    return;
  }
  const [command, ...args] = argv;
  if (!COMMANDS.includes(command)) throw new Error(`Unknown trial command: ${command}. Use --help.`);
  return require(`./${command}`).main(args);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { COMMANDS, main };
