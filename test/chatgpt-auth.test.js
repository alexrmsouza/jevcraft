'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

async function fixture(t, options = {}) {
  const jose = await import('jose');
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  const jwk = await jose.exportJWK(publicKey); jwk.kid = 'fixture';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-auth-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const received = [], server = http.createServer(async (req, res) => {
    const body = []; for await (const chunk of req) body.push(chunk);
    const form = new URLSearchParams(Buffer.concat(body).toString());
    received.push({ path: req.url, form });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/.well-known/openid-configuration') return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, revocation_endpoint: `${issuer}/revoke` }));
    if (req.url === '/jwks') { if (options.beforeJwks) await options.beforeJwks(); return res.end(JSON.stringify({ keys: [jwk] })); }
    if (req.url === '/revoke') { res.statusCode = options.revokeFailure ? 503 : 200; return res.end('{}'); }
    if (req.url === '/token') {
      if (options.beforeToken) await options.beforeToken(form);
      if (options.exchangeFailure && form.get('grant_type') === 'authorization_code') { res.statusCode = 400; return res.end('{"error":"invalid_grant"}'); }
      const id = await new jose.SignJWT({ nonce: options.wrongNonce ? 'wrong' : nonce, email: 'fixture@example.invalid' }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setSubject(subject).setIssuer(issuer).setAudience('oaiapp_fixture').setIssuedAt().setExpirationTime(options.expired ? Math.floor(Date.now() / 1000) - 60 : '1h').sign(privateKey);
      res.end(JSON.stringify({ access_token: form.get('grant_type') === 'refresh_token' ? 'refreshed-secret' : 'access-secret', refresh_token: form.get('grant_type') === 'refresh_token' ? 'rotated-secret' : 'refresh-secret', id_token: id, token_type: 'Bearer', expires_in: 3600, scope: options.missingScope ? 'openid profile email' : 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const issuer = `http://127.0.0.1:${server.address().port}`;
  let nonce, subject = 'fixture-subject';
  const auth = require('../src/chatgpt-auth').createAuth({ directory, issuer, platform: 'linux', ...options.authOptions });
  const authorize = async (url, { publicUrl }) => {
    const request = new URL(url), publicRequest = new URL(publicUrl);
    nonce = request.searchParams.get('nonce');
    assert.equal(publicRequest.searchParams.has('id_token_hint'), false);
    const callback = new URL(request.searchParams.get('redirect_uri'));
    assert.equal(callback.hostname, '127.0.0.1');
    assert.equal(callback.pathname, '/auth/callback');
    assert.equal(request.searchParams.get('code_challenge_method'), 'S256');
    callback.searchParams.set('state', request.searchParams.get('state'));
    callback.searchParams.set('code', 'fixture-code');
    callback.searchParams.set('client_id', options.wrongClient ? 'oaiapp_wrong' : 'oaiapp_fixture');
    const result = await fetch(callback);
    assert.equal(result.status, 200);
  };
  return { auth, authorize, directory, received, issuer, setSubject(value) { subject = value; } };
}

test('OAuth starts a loopback listener, verifies signed identity, and exposes only public status', async t => {
  const f = await fixture(t);
  let request;
  const status = await f.auth.signIn({ onAuthorize: async (url, details) => { request = new URL(url); await f.authorize(url, details); } });
  assert.equal(request.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(request.searchParams.get('agent_name_hint'), 'JevCraft');
  assert.match(request.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
  assert.equal(status.signedIn, true);
  assert.equal((await f.auth.loadSession()).subject, 'fixture-subject');
  assert.equal(await f.auth.getAccessToken(), 'access-secret');
  assert.doesNotMatch(JSON.stringify(await f.auth.publicStatus()), /access-secret|refresh-secret|id_token/);
  const exchange = f.received.find(item => item.path === '/token');
  assert.equal(exchange.form.get('client_id'), 'oaiapp_fixture');
  assert.ok(exchange.form.get('code_verifier').length >= 43);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.directory, 'credentials.json')).mode & 0o777, 0o600);
});

test('ID-token nonce, expiry and direct-use scope are mandatory before storing tokens', async t => {
  for (const options of [{ wrongNonce: true }, { expired: true }, { missingScope: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.auth.signIn({ onAuthorize: f.authorize }), /nonce|expired|scope|permission/i);
    assert.equal(await f.auth.loadSession(), null);
  }
});

test('issued client survives invalid_grant and is reused for authorization retry', async t => {
  const f = await fixture(t, { exchangeFailure: true });
  await assert.rejects(f.auth.signIn({ onAuthorize: f.authorize }), /invalid_grant/);
  const status = await f.auth.publicStatus();
  assert.equal(status.registered, true);
  await assert.rejects(f.auth.signIn({ onAuthorize: async (url, details) => { const next = new URL(url); assert.equal(next.searchParams.get('client_id'), 'oaiapp_fixture'); assert.equal(next.searchParams.has('agent_name_hint'), false); await f.authorize(url, details); } }), /invalid_grant/);
});

test('refresh is serialized and rotating tokens are replaced atomically', async t => {
  let now = Date.now();
  const f = await fixture(t, { authOptions: { now: () => now } });
  await f.auth.signIn({ onAuthorize: f.authorize });
  now += 3590000;
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => f.auth.getAccessToken())), Array(5).fill('refreshed-secret'));
  assert.equal(f.received.filter(item => item.form.get('grant_type') === 'refresh_token').length, 1);
  assert.equal((await f.auth.loadSession()).refresh_token, 'rotated-secret');
});

test('logout retains registration and rejects another identity during reauthorization', async t => {
  const f = await fixture(t);
  await f.auth.signIn({ onAuthorize: f.authorize });
  const before = await f.auth.publicStatus();
  const result = await f.auth.logout();
  assert.equal(result.remoteRevocationConfirmed, true);
  assert.equal(await f.auth.loadSession(), null);
  assert.equal((await f.auth.publicStatus()).hostId, before.hostId);
  f.setSubject('another-account');
  await assert.rejects(f.auth.signIn({ onAuthorize: f.authorize }), /identity|account/i);
  assert.equal(await f.auth.loadSession(), null);
});

test('Windows storage uses DPAPI through an injected stdin protector', async t => {
  const operations = [];
  const dpapi = (operation, data) => { operations.push(operation); return operation === 'protect' ? Buffer.from(`protected:${data}`).toString('base64') : Buffer.from(data, 'base64').toString().slice('protected:'.length); };
  const f = await fixture(t, { authOptions: { platform: 'win32', dpapi } });
  await f.auth.signIn({ onAuthorize: f.authorize });
  assert.equal(await f.auth.getAccessToken(), 'access-secret');
  const file = fs.readFileSync(path.join(f.directory, 'credentials.json'), 'utf8');
  assert.doesNotMatch(file, /access-secret|refresh-secret/);
  assert.ok(operations.includes('protect') && operations.includes('unprotect'));
});

test('OAuth redirects callback codes to a clean result URL and ignores invalid state', async t => {
  const f = await fixture(t);
  await f.auth.signIn({ onAuthorize: async (url, details) => {
    const request = new URL(url), invalid = new URL(request.searchParams.get('redirect_uri'));
    invalid.searchParams.set('state', 'invalid'); invalid.searchParams.set('code', 'untrusted-code');
    const rejected = await fetch(invalid);
    assert.equal(rejected.status, 400);
    assert.equal(new URL(rejected.url).pathname, '/auth/result');
    assert.equal(new URL(rejected.url).search, '');
    await f.authorize(url, details);
  } });
});

test('real Windows DPAPI round-trips fictitious Unicode credentials without putting data in argv', t => {
  if (process.platform !== 'win32') return t.skip('Windows DPAPI only');
  const { protectWindows } = require('../src/chatgpt-auth');
  const data = JSON.stringify({ fixture: 'ação 日本語', access_token: 'fictitious-test-only' });
  const protectedValue = protectWindows('protect', data);
  assert.doesNotMatch(protectedValue, /fictitious-test-only/);
  assert.equal(protectWindows('unprotect', protectedValue), data);
});

test('ChatGPT CLI lists account models through the selected auth session', async () => {
  const lines = [], models = [{ slug: 'fixture-model', display_name: 'Fixture model', visibility: 'list' }];
  const result = await require('../scripts/chatgpt').main(['models', '--directory', 'fixture store'], {
    say: line => lines.push(line),
    createAuthImpl: ({ directory }) => { assert.equal(directory, 'fixture store'); return { getAccessToken: async () => 'fixture-secret' }; },
    createResponsesClientImpl: ({ getAccessToken }) => ({ listModels: async () => { assert.equal(await getAccessToken(), 'fixture-secret'); return models; } }),
  });
  assert.deepEqual(result, { models });
  assert.deepEqual(JSON.parse(lines[0]), { models });
  assert.doesNotMatch(lines.join(''), /fixture-secret/);
});

test('ChatGPT CLI verify sends one small request and displays completed public fields only', async () => {
  const lines = []; let requests = 0;
  const result = await require('../scripts/chatgpt').main(['verify', '--model', 'fixture-model'], {
    say: line => lines.push(line), createAuthImpl: () => ({ getAccessToken: async () => 'fixture-secret' }),
    createResponsesClientImpl: ({ getAccessToken, model }) => {
      assert.equal(model, 'fixture-model');
      return { respond: async ({ input }) => {
        requests++; assert.equal(input, 'Reply with exactly: JevCraft connection verified.'); assert.equal(await getAccessToken(), 'fixture-secret');
        return { model, text: 'JevCraft connection verified.', usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13 }, requestId: 'req_fixture', responseId: 'resp_fixture', access_token: 'never-print' };
      } };
    },
  });
  assert.equal(requests, 1);
  assert.deepEqual(Object.keys(result).sort(), ['model', 'text', 'usage', 'requestId', 'responseId'].sort());
  assert.deepEqual(JSON.parse(lines[0]), result);
  assert.doesNotMatch(lines.join(''), /fixture-secret|never-print|access_token/);
});

test('ChatGPT CLI verify does not announce completion after stream failure; status stays local', async () => {
  const { main } = require('../scripts/chatgpt');
  const lines = [];
  await assert.rejects(main(['verify'], { say: line => lines.push(line), createAuthImpl: () => ({ getAccessToken: async () => 'fixture' }), createResponsesClientImpl: () => ({ respond: async () => { throw new Error('stream_interrupted'); } }) }), /stream_interrupted/);
  assert.deepEqual(lines, []);
  await main(['status'], { say: line => lines.push(line), createAuthImpl: () => ({ publicStatus: async () => ({ signedIn: false }) }), createResponsesClientImpl: () => { throw new Error('status must not contact OpenAI'); } });
  assert.deepEqual(JSON.parse(lines[0]), { signedIn: false });
  await assert.rejects(main(['status', '--model', 'fixture']), /--model.*verify/);
});

test('ChatGPT CLI login allows a bounded interactive timeout without changing the auth default', async () => {
  const { main } = require('../scripts/chatgpt');
  const timeouts = [];
  const options = { say() {}, createAuthImpl: () => ({ signIn: async ({ timeoutMs }) => { timeouts.push(timeoutMs); return { signedIn: true }; } }) };
  await main(['login'], options);
  await main(['login', '--timeout-ms', '60000'], options);
  assert.deepEqual(timeouts, [900000, 60000]);
  for (const value of ['0', '-1', 'NaN', '1800001']) await assert.rejects(main(['login', '--timeout-ms', value], options), /timeout/i);
  await assert.rejects(main(['verify', '--timeout-ms', '60000'], options), /--timeout-ms.*login/);
});

test('cancelling after callback during token exchange does not store credentials', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { beforeToken: () => controller.abort() });
  await assert.rejects(f.auth.signIn({ signal: controller.signal, onAuthorize: f.authorize }), /cancel/i);
  assert.equal(await f.auth.loadSession(), null);
});

test('cancelling during signed identity validation does not store credentials', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { beforeJwks: () => controller.abort() });
  await assert.rejects(f.auth.signIn({ signal: controller.signal, onAuthorize: f.authorize }), /cancel/i);
  assert.equal(await f.auth.loadSession(), null);
});

test('cancelling during credential protection prevents the atomic token replacement', async t => {
  const controller = new AbortController();
  const dpapi = async (operation, data) => {
    if (operation === 'unprotect') return Buffer.from(data, 'base64').toString();
    if (data.includes('access-secret')) controller.abort();
    return Buffer.from(data).toString('base64');
  };
  const f = await fixture(t, { authOptions: { platform: 'win32', dpapi } });
  await assert.rejects(f.auth.signIn({ signal: controller.signal, onAuthorize: f.authorize }), /cancel/i);
  assert.equal(await f.auth.loadSession(), null);
});

test('two processes recovering one stale session lock refresh its rotating token only once', async t => {
  const f = await fixture(t, { beforeToken: async form => { if (form.get('grant_type') === 'refresh_token') await new Promise(resolve => setTimeout(resolve, 350)); } });
  await f.auth.signIn({ onAuthorize: f.authorize });
  const recordFile = path.join(f.directory, 'credentials.json');
  const stored = JSON.parse(fs.readFileSync(recordFile, 'utf8')); stored.record.session.expires_at = 0;
  fs.writeFileSync(recordFile, JSON.stringify(stored), { mode: 0o600 });
  fs.writeFileSync(path.join(f.directory, 'session.lock'), JSON.stringify({ pid: 99999999, owner: 'dead-fixture' }));
  const script = `
    const fs=require('node:fs'),path=require('node:path');
    const directory=process.env.FIXTURE_DIRECTORY, id=process.env.FIXTURE_ID, read=fs.readFileSync;
    let intercepted=false;
    fs.readFileSync=function(file,...args){
      const value=read.call(fs,file,...args);
      if(!intercepted && String(file)===path.join(directory,'session.lock')){
        intercepted=true;fs.writeFileSync(path.join(directory,'barrier-'+id),'ready');
        const deadline=Date.now()+10000;
        while(!fs.existsSync(path.join(directory,'barrier-0'))||!fs.existsSync(path.join(directory,'barrier-1'))){if(Date.now()>deadline)throw new Error('fixture barrier timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}
        if(id==='1')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120);
      }
      return value;
    };
    require('./src/chatgpt-auth').createAuth({directory,platform:'linux',issuer:process.env.FIXTURE_ISSUER}).getAccessToken().then(()=>process.stdout.write('ok'),error=>{process.stderr.write(error.message);process.exitCode=1;});
  `;
  const run = id => new Promise((resolve, reject) => {
    const child = require('node:child_process').spawn(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, FIXTURE_DIRECTORY: f.directory, FIXTURE_ISSUER: f.issuer, FIXTURE_ID: String(id) }, windowsHide: true });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('exit', code => resolve({ code, stderr }));
  });
  const results = await Promise.all([run(0), run(1)]);
  assert.deepEqual(results.map(item => item.code), [0, 0], JSON.stringify(results));
  assert.equal(f.received.filter(item => item.form.get('grant_type') === 'refresh_token').length, 1);
  assert.equal(fs.existsSync(path.join(f.directory, 'session.lock')), false);
});

test('a malformed loopback request returns 400 and leaves the valid OAuth callback usable', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-auth-invalid-target-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = `
    const http=require('node:http'),{createAuth}=require('./src/chatgpt-auth');
    const issuer='https://fixture.invalid';
    const fetchImpl=async url=>String(url).endsWith('/.well-known/openid-configuration')?Response.json({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/jwks'}):Response.json({error:'invalid_grant'},{status:400});
    const auth=createAuth({directory:process.env.FIXTURE_DIRECTORY,platform:'linux',issuer,fetchImpl});
    auth.signIn({timeoutMs:5000,onAuthorize:async url=>{
      const request=new URL(url),callback=new URL(request.searchParams.get('redirect_uri'));
      const status=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:callback.port,path:'//['},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});req.once('error',reject);req.end();});
      if(status!==400)throw new Error('Malformed target was not rejected');
      callback.searchParams.set('state',request.searchParams.get('state'));callback.searchParams.set('code','fixture');callback.searchParams.set('client_id','oaiapp_fixture');
      await fetch(callback);
    }}).then(()=>{throw new Error('Expected fixture token rejection');}).catch(error=>{if(!error.message.includes('invalid_grant')){process.stderr.write(error.message);process.exitCode=1;}else process.stdout.write('callback usable');});
  `;
  const result = require('node:child_process').spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000, env: { ...process.env, FIXTURE_DIRECTORY: directory } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'callback usable');
});
