'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { configuredPlanner } = require('../src/planner-config');

test('legacy intake does not load ChatGPT credentials or contact OpenAI', async () => {
  const forbidden = () => { throw Error('Unexpected ChatGPT access'); };
  assert.deepEqual(await configuredPlanner({ env: {}, auth: { getAccessToken: forbidden }, createClient: forbidden }), { provider: 'jev', planner: null });
});

test('ChatGPT startup verifies the configured model before returning a planner', async () => {
  const events = [], signal = new AbortController().signal;
  const getAccessToken = async () => { events.push('auth'); return 'fixture-token'; };
  const result = await configuredPlanner({ env: { JEV_PLANNER: 'chatgpt', CHATGPT_MODEL: 'fixture-second', CHATGPT_TIMEOUT_MS: '12000' },
    auth: { getAccessToken }, signal, createClient: options => {
      assert.equal(options.getAccessToken, getAccessToken); assert.equal(options.model, 'fixture-second'); assert.equal(options.timeoutMs, 12000);
      return { listModels: async options => { assert.equal(options.signal, signal); events.push('catalog'); return [{ slug: 'fixture-first' }, { slug: 'fixture-second' }]; }, respond: async () => {} };
    } });
  assert.deepEqual(events, ['auth', 'catalog']); assert.equal(result.provider, 'chatgpt'); assert.equal(result.model, 'fixture-second'); assert.equal(typeof result.planner.interpret, 'function');
});

test('the account default model follows catalog order without inference at startup', async () => {
  const result = await configuredPlanner({ env: { JEV_PLANNER: 'chatgpt' }, auth: { getAccessToken: async () => 'fixture' },
    createClient: () => ({ listModels: async () => [{ slug: 'account-first' }], respond: () => { throw Error('Unexpected inference'); } }) });
  assert.equal(result.model, 'account-first');
});

test('invalid provider, timeout and unavailable models fail before connecting Minecraft', async () => {
  await assert.rejects(configuredPlanner({ env: { JEV_PLANNER: 'typo' } }), /JEV_PLANNER/);
  for (const timeout of ['0', 'NaN', '300001', '1.5']) await assert.rejects(configuredPlanner({ env: { JEV_PLANNER: 'chatgpt', CHATGPT_TIMEOUT_MS: timeout } }), /CHATGPT_TIMEOUT_MS/);
  for (const models of [[], [{ slug: 'other-model' }]]) await assert.rejects(configuredPlanner({ env: { JEV_PLANNER: 'chatgpt', CHATGPT_MODEL: 'missing' }, auth: { getAccessToken: async () => 'fixture' }, createClient: () => ({ listModels: async () => models }) }), /unavailable/);
});

test('authentication errors stop startup without falling back to Jev intake', async () => {
  const failure = Error('Sign in first');
  await assert.rejects(configuredPlanner({ env: { JEV_PLANNER: 'chatgpt' }, auth: { getAccessToken: async () => { throw failure; } }, createClient: () => { throw Error('Unexpected catalog'); } }), error => error === failure);
});

test('invalid chat mode fails before authentication or connecting Minecraft', async () => {
  await assert.rejects(configuredPlanner({ env: { JEV_PLANNER: 'chatgpt', JEV_CHAT_MODE: 'typo' },
    auth: { getAccessToken: () => { throw Error('Unexpected authentication'); } } }), /JEV_CHAT_MODE/);
});
