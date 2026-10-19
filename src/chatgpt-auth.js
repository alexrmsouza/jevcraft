'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { setTimeout: pause } = require('node:timers/promises');

const RESOURCE = 'https://api.openai.com/v1';
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', DIRECT_SCOPE];
const DEFAULT_DIRECTORY = path.resolve(__dirname, '../.bot-state/chatgpt');
const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
if ($request.operation -eq 'protect') {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($request.data)
  [Console]::Out.Write([Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)))
} elseif ($request.operation -eq 'unprotect') {
  $bytes = [Convert]::FromBase64String($request.data)
  [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)))
} else { throw 'Invalid credential protection operation' }
`;

function protectWindows(operation, data, run = spawnSync) {
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT], {
    input: JSON.stringify({ operation, data }), encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('Windows credential protection failed. Use the same Windows account that saved this ChatGPT session.');
  return result.stdout.trim();
}

function createAuth({ directory = DEFAULT_DIRECTORY, fetchImpl = fetch, platform = process.platform, dpapi = protectWindows, issuer = 'https://auth.openai.com', now = Date.now, lockTimeoutMs = 30000 } = {}) {
  directory = path.resolve(directory);
  const credentialsFile = path.join(directory, 'credentials.json'), hostFile = path.join(directory, 'host.json'), lockFile = path.join(directory, 'session.lock');
  const cancelled = () => new Error('ChatGPT sign-in was cancelled.');
  const checkActive = signal => { if (signal?.aborted) throw cancelled(); };
  const privateDirectory = () => { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); if (process.platform !== 'win32') fs.chmodSync(directory, 0o700); };
  const readHost = () => {
    try { const value = JSON.parse(fs.readFileSync(hostFile, 'utf8')).ext_agent_host_id; if (!/^urn:uuid:[\da-f-]{36}$/i.test(value)) throw new Error('Invalid ChatGPT host ID'); return value; }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('ChatGPT host registration is unreadable. Preserve it before repairing local authentication.'); }
  };
  const hostId = () => {
    privateDirectory();
    const saved = readHost(); if (saved) return saved;
    const value = `urn:uuid:${randomUUID()}`;
    try { fs.writeFileSync(hostFile, `${JSON.stringify({ ext_agent_host_id: value })}\n`, { flag: 'wx', mode: 0o600 }); return value; }
    catch (error) { if (error.code === 'EEXIST') return readHost(); throw error; }
  };
  async function readRecord() {
    let envelope;
    try { envelope = JSON.parse(fs.readFileSync(credentialsFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('Saved ChatGPT credentials are unreadable.'); }
    try {
      if (platform === 'win32') {
        if (envelope.protection !== 'dpapi-current-user' || typeof envelope.data !== 'string') throw new Error('Unprotected credentials');
        return JSON.parse(await dpapi('unprotect', envelope.data));
      }
      if (envelope.protection !== 'owner-only' || !envelope.record) throw new Error('Invalid credential format');
      if (process.platform !== 'win32' && (fs.statSync(credentialsFile).mode & 0o077)) throw new Error('Credential file is readable by other users');
      return envelope.record;
    } catch (_) { throw new Error('Cannot unlock saved ChatGPT credentials with this account and storage protection.'); }
  }
  async function writeRecord(record, { signal } = {}) {
    checkActive(signal);
    privateDirectory();
    const envelope = platform === 'win32' ? { version: 1, protection: 'dpapi-current-user', data: await dpapi('protect', JSON.stringify(record)) }
      : { version: 1, protection: 'owner-only', record };
    checkActive(signal);
    const temporary = `${credentialsFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { flag: 'wx', mode: 0o600 });
      checkActive(signal);
      fs.renameSync(temporary, credentialsFile);
      if (process.platform !== 'win32') fs.chmodSync(credentialsFile, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  const lockRecord = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };
  const ownerAlive = pid => { if (!Number.isInteger(pid) || pid <= 0) return true; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
  const releaseOwned = (file, owner) => { if (lockRecord(file)?.owner === owner) fs.rmSync(file, { force: true }); };
  function recoverStale() {
    const recovery = `${lockFile}.recovery`, owner = randomUUID();
    try { fs.writeFileSync(recovery, JSON.stringify({ pid: process.pid, owner }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    try {
      // Re-read only after acquiring the recovery guard: an earlier snapshot
      // can refer to a dead owner whose replacement is already refreshing.
      const current = lockRecord(lockFile);
      if (current && !ownerAlive(current.pid)) { fs.rmSync(lockFile, { force: true }); return true; }
      return false;
    } finally { releaseOwned(recovery, owner); }
  }
  async function withLock(action, { signal } = {}) {
    privateDirectory();
    const deadline = Date.now() + lockTimeoutMs, owner = randomUUID();
    while (true) {
      checkActive(signal);
      try { fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, owner }), { flag: 'wx', mode: 0o600 }); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const previous = lockRecord(lockFile);
          if (previous && !ownerAlive(previous.pid) && recoverStale()) continue;
        } catch (_) { /* Another process may still be writing its lock. */ }
        if (Date.now() >= deadline) throw new Error('Another JevCraft ChatGPT sign-in or refresh is running. Retry after it finishes.');
        await pause(50);
      }
    }
    try { checkActive(signal); return await action(); } finally { releaseOwned(lockFile, owner); }
  }
  async function jsonRequest(url, options = {}) {
    checkActive(options.signal);
    const requestSignal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
    let response;
    try { response = await fetchImpl(url, { ...options, signal: requestSignal }); }
    catch (_) { checkActive(options.signal); throw new Error('ChatGPT authentication request failed. Check the network connection and retry.'); }
    checkActive(options.signal);
    let value; try { value = await response.json(); } catch (_) { value = {}; }
    checkActive(options.signal);
    if (!response.ok) {
      const code = /^[a-z][a-z0-9_]*$/i.test(value.error) ? value.error : `HTTP ${response.status}`;
      throw new Error(`ChatGPT authentication failed (${code}). Sign in again if the authorization code or session expired.`);
    }
    return value;
  }
  async function discovery(signal) {
    const config = await jsonRequest(`${issuer}/.well-known/openid-configuration`, { signal });
    if (config.issuer !== issuer || !config.jwks_uri || !config.authorization_endpoint || !config.token_endpoint) throw new Error('ChatGPT OpenID discovery returned an invalid issuer or endpoints.');
    return config;
  }
  const validClient = value => typeof value === 'string' && value !== 'dynamic_agent_client' && /^[A-Za-z0-9._:-]{1,512}$/.test(value);
  async function verifyIdentity(idToken, clientId, config, { nonce, subject, signal } = {}) {
    checkActive(signal);
    if (typeof idToken !== 'string' || !idToken) throw new Error('ChatGPT did not return an ID token.');
    const jose = await import('jose');
    const jwks = await jsonRequest(config.jwks_uri, { signal });
    let payload;
    try {
      ({ payload } = await jose.jwtVerify(idToken, jose.createLocalJWKSet(jwks), { issuer, audience: clientId, algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp'], currentDate: new Date(now()) }));
    } catch (_) { throw new Error('ChatGPT ID-token signature, issuer, audience or expiry validation failed (possibly expired).'); }
    checkActive(signal);
    if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('ChatGPT ID token has no account identity.');
    if (nonce !== undefined && payload.nonce !== nonce) throw new Error('ChatGPT ID-token nonce validation failed.');
    if (subject && payload.sub !== subject) throw new Error('ChatGPT account identity changed. This registration belongs to the previously selected account.');
    return { issuer, subject: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
  }
  function tokenSession(tokens, registration, host, previous = null) {
    const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : previous?.scopes || [];
    if (!scopes.includes(DIRECT_SCOPE)) throw new Error('ChatGPT plan permission is missing: authorize the chatgpt.tokens.use.direct scope before inference.');
    if (typeof tokens.access_token !== 'string' || !tokens.access_token || !/^Bearer$/i.test(tokens.token_type || '') || !Number.isFinite(Number(tokens.expires_in)) || Number(tokens.expires_in) <= 0) throw new Error('ChatGPT returned an invalid token response.');
    return { ...registration, ext_agent_host_id: host, access_token: tokens.access_token, refresh_token: tokens.refresh_token || previous?.refresh_token || null, id_token: tokens.id_token || previous?.id_token || null,
      token_type: 'Bearer', scopes, expires_in: Number(tokens.expires_in), expires_at: now() + Number(tokens.expires_in) * 1000, saved_at: new Date(now()).toISOString() };
  }
  async function publicStatus() {
    const record = await readRecord(), session = record.session;
    return { signedIn: !!session, registered: !!record.registration?.client_id, hostId: readHost(), account: record.registration?.subject ? { subject: record.registration.subject, email: record.registration.email, client_id: record.registration.client_id } : null,
      expiresAt: session?.expires_at ? new Date(session.expires_at).toISOString() : null, planAuthorized: !!session?.scopes?.includes(DIRECT_SCOPE) };
  }
  async function signIn({ onAuthorize, timeoutMs = 300000, signal } = {}) {
    if (typeof onAuthorize !== 'function') throw new Error('Provide an onAuthorize handler to open the ChatGPT authorization URL.');
    return withLock(async () => {
      checkActive(signal);
      const record = await readRecord(), host = hostId(), config = await discovery(signal);
      checkActive(signal);
      const client = record.registration?.client_id || 'dynamic_agent_client';
      if (client !== 'dynamic_agent_client' && !validClient(client)) throw new Error('Saved ChatGPT client registration is invalid.');
      const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
      let complete, fail, timer;
      const callback = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
      // Attach a handler before opening the browser so timeout/abort cannot go unhandled.
      callback.catch(() => {});
      let browserResult = { status: 200, message: 'Waiting for ChatGPT authorization.' };
      const server = http.createServer((req, res) => {
        let received;
        try { received = new URL(req.url, 'http://127.0.0.1'); }
        catch (_) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('Malformed authorization request'); return; }
        if (req.method === 'GET' && received.pathname === '/auth/result') {
          res.writeHead(browserResult.status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
          res.end(browserResult.message); return;
        }
        if (req.method !== 'GET' || received.pathname !== '/auth/callback') { res.writeHead(404); res.end('Not found'); return; }
        const returned = received.searchParams.get('state') || '';
        const returnedBytes = Buffer.from(returned), stateBytes = Buffer.from(state);
        const validState = received.searchParams.getAll('state').length === 1 && returnedBytes.length === stateBytes.length && timingSafeEqual(returnedBytes, stateBytes);
        browserResult = validState ? { status: 200, message: 'ChatGPT authorization received. You can close this tab and return to JevCraft.' } : { status: 400, message: 'Invalid authorization state. Return to the original JevCraft sign-in tab.' };
        res.writeHead(303, { Location: '/auth/result', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end();
        if (!validState) return;
        const error = received.searchParams.get('error');
        if (error) { fail(new Error(`ChatGPT authorization was denied or cancelled (${/^[a-z_]+$/.test(error) ? error : 'authorization_error'}).`)); return; }
        if (received.searchParams.getAll('code').length !== 1 || received.searchParams.getAll('client_id').length > 1) { fail(new Error('ChatGPT authorization callback is incomplete.')); return; }
        complete({ code: received.searchParams.get('code'), clientId: received.searchParams.get('client_id') });
      });
      const abort = () => fail(new Error('ChatGPT sign-in was cancelled.'));
      try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
        const authorize = new URL(config.authorization_endpoint);
        authorize.search = new URLSearchParams({ client_id: client, ext_agent_host_id: host, response_type: 'code', redirect_uri: redirectUri, scope: SCOPES.join(' '), resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
        if (client === 'dynamic_agent_client') authorize.searchParams.set('agent_name_hint', 'JevCraft');
        else {
          if (record.session?.id_token) authorize.searchParams.set('id_token_hint', record.session.id_token);
          if (record.registration.email) authorize.searchParams.set('login_hint', record.registration.email);
        }
        const publicUrl = new URL(authorize); publicUrl.searchParams.delete('id_token_hint');
        timer = setTimeout(() => fail(new Error('ChatGPT sign-in timed out. Run login again.')), timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        await onAuthorize(authorize.toString(), { publicUrl: publicUrl.toString(), redirectUri });
        const received = await callback;
        checkActive(signal);
        const issued = received.clientId || (client !== 'dynamic_agent_client' ? client : null);
        if (!validClient(issued) || client !== 'dynamic_agent_client' && issued !== client) throw new Error('ChatGPT returned an invalid or different client registration.');
        if (!received.code) throw new Error('ChatGPT callback has no authorization code.');
        if (client === 'dynamic_agent_client') {
          record.registration = { client_id: issued, issuer, subject: null, email: null };
          await writeRecord(record, { signal });
        }
        checkActive(signal);
        const tokens = await jsonRequest(config.token_endpoint, { signal, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: issued, code: received.code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }) });
        const identity = await verifyIdentity(tokens.id_token, issued, config, { nonce, subject: record.registration?.subject, signal });
        const registration = { ...identity, client_id: issued };
        const session = tokenSession(tokens, registration, host);
        await writeRecord({ registration, session }, { signal });
        return publicStatus();
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      }
    }, { signal });
  }
  async function loadSession() { const record = await readRecord(); return record.session || null; }
  async function getAccessToken() {
    return withLock(async () => {
      const record = await readRecord(), session = record.session;
      if (!session?.scopes?.includes(DIRECT_SCOPE)) throw new Error('Sign in with ChatGPT and authorize plan usage first: node scripts/chatgpt.js login');
      if (session.expires_at > now() + 60000) return session.access_token;
      if (!session.refresh_token) throw new Error('ChatGPT session expired. Run node scripts/chatgpt.js login again.');
      const config = await discovery();
      const tokens = await jsonRequest(config.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: record.registration.client_id, refresh_token: session.refresh_token, resource: RESOURCE }) });
      if (tokens.id_token) await verifyIdentity(tokens.id_token, record.registration.client_id, config, { subject: record.registration.subject });
      const next = tokenSession(tokens, record.registration, hostId(), session);
      await writeRecord({ registration: record.registration, session: next });
      return next.access_token;
    });
  }
  async function logout() {
    return withLock(async () => {
      const record = await readRecord();
      let confirmed = null;
      if (record.session?.refresh_token) {
        confirmed = false;
        for (const delay of [0, 250, 1000]) {
          if (delay) await pause(delay);
          try {
            const config = await discovery();
            if (!config.revocation_endpoint) break;
            const response = await fetchImpl(config.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: record.session.refresh_token, token_type_hint: 'refresh_token', client_id: record.registration.client_id }), signal: AbortSignal.timeout(15000) });
            if (response.status === 200) { confirmed = true; break; }
            if (response.status < 500) break;
          } catch (_) { /* Retry while the renewable session is still available. */ }
        }
      }
      delete record.session; await writeRecord(record);
      return { signedOut: true, remoteRevocationConfirmed: confirmed, ...(confirmed === false ? { warning: 'Local tokens cleared; remote revocation was not confirmed. Disconnect JevCraft in ChatGPT Settings if needed.' } : {}) };
    });
  }
  return { signIn, loadSession, getAccessToken, publicStatus, logout, directory };
}

const defaultAuth = createAuth();
module.exports = { createAuth, protectWindows, DEFAULT_DIRECTORY, RESOURCE, DIRECT_SCOPE, ...defaultAuth };
