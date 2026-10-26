'use strict';

async function configuredPlanner({ env = process.env, signal, auth, createClient } = {}) {
  require('./communication').createCommunicationPolicy({ host: env.MC_HOST || 'localhost', language: env.JEV_LANGUAGE, narration: env.JEV_NARRATION,
    personality: env.JEV_PERSONALITY, initiative: env.JEV_INITIATIVE });
  const provider = env.JEV_PLANNER || 'jev';
  if (provider === 'jev') return { provider, planner: null };
  if (provider !== 'chatgpt') throw new Error('JEV_PLANNER must be jev or chatgpt.');
  require('./chat-policy').createChatPolicy({ host: env.MC_HOST || 'localhost', mode: env.JEV_CHAT_MODE });
  const timeoutMs = Number(env.CHATGPT_TIMEOUT_MS || 45000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error('CHATGPT_TIMEOUT_MS must be an integer between 1 and 300000.');
  auth ||= require('./chatgpt-auth');
  createClient ||= require('./openai-responses').createResponsesClient;
  await auth.getAccessToken();
  const client = createClient({ getAccessToken: auth.getAccessToken, model: env.CHATGPT_MODEL || undefined, timeoutMs });
  const models = await client.listModels({ signal });
  const model = env.CHATGPT_MODEL || models[0]?.slug;
  if (!model || !models.some(entry => entry.slug === model)) throw new Error('The configured ChatGPT model is unavailable. Run npm run chatgpt:models and choose a listed model.');
  return { provider, model, planner: require('./planner').createPlanner({ client }) };
}

module.exports = { configuredPlanner };
