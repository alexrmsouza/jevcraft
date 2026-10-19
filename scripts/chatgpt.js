'use strict';
const { createAuth } = require('../src/chatgpt-auth');
const { createResponsesClient } = require('../src/openai-responses');

async function main(argv = process.argv.slice(2), { say = console.log, createAuthImpl = createAuth, createResponsesClientImpl = createResponsesClient } = {}) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    say('node scripts/chatgpt.js login|status|logout|models|verify [--directory PATH] [--model SLUG] [--timeout-ms MS]\nlogin prints the Continue with ChatGPT URL and waits up to 15 minutes for a local callback. --timeout-ms applies only to login (1000-1800000). Credentials remain protected in .bot-state/chatgpt.\nmodels lists the signed-in account\'s current model catalog. verify sends one small inference request; --model applies only to verify. status reads local information only.');
    return;
  }
  const [command, ...args] = argv;
  let directory, model, timeoutMs;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (!['--directory', '--model', '--timeout-ms'].includes(option) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete argument: ${option}`);
    if (option === '--directory') directory = args[++i];
    else if (option === '--model') model = args[++i];
    else timeoutMs = Number(args[++i]);
  }
  if (model !== undefined && command !== 'verify') throw new Error('--model is supported only by verify.');
  if (timeoutMs !== undefined && command !== 'login') throw new Error('--timeout-ms is supported only by login.');
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000)) throw new Error('The login timeout must be an integer from 1000 to 1800000 milliseconds.');
  if (!['login', 'status', 'logout', 'models', 'verify'].includes(command)) throw new Error('Expected login, status, logout, models or verify. Use --help for usage.');
  const auth = createAuthImpl(directory ? { directory } : {});
  if (command === 'status') return say(JSON.stringify(await auth.publicStatus()));
  if (command === 'logout') return say(JSON.stringify(await auth.logout()));
  if (command === 'models' || command === 'verify') {
    const controller = new AbortController(), abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try {
      const client = createResponsesClientImpl({ getAccessToken: () => auth.getAccessToken(), ...(model ? { model } : {}) });
      const response = command === 'models' ? { models: await client.listModels({ signal: controller.signal }) }
        : await client.respond({ input: 'Reply with exactly: JevCraft connection verified.', signal: controller.signal });
      const result = command === 'models' ? response : { model: response.model, text: response.text, usage: response.usage, requestId: response.requestId, responseId: response.responseId };
      say(JSON.stringify(result));
      return result;
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  }
  if (command === 'login') {
    const controller = new AbortController(), abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try {
      const status = await auth.signIn({ timeoutMs: timeoutMs ?? 900000, signal: controller.signal, onAuthorize: (url, { publicUrl }) => say(JSON.stringify({ action: 'continue-with-chatgpt', url: publicUrl })) });
      say(JSON.stringify(status));
      return status;
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
