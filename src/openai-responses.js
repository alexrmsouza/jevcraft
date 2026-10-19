'use strict';

const BASE_URL = 'https://api.openai.com/v1';
const MAX_INPUT = 64 * 1024;
const MAX_OUTPUT = 256 * 1024;
const MAX_CATALOG = 2 * 1024 * 1024;
const MAX_STREAM = 2 * 1024 * 1024;

class OpenAIResponsesError extends Error {
  constructor(code, message = 'The OpenAI request did not complete.', { status, requestId } = {}) {
    super(message);
    this.name = 'OpenAIResponsesError';
    this.code = code;
    if (status) this.status = status;
    if (requestId) this.requestId = requestId;
  }
}

const fail = (code, message, details) => new OpenAIResponsesError(code, message, details);
const bytes = text => Buffer.byteLength(text, 'utf8');
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : undefined;
const providerCode = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : 'provider_error';
const requestId = response => safeId(response.headers?.get?.('x-request-id'));

function inputMessages(input) {
  const messages = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
  if (!Array.isArray(messages) || !messages.length || messages.length > 64) throw fail('invalid_input', 'Provide a nonempty text message or message array.');
  return messages.map(message => {
    if (!message || !['user', 'assistant', 'developer'].includes(message.role)) throw fail('invalid_input', 'Only user, assistant and developer text messages are supported.');
    let content = message.content;
    if (Array.isArray(content)) content = content.map(part => {
      if (!part || !['input_text', 'output_text'].includes(part.type) || typeof part.text !== 'string') throw fail('invalid_input', 'Only text message content is supported.');
      return { type: part.type, text: part.text };
    });
    else if (typeof content !== 'string') throw fail('invalid_input', 'Only text message content is supported.');
    return { role: message.role, content };
  });
}

function usageOf(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const result = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) if (Number.isSafeInteger(usage[key]) && usage[key] >= 0) result[key] = usage[key];
  for (const [key, field] of [['input_tokens_details', 'cached_tokens'], ['output_tokens_details', 'reasoning_tokens']]) {
    if (Number.isSafeInteger(usage[key]?.[field]) && usage[key][field] >= 0) result[key] = { [field]: usage[key][field] };
  }
  return Object.keys(result).length ? result : null;
}

async function withDeadline(signal, timeoutMs, operation) {
  if (signal?.aborted) throw fail('request_cancelled', 'The OpenAI request was cancelled.');
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let abortListener;
  const interrupted = new Promise((_, reject) => {
    abortListener = () => reject(fail(timedOut ? 'request_timeout' : 'request_cancelled', timedOut ? 'The OpenAI request timed out.' : 'The OpenAI request was cancelled.'));
    controller.signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    return await Promise.race([operation(controller.signal), interrupted]);
  } catch (error) {
    if (error instanceof OpenAIResponsesError) throw error;
    if (controller.signal.aborted) throw fail(timedOut ? 'request_timeout' : 'request_cancelled', timedOut ? 'The OpenAI request timed out.' : 'The OpenAI request was cancelled.');
    throw fail('network_error', 'The OpenAI connection could not complete.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', abortListener);
    controller.abort();
  }
}

async function readText(response, limit, signal) {
  if (!response.body?.getReader) throw fail('invalid_response', 'OpenAI returned an unreadable response.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let length = 0, text = '';
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw fail('request_cancelled', 'The OpenAI request was cancelled.');
      if (done) return text + decoder.decode();
      length += value.byteLength;
      if (length > limit) throw fail('response_too_large', 'The OpenAI response exceeded the local size limit.');
      text += decoder.decode(value, { stream: true });
    }
  } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}

async function ensureOk(response, signal) {
  if (response.ok) return;
  const status = response.status, id = requestId(response);
  let code = status === 401 ? 'authentication_failed' : status === 403 ? 'access_denied' : status === 429 ? 'rate_limited' : status >= 500 ? 'service_unavailable' : 'http_error';
  try { const body = JSON.parse(await readText(response, MAX_INPUT, signal)); if (body.error?.code) code = providerCode(body.error.code); } catch (_) {}
  throw fail(code, 'OpenAI rejected the request.', { status, requestId: id });
}

function completedText(response) {
  const text = [];
  for (const item of response?.output || []) {
    for (const part of item.content || []) {
      if (part.type === 'refusal') throw fail('response_refused', 'OpenAI declined to provide a response.');
      if (part.type === 'output_text' && typeof part.text === 'string') text.push(part.text);
    }
  }
  return text.join('');
}

async function consumeResponse(response, signal, selectedModel) {
  if (!response.body?.getReader) throw fail('invalid_response', 'OpenAI returned an unreadable stream.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', data = [], eventName = '', total = 0, outputSize = 0, partial = '', completed;
  const id = requestId(response);
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const dispatch = () => {
    if (!data.length) { eventName = ''; return; }
    const raw = data.join('\n'); data = [];
    if (raw === '[DONE]') { eventName = ''; return; }
    let event;
    try { event = JSON.parse(raw); } catch (_) { throw fail('invalid_stream', 'OpenAI returned an invalid stream event.', { requestId: id }); }
    const type = event.type || eventName; eventName = '';
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      outputSize += bytes(event.delta);
      if (outputSize > MAX_OUTPUT) throw fail('output_too_large', 'The generated response exceeded the local size limit.', { requestId: id });
      partial += event.delta;
    } else if (type === 'response.refusal.delta' || type === 'response.refusal.done') {
      throw fail('response_refused', 'OpenAI declined to provide a response.', { requestId: id });
    } else if (type === 'response.failed' || type === 'error') {
      throw fail(providerCode(event.response?.error?.code || event.error?.code || event.code), 'OpenAI could not complete the response.', { requestId: id });
    } else if (type === 'response.incomplete') {
      throw fail('response_incomplete', 'OpenAI returned an incomplete response.', { requestId: id });
    } else if (type === 'response.completed') {
      if (event.response?.status && event.response.status !== 'completed') throw fail('response_incomplete', 'OpenAI returned an incomplete response.', { requestId: id });
      completed = event.response || {};
      const finalText = completedText(completed);
      if (bytes(finalText) > MAX_OUTPUT) throw fail('output_too_large', 'The generated response exceeded the local size limit.', { requestId: id });
    }
  };
  const line = value => {
    if (!value) { dispatch(); return; }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':'), key = colon < 0 ? value : value.slice(0, colon);
    let field = colon < 0 ? '' : value.slice(colon + 1); if (field.startsWith(' ')) field = field.slice(1);
    if (key === 'data') data.push(field);
    else if (key === 'event') eventName = field;
  };
  const drain = () => {
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const value = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1); line(value);
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw fail('request_cancelled', 'The OpenAI request was cancelled.');
      if (done) { buffer += decoder.decode(); drain(); break; }
      total += value.byteLength;
      if (total > MAX_STREAM) throw fail('response_too_large', 'The OpenAI stream exceeded the local size limit.', { requestId: id });
      buffer += decoder.decode(value, { stream: true }); drain();
    }
    if (!completed) throw fail('stream_interrupted', 'The OpenAI stream ended without a completed response.', { requestId: id });
    const text = completedText(completed) || partial;
    if (!text.trim()) throw fail('empty_response', 'OpenAI completed without usable text.', { requestId: id });
    return { text, model: typeof completed.model === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(completed.model) ? completed.model : selectedModel, responseId: safeId(completed.id), requestId: id, usage: usageOf(completed.usage) };
  } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}

function createResponsesClient({ getAccessToken, fetchImpl = fetch, model, timeoutMs = 45000 } = {}) {
  if (typeof getAccessToken !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('An access-token callback and fetch implementation are required.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) throw new TypeError('The request timeout must be between 1 and 300000 milliseconds.');
  let cachedToken, cachedModels;
  const tokenFor = async signal => {
    let token;
    try { token = await getAccessToken(); } catch (_) { throw fail('authentication_failed', 'Sign in to ChatGPT before requesting model access.'); }
    if (signal.aborted) throw fail('request_cancelled', 'The OpenAI request was cancelled.');
    if (typeof token !== 'string' || !token || token.length > 32768 || /\s/.test(token)) throw fail('authentication_failed', 'Sign in to ChatGPT before requesting model access.');
    return token;
  };
  const catalogFor = async (token, signal, refresh = false) => {
    if (!refresh && token === cachedToken && cachedModels) return cachedModels;
    const response = await fetchImpl(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'error', signal });
    await ensureOk(response, signal);
    let result;
    try { result = JSON.parse(await readText(response, MAX_CATALOG, signal)); } catch (error) { if (error instanceof OpenAIResponsesError) throw error; throw fail('invalid_catalog', 'OpenAI returned an invalid model catalog.'); }
    if (!Array.isArray(result.models)) throw fail('invalid_catalog', 'OpenAI returned an invalid model catalog.');
    const models = result.models.filter(item => item?.visibility === 'list' && typeof item.slug === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(item.slug)).map(item => ({ slug: item.slug, display_name: typeof item.display_name === 'string' ? item.display_name.slice(0, 160) : item.slug, visibility: 'list' }));
    cachedToken = token; cachedModels = models;
    return models;
  };
  return {
    listModels: ({ signal } = {}) => withDeadline(signal, timeoutMs, async active => {
      const token = await tokenFor(active);
      return (await catalogFor(token, active, true)).map(item => ({ ...item }));
    }),
    async respond({ input, instructions, schema, signal, model: overrideModel } = {}) {
      const body = { input: inputMessages(input), store: false, stream: true };
      if (instructions !== undefined) { if (typeof instructions !== 'string') throw fail('invalid_input', 'Instructions must be text.'); body.instructions = instructions; }
      if (schema !== undefined) {
        if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw fail('invalid_input', 'A JSON Schema object is required.');
        body.text = { format: { type: 'json_schema', name: 'response', strict: true, schema } };
      }
      let encoded;
      try { encoded = JSON.stringify(body); } catch (_) { throw fail('invalid_input', 'The request must contain serializable text and schema data.'); }
      if (bytes(encoded) > MAX_INPUT) throw fail('input_too_large', 'The request exceeded the local input size limit.');
      return withDeadline(signal, timeoutMs, async active => {
        const token = await tokenFor(active), models = await catalogFor(token, active);
        const selected = overrideModel ?? model ?? models[0]?.slug;
        if (!selected || !models.some(item => item.slug === selected)) throw fail('model_unavailable', 'The selected ChatGPT model is unavailable for this account.');
        if (active.aborted) throw fail('request_cancelled', 'The OpenAI request was cancelled.');
        const response = await fetchImpl(`${BASE_URL}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, redirect: 'error', body: JSON.stringify({ model: selected, ...body }), signal: active });
        await ensureOk(response, active);
        return consumeResponse(response, active, selected);
      });
    },
  };
}

module.exports = { createResponsesClient, OpenAIResponsesError };
