import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge, operationKey, toolDefinitions } from './bridge.mjs';

const TOKEN = 'tinyurl-test-token-123456';

function setup({ token = TOKEN } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyurl-test-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const tokenFile = path.join(root, 'token');
  if (token !== null) fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const config = { tokenFile, stateDir, timeoutMs: 100 };
  return { root, stateDir, tokenFile, config };
}

function success(url, alias = 'abc123', domain = 'tinyurl.com') {
  return new Response(JSON.stringify({ code: 0, data: { url, domain, alias, tiny_url: `https://${domain}/${alias}` } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('preserves exact URL and query, sends bearer auth, returns verified destination', async () => {
  const { config, tokenFile } = setup();
  const url = 'https://example.com/path?a=1&b=two%20words&empty=#frag';
  let request;
  const bridge = createBridge(config, {
    fetchImpl: async (input, init) => {
      request = { input, init };
      return success(url, 'launch');
    },
  });
  const output = await bridge.create({ url, alias: 'launch' });
  assert.equal(request.input, 'https://api.tinyurl.com/create');
  assert.equal(request.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(request.init.body), { url, domain: 'tinyurl.com', alias: 'launch' });
  assert.equal(output.status, 'ok');
  assert.equal(output.destination, url);
  assert.equal(output.tinyUrl, 'https://tinyurl.com/launch');
  assert.equal(output.reused, false);
  assert.equal(JSON.stringify(output).includes(fs.readFileSync(tokenFile, 'utf8').trim()), false);
});

test('reports non-2xx explicitly without leaking auth or provider body', async () => {
  const { config } = setup();
  const bridge = createBridge(config, {
    fetchImpl: async () => new Response(JSON.stringify({ code: 2, message: 'Alias already exists', echo: TOKEN }), { status: 409 }),
  });
  await assert.rejects(
    bridge.create({ url: 'https://example.com', alias: 'taken' }),
    error => error.code === 'api_rejected' && /HTTP 409/.test(error.nextAction)
      && !error.nextAction.includes(TOKEN) && !error.message.includes(TOKEN),
  );
});

test('5xx keeps an unknown receipt and is not retried', async () => {
  const { config } = setup();
  let calls = 0;
  const bridge = createBridge(config, {
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ token: TOKEN }), { status: 503 }); },
  });
  await assert.rejects(bridge.create({ url: 'https://example.com/5xx', alias: 'unknown' }), error => error.code === 'write_outcome_unknown' && !JSON.stringify(error).includes(TOKEN));
  await assert.rejects(bridge.create({ url: 'https://example.com/5xx', alias: 'unknown' }), error => error.code === 'write_outcome_unknown');
  assert.equal(calls, 1);
});

test('timeout is an unknown write outcome and is never retried blindly', async () => {
  const { config } = setup();
  let calls = 0;
  const bridge = createBridge(config, {
    fetchImpl: (_input, init) => {
      calls++;
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
      });
    },
  });
  await assert.rejects(bridge.create({ url: 'https://example.com/slow', alias: 'slow' }), error => error.code === 'write_outcome_unknown');
  await assert.rejects(bridge.create({ url: 'https://example.com/slow', alias: 'slow' }), error => error.code === 'write_outcome_unknown');
  assert.equal(calls, 1);
});

test('repeated exact operation reuses durable success', async () => {
  const { config } = setup();
  let calls = 0;
  const bridge = createBridge(config, { fetchImpl: async () => { calls++; return success('https://example.com/reuse', 'reuse'); } });
  const first = await bridge.create({ url: 'https://example.com/reuse', alias: 'reuse' });
  const second = await bridge.create({ url: 'https://example.com/reuse', alias: 'reuse' });
  assert.equal(calls, 1);
  assert.equal(second.reused, true);
  assert.equal(second.tinyUrl, first.tinyUrl);
});

test('concurrent identical operations dedupe to one request', async () => {
  const { config } = setup();
  let calls = 0;
  const bridge = createBridge(config, {
    fetchImpl: async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 30));
      return success('https://example.com/concurrent', 'same');
    },
  });
  const results = await Promise.all(Array.from({ length: 6 }, () => bridge.create({ url: 'https://example.com/concurrent', alias: 'same' })));
  assert.equal(calls, 1);
  assert.ok(results.every(output => output.status === 'ok' && output.alias === 'same'));
});

test('two bridge processes dedupe through the atomic state claim', async () => {
  const { config } = setup();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 60));
    return success('https://example.com/processes', 'processes');
  };
  const first = createBridge(config, { fetchImpl });
  const second = createBridge(config, { fetchImpl });
  const results = await Promise.all([
    first.create({ url: 'https://example.com/processes', alias: 'processes' }),
    second.create({ url: 'https://example.com/processes', alias: 'processes' }),
  ]);
  assert.equal(calls, 1);
  assert.ok(results.every(output => output.status === 'ok' && output.tinyUrl === 'https://tinyurl.com/processes'));
  assert.deepEqual(results.map(output => output.reused).sort(), [false, true]);
});

test('mismatched cached destination is never returned', async () => {
  const { config, stateDir } = setup();
  const url = 'https://example.com/cache';
  let calls = 0;
  const bridge = createBridge(config, { fetchImpl: async () => { calls++; return success(url, 'cache'); } });
  await bridge.create({ url, alias: 'cache' });
  const file = path.join(stateDir, 'operations', `${operationKey({ url, domain: 'tinyurl.com', alias: 'cache' })}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.url = 'https://attacker.example/wrong';
  fs.writeFileSync(file, JSON.stringify(record));
  await assert.rejects(bridge.create({ url, alias: 'cache' }), error => error.code === 'cache_mismatch');
  assert.equal(calls, 1);
});

test('cached short link with query, hash or wrong alias is never returned', async () => {
  const { config, stateDir } = setup();
  const url = 'https://example.com/cache-shape';
  const bridge = createBridge(config, { fetchImpl: async () => success(url, 'shape') });
  await bridge.create({ url, alias: 'shape' });
  const file = path.join(stateDir, 'operations', `${operationKey({ url, domain: 'tinyurl.com', alias: 'shape' })}.json`);
  for (const tinyUrl of ['https://tinyurl.com/shape?x=1', 'https://tinyurl.com/shape#frag', 'https://tinyurl.com/other']) {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.tinyUrl = tinyUrl;
    fs.writeFileSync(file, JSON.stringify(record));
    await assert.rejects(bridge.create({ url, alias: 'shape' }), error => error.code === 'cache_mismatch');
  }
});

test('mismatched returned destination is rejected', async () => {
  const { config } = setup();
  const bridge = createBridge(config, { fetchImpl: async () => success('https://example.com/other', 'wrong') });
  await assert.rejects(bridge.create({ url: 'https://example.com/exact' }), error => error.code === 'destination_mismatch');
});

test('missing credentials are explicit, status is read-only, and no fetch occurs', async () => {
  const { config, stateDir } = setup({ token: null });
  let calls = 0;
  const bridge = createBridge(config, { fetchImpl: async () => { calls++; return success('https://example.com'); } });
  const status = bridge.status();
  assert.equal(status.configured, false);
  assert.equal(status.tokenPresent, false);
  assert.equal(fs.readdirSync(stateDir).length, 0);
  await assert.rejects(bridge.create({ url: 'https://example.com/no-token' }), error => error.code === 'credentials_unavailable');
  assert.equal(calls, 0);
});

test('validates URL, alias and fixed domain before any request', async () => {
  const { config } = setup();
  let calls = 0;
  const bridge = createBridge(config, { fetchImpl: async () => { calls++; return success('https://example.com'); } });
  await assert.rejects(bridge.create({ url: 'ftp://example.com' }), error => error.code === 'invalid_url');
  await assert.rejects(bridge.create({ url: 'https://example.com', alias: 'bad alias' }), error => error.code === 'invalid_alias');
  await assert.rejects(bridge.create({ url: 'https://example.com', domain: 'evil.example' }), error => error.code === 'unsupported_domain');
  assert.equal(calls, 0);
});

test('exposes create, status and the bounded CRUD tools', () => {
  assert.deepEqual(toolDefinitions.map(tool => tool.name).sort(), [
    'tinyurl_analytics_raw_logs',
    'tinyurl_analytics_report',
    'tinyurl_analytics_sharing',
    'tinyurl_analytics_status',
    'tinyurl_archive',
    'tinyurl_bulk_create',
    'tinyurl_bulk_report',
    'tinyurl_bulk_status',
    'tinyurl_change_destination',
    'tinyurl_create',
    'tinyurl_delete',
    'tinyurl_read',
    'tinyurl_set_expiration',
    'tinyurl_status',
    'tinyurl_update',
  ]);
});
