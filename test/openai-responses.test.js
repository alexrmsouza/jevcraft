'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createResponsesClient } = require('../src/openai-responses');
const catalog = { models: [{ slug: 'account-first', display_name: 'First', visibility: 'list' }, { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' }, { slug: 'account-second', display_name: 'Second', visibility: 'list' }] };
const complete = text => ({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', model: 'account-first', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } });
const event = data => `event: ${data.type}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
function sse(events, { chunks = false, open = false } = {}) {
  const bytes = Buffer.from(events.map(event).join(''));
  return new Response(new ReadableStream({ start(controller) { if (chunks) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3)); } else controller.enqueue(bytes); if (!open) controller.close(); } }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_fixture' } });
}
function fixture(response, options = {}) {
  const calls = [];
  const client = createResponsesClient({ getAccessToken: async () => 'fixture-secret-token', fetchImpl: async (url, init) => { calls.push({ url, init }); return url.endsWith('/models') ? Response.json(catalog) : typeof response === 'function' ? response(init) : response; }, ...options });
  return { client, calls };
}

test('catalog returns only visible account models in server order', async () => {
  const { client, calls } = fixture();
  assert.deepEqual((await client.listModels()).map(model => model.slug), ['account-first', 'account-second']);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer fixture-secret-token');
});

test('account catalogs larger than generated output limits preserve only visible model fields', async () => {
  const largeCatalog = { models: catalog.models.map(model => ({ ...model, description: 'x'.repeat(200000) })) };
  assert.ok(Buffer.byteLength(JSON.stringify(largeCatalog)) > 256 * 1024);
  const client = createResponsesClient({ getAccessToken: async () => 'fixture-token', fetchImpl: async () => Response.json(largeCatalog) });
  assert.deepEqual(await client.listModels(), [catalog.models[0], catalog.models[2]]);
});

test('model catalogs still have a dedicated finite size limit', async () => {
  const client = createResponsesClient({ getAccessToken: async () => 'fixture-token', fetchImpl: async () => Response.json({ models: catalog.models, irrelevant: 'x'.repeat(3 * 1024 * 1024) }) });
  await assert.rejects(client.listModels(), error => error.code === 'response_too_large');
});

test('streamed Unicode and CRLF chunks complete using the first account model with stateless HTTP flags', async () => {
  const { client, calls } = fixture(sse([{ type: 'response.output_text.delta', delta: 'Olá ' }, { type: 'response.output_text.delta', delta: '🌲' }, complete('Olá 🌲')], { chunks: true }));
  const result = await client.respond({ input: 'Reply briefly', instructions: 'Speak Portuguese' });
  assert.deepEqual(result, { text: 'Olá 🌲', model: 'account-first', responseId: 'resp_fixture', requestId: 'req_fixture', usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } });
  const body = JSON.parse(calls[1].init.body);
  assert.equal(calls[1].url, 'https://api.openai.com/v1/responses');
  assert.deepEqual(body, { model: 'account-first', input: [{ role: 'user', content: 'Reply briefly' }], instructions: 'Speak Portuguese', store: false, stream: true });
});

test('an unavailable configured model is rejected without posting an inference', async () => {
  const { client, calls } = fixture(null, { model: 'missing-model' });
  await assert.rejects(client.respond({ input: 'hello' }), error => error.code === 'model_unavailable');
  assert.equal(calls.length, 1);
});

test('schema requests use strict json_schema without unsupported parameters', async () => {
  const schema = { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false };
  const { client, calls } = fixture(sse([complete('{"action":"stop"}')]));
  await client.respond({ input: [{ role: 'developer', content: 'Return a plan' }, { role: 'user', content: 'Stop' }], schema });
  assert.deepEqual(JSON.parse(calls[1].init.body).text, { format: { type: 'json_schema', name: 'response', strict: true, schema } });
  assert.equal(JSON.parse(calls[1].init.body).input[0].role, 'developer');
});

test('a failure after partial text never counts as success or exposes provider messages', async () => {
  const { client, calls } = fixture(sse([{ type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'fixture-secret-token https://secret.example/path' } } }]));
  await assert.rejects(client.respond({ input: 'hello' }), error => error.code === 'subscription_sharing_usage_limit_exceeded' && !/secret|https/.test(error.message));
  assert.equal(calls.filter(call => call.url.endsWith('/responses')).length, 1);
});

for (const [name, events, code] of [
  ['refusal delta', [{ type: 'response.refusal.delta', delta: 'No' }, complete('No')], 'response_refused'],
  ['completed refusal', [{ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] } }], 'response_refused'],
  ['incomplete response', [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }], 'response_incomplete'],
  ['truncated stream', [{ type: 'response.output_text.delta', delta: 'partial' }], 'stream_interrupted'],
  ['empty completed response', [complete('')], 'empty_response'],
]) test(`${name} is an explicit error`, async () => {
  const { client } = fixture(sse(events));
  await assert.rejects(client.respond({ input: 'hello' }), error => error.code === code);
});

test('HTTP and network errors are sanitized and never retried', async () => {
  const { client, calls } = fixture(new Response(JSON.stringify({ error: { code: 'invalid_api_key', message: 'Bearer fixture-secret-token https://secret.example' } }), { status: 401 }));
  await assert.rejects(client.respond({ input: 'private prompt' }), error => error.code === 'invalid_api_key' && !/fixture|private|https|Bearer/.test(error.message));
  assert.equal(calls.length, 2);
  const broken = fixture(() => { throw new Error('failed URL https://secret.example Bearer fixture-secret-token'); });
  await assert.rejects(broken.client.respond({ input: 'hello' }), error => error.code === 'network_error' && !/fixture|https|Bearer/.test(error.message));
});

test('cancellation stops an open stream without success', async () => {
  const controller = new AbortController();
  const { client } = fixture(sse([{ type: 'response.output_text.delta', delta: 'partial' }], { open: true }));
  const pending = client.respond({ input: 'hello', signal: controller.signal });
  setTimeout(() => controller.abort(new Error('private cancellation reason')), 20);
  await assert.rejects(pending, error => error.code === 'request_cancelled' && !error.message.includes('private'));
});

test('a finite deadline ends an open stream without retry', async () => {
  const { client, calls } = fixture(sse([], { open: true }), { timeoutMs: 20 });
  await assert.rejects(client.respond({ input: 'hello' }), error => error.code === 'request_timeout');
  assert.equal(calls.filter(call => call.url.endsWith('/responses')).length, 1);
});

test('system messages and oversized input are rejected before authentication or HTTP', async () => {
  const { client, calls } = fixture(null);
  await assert.rejects(client.respond({ input: [{ role: 'system', content: 'Not supported' }] }), error => error.code === 'invalid_input');
  await assert.rejects(client.respond({ input: 'x'.repeat(70000) }), error => error.code === 'input_too_large');
  assert.equal(calls.length, 0);
});

test('oversized output is rejected even when a completed event follows', async () => {
  const { client } = fixture(sse([{ type: 'response.output_text.delta', delta: 'x'.repeat(300000) }, complete('done')]));
  await assert.rejects(client.respond({ input: 'hello' }), error => error.code === 'output_too_large');
});

test('an empty catalog and a malformed SSE event reject before usable output', async () => {
  const empty = createResponsesClient({ getAccessToken: async () => 'fixture-token', fetchImpl: async () => Response.json({ models: [] }) });
  await assert.rejects(empty.respond({ input: 'hello' }), error => error.code === 'model_unavailable');
  const { client } = fixture(new Response('data: {not-json}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(client.respond({ input: 'hello' }), error => error.code === 'invalid_stream');
});

test('account token changes invalidate the cached model catalog', async () => {
  let token = 'account-one', modelCalls = 0;
  const selected = [];
  const client = createResponsesClient({ getAccessToken: async () => token, fetchImpl: async (url, init) => {
    if (url.endsWith('/models')) { modelCalls++; return Response.json({ models: [{ slug: token, display_name: token, visibility: 'list' }] }); }
    selected.push(JSON.parse(init.body).model);
    return sse([complete('hello')]);
  } });
  await client.respond({ input: 'first' }); token = 'account-two'; await client.respond({ input: 'second' });
  assert.equal(modelCalls, 2);
  assert.deepEqual(selected, ['account-one', 'account-two']);
});

test('pre-cancelled requests do not authenticate, and auth errors hide their cause', async () => {
  let authentications = 0;
  const client = createResponsesClient({ getAccessToken: async () => { authentications++; throw new Error('fixture-secret-token'); } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.respond({ input: 'hello', signal: controller.signal }), error => error.code === 'request_cancelled');
  assert.equal(authentications, 0);
  await assert.rejects(client.listModels(), error => error.code === 'authentication_failed' && !error.message.includes('fixture-secret-token'));
});
