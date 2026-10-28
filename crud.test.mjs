import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge, operationKey, toolDefinitions } from './bridge.mjs';

const TOKEN = 'tinyurl-test-token-123456';
const BASE = 'https://api.tinyurl.com';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyurl-crud-test-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const tokenFile = path.join(root, 'token');
  fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  return { root, stateDir, tokenFile, config: { tokenFile, stateDir, timeoutMs: 150 } };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const aliasData = (alias = 'launch', url = 'https://example.com/launch') => ({
  domain: 'tinyurl.com',
  alias,
  deleted: false,
  archived: false,
  tags: ['one'],
  analytics: { enabled: true, public: false },
  tiny_url: `https://tinyurl.com/${alias}`,
  created_at: '2024-01-01T00:00:00+00:00',
  expires_at: null,
  url,
});

const readOk = data => json({ code: 0, data });
const createOk = data => json({ code: 0, data });

test('exposes the documented CRUD tools and preserves create/status', () => {
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

test('read uses GET /alias/tinyurl.com/{alias} and returns verified schema fields', async () => {
  const { config } = setup();
  let request;
  const bridge = createBridge(config, {
    fetchImpl: async (input, init) => {
      request = { input, init };
      return readOk(aliasData('launch'));
    },
  });
  const output = await bridge.read({ alias: 'launch' });
  assert.equal(request.input, `${BASE}/alias/tinyurl.com/launch`);
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.body, undefined);
  assert.equal(request.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(output.status, 'ok');
  assert.equal(output.destination, 'https://example.com/launch');
  assert.equal(output.tinyUrl, 'https://tinyurl.com/launch');
  assert.equal(output.analytics.enabled, true);
  assert.equal(JSON.stringify(output).includes(TOKEN), false);
});

test('update uses PATCH /update with documented fields and invalidates the create receipt', async () => {
  const { config, stateDir } = setup();
  const url = 'https://example.com/launch';
  const requests = [];
  const bridge = createBridge(config, {
    fetchImpl: async (input, init) => {
      requests.push({ input, init });
      if (init.method === 'POST') return createOk({ url, domain: 'tinyurl.com', alias: 'launch', tiny_url: 'https://tinyurl.com/launch' });
      if (init.method === 'PATCH') return readOk(aliasData('renamed', url));
      throw new Error(`unexpected ${init.method}`);
    },
  });
  await bridge.create({ url, alias: 'launch' });
  const updated = await bridge.update({
    alias: 'launch',
    new_alias: 'renamed',
    new_stats: false,
    new_tags: ['release'],
    new_expires_at: null,
    new_description: 'Release link',
  });
  assert.equal(requests[1].input, `${BASE}/update`);
  assert.equal(requests[1].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    domain: 'tinyurl.com',
    alias: 'launch',
    new_alias: 'renamed',
    new_stats: false,
    new_tags: ['release'],
    new_expires_at: null,
    new_description: 'Release link',
  });
  assert.equal(updated.alias, 'renamed');
  assert.equal(updated.tinyUrl, 'https://tinyurl.com/renamed');

  const file = path.join(stateDir, 'operations', `${operationKey({ url, domain: 'tinyurl.com', alias: 'launch' })}.json`);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'stale');

  await bridge.create({ url, alias: 'launch' });
  assert.equal(requests.filter(request => request.init.method === 'POST').length, 2);
});

test('change destination uses PATCH /change and never reuses the old destination receipt', async () => {
  const { config } = setup();
  const oldUrl = 'https://example.com/old';
  const newUrl = 'https://example.com/new?x=1';
  const requests = [];
  const bridge = createBridge(config, {
    fetchImpl: async (input, init) => {
      requests.push({ input, init });
      if (init.method === 'POST' && requests.filter(request => request.init.method === 'POST').length === 1) {
        return createOk({ url: oldUrl, domain: 'tinyurl.com', alias: 'moving', tiny_url: 'https://tinyurl.com/moving' });
      }
      if (init.method === 'POST') return json({ code: 5, data: [], errors: ['Alias already exists'] }, 422);
      if (init.method === 'PATCH') return readOk({ url: newUrl });
      throw new Error('unexpected');
    },
  });
  await bridge.create({ url: oldUrl, alias: 'moving' });
  const changed = await bridge.changeDestination({ alias: 'moving', url: newUrl });
  assert.equal(requests[1].input, `${BASE}/change`);
  assert.equal(requests[1].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(requests[1].init.body), { domain: 'tinyurl.com', alias: 'moving', url: newUrl });
  assert.equal(changed.destination, newUrl);
  await assert.rejects(bridge.create({ url: oldUrl, alias: 'moving' }), error => error.code === 'api_rejected');
  assert.equal(requests.filter(request => request.init.method === 'POST').length, 2);
});

test('delete uses DELETE /alias/tinyurl.com/{alias}, invalidates the receipt and permits a fresh create', async () => {
  const { config, stateDir } = setup();
  const url = 'https://example.com/dead';
  const requests = [];
  const bridge = createBridge(config, {
    fetchImpl: async (input, init) => {
      requests.push({ input, init });
      if (init.method === 'DELETE') return readOk(aliasData('dead', url));
      return createOk({ url, domain: 'tinyurl.com', alias: 'dead', tiny_url: 'https://tinyurl.com/dead' });
    },
  });
  await bridge.create({ url, alias: 'dead' });
  const deleted = await bridge.delete({ alias: 'dead' });
  assert.equal(requests[1].input, `${BASE}/alias/tinyurl.com/dead`);
  assert.equal(requests[1].init.method, 'DELETE');
  assert.equal(deleted.action, 'deleted');
  const file = path.join(stateDir, 'operations', `${operationKey({ url, domain: 'tinyurl.com', alias: 'dead' })}.json`);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'stale');
  await bridge.create({ url, alias: 'dead' });
  assert.equal(requests.filter(request => request.init.method === 'POST').length, 2);
});

test('concurrent create and delete serialize, leaving no reusable pre-delete receipt', async () => {
  const { config, stateDir } = setup();
  const url = 'https://example.com/race';
  let releaseCreate;
  const gate = new Promise(resolve => { releaseCreate = resolve; });
  const methods = [];
  const bridge = createBridge(config, {
    fetchImpl: async (_input, init) => {
      methods.push(init.method);
      if (init.method === 'POST' && methods.length === 1) await gate;
      if (init.method === 'DELETE') return readOk(aliasData('race', url));
      return createOk({ url, domain: 'tinyurl.com', alias: 'race', tiny_url: 'https://tinyurl.com/race' });
    },
  });
  const creating = bridge.create({ url, alias: 'race' });
  await new Promise(resolve => setTimeout(resolve, 20));
  const deleting = bridge.delete({ alias: 'race' });
  releaseCreate();
  await Promise.all([creating, deleting]);
  const file = path.join(stateDir, 'operations', `${operationKey({ url, domain: 'tinyurl.com', alias: 'race' })}.json`);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'stale');
  await bridge.create({ url, alias: 'race' });
  assert.deepEqual(methods, ['POST', 'DELETE', 'POST']);
});

test('ambiguous update times out once, rejects success and blocks writes until reconciled', async () => {
  const { config, stateDir } = setup();
  const url = 'https://example.com/ambig';
  let posts = 0;
  let patches = 0;
  let bridge;
  bridge = createBridge(config, {
    fetchImpl: async (_input, init) => {
      if (init.method === 'POST') {
        posts++;
        return createOk({ url, domain: 'tinyurl.com', alias: 'ambig', tiny_url: 'https://tinyurl.com/ambig' });
      }
      patches++;
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
      });
    },
  });
  await bridge.create({ url, alias: 'ambig' });
  await assert.rejects(bridge.update({ alias: 'ambig', new_tags: ['x'] }), error =>
    error.code === 'write_outcome_unknown' && !JSON.stringify(error).includes(TOKEN));
  await assert.rejects(bridge.update({ alias: 'ambig', new_tags: ['x'] }), error => error.code === 'write_outcome_unknown');
  assert.equal(patches, 1);
  assert.ok(fs.readdirSync(path.join(stateDir, 'mutations')).some(name => name.endsWith('.json')));
  await assert.rejects(bridge.create({ url, alias: 'ambig' }), error => error.code === 'write_outcome_unknown');
  assert.equal(posts, 1);
});

test('rejects arbitrary fields, arbitrary domains and missing changes before any request', async () => {
  const { config } = setup();
  let calls = 0;
  const bridge = createBridge(config, { fetchImpl: async () => { calls++; return readOk(aliasData()); } });
  await assert.rejects(bridge.read({ alias: 'launch', endpoint: '/urls/available' }), error => error.code === 'invalid_arguments');
  await assert.rejects(bridge.update({ alias: 'launch' }), error => error.code === 'invalid_arguments');
  await assert.rejects(bridge.update({ alias: 'launch', new_alias: 'bad alias' }), error => error.code === 'invalid_alias');
  await assert.rejects(bridge.update({ alias: 'launch', url: 'https://attacker.example' }), error => error.code === 'invalid_arguments');
  await assert.rejects(bridge.delete({ alias: 'launch', domain: 'evil.example' }), error => error.code === 'unsupported_domain');
  await assert.rejects(bridge.changeDestination({ alias: 'launch', url: 'ftp://example.com' }), error => error.code === 'invalid_url');
  await assert.rejects(bridge.read({ alias: 'launch', domain: 'evil.example' }), error => error.code === 'unsupported_domain');
  assert.equal(calls, 0);
});

test('provider error codes are rejected without leaking the provider body or token', async () => {
  const { config } = setup();
  const bridge = createBridge(config, {
    fetchImpl: async () => json({ code: 5, data: [], errors: ['Invalid', TOKEN] }),
  });
  await assert.rejects(bridge.read({ alias: 'launch' }), error =>
    error.code === 'api_rejected' && !JSON.stringify(error).includes(TOKEN) && !JSON.stringify(error).includes('Invalid'));
});

test('rename invalidates receipts for both the old and new alias', async () => {
  const { config, stateDir } = setup();
  const oldUrl = 'https://example.com/old-name';
  const newUrl = 'https://example.com/new-name';
  const bridge = createBridge(config, {
    fetchImpl: async (input, init) => {
      if (init.method === 'PATCH') return readOk(aliasData('newname', oldUrl));
      const body = JSON.parse(init.body);
      return createOk({ url: body.url, domain: 'tinyurl.com', alias: body.alias, tiny_url: `https://tinyurl.com/${body.alias}` });
    },
  });
  await bridge.create({ url: oldUrl, alias: 'oldname' });
  await bridge.create({ url: newUrl, alias: 'newname' });
  await bridge.update({ alias: 'oldname', new_alias: 'newname' });
  for (const [url, alias] of [[oldUrl, 'oldname'], [newUrl, 'newname']]) {
    const file = path.join(stateDir, 'operations', `${operationKey({ url, domain: 'tinyurl.com', alias })}.json`);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'stale');
  }
});

test('persists the mutation barrier before the network write', async () => {
  const { config, stateDir } = setup();
  let barrierAtFetch;
  const bridge = createBridge(config, {
    fetchImpl: async (_input, init) => {
      if (init.method === 'PATCH') {
        barrierAtFetch = fs.readdirSync(path.join(stateDir, 'mutations')).filter(name => name.endsWith('.json'))
          .map(name => JSON.parse(fs.readFileSync(path.join(stateDir, 'mutations', name), 'utf8')));
        return new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
        });
      }
      return createOk({ url: 'https://example.com/barrier', domain: 'tinyurl.com', alias: 'barrier', tiny_url: 'https://tinyurl.com/barrier' });
    },
  });
  await bridge.create({ url: 'https://example.com/barrier', alias: 'barrier' });
  await assert.rejects(bridge.update({ alias: 'barrier', new_tags: ['x'] }), error => error.code === 'write_outcome_unknown');
  assert.equal(barrierAtFetch.length, 1);
  assert.equal(barrierAtFetch[0].status, 'pending');
  assert.equal(barrierAtFetch[0].alias, 'barrier');
});

test('a definite 4xx rejection clears the mutation barrier', async () => {
  const { config } = setup();
  let patches = 0;
  const bridge = createBridge(config, {
    fetchImpl: async (_input, init) => {
      if (init.method === 'POST') return createOk({ url: 'https://example.com/reject', domain: 'tinyurl.com', alias: 'reject', tiny_url: 'https://tinyurl.com/reject' });
      patches++;
      return json({ code: 5, data: [], errors: ['Invalid'] }, 422);
    },
  });
  await bridge.create({ url: 'https://example.com/reject', alias: 'reject' });
  await assert.rejects(bridge.update({ alias: 'reject', new_tags: ['x'] }), error => error.code === 'api_rejected');
  await assert.rejects(bridge.update({ alias: 'reject', new_tags: ['x'] }), error => error.code === 'api_rejected');
  assert.equal(patches, 2);
});

test('an empty or mismatched success body is ambiguous, not proof of deletion', async () => {
  const { config } = setup();
  const bridge = createBridge(config, {
    fetchImpl: async (_input, init) => {
      if (init.method === 'POST') return createOk({ url: 'https://example.com/empty', domain: 'tinyurl.com', alias: 'empty', tiny_url: 'https://tinyurl.com/empty' });
      return readOk({});
    },
  });
  await bridge.create({ url: 'https://example.com/empty', alias: 'empty' });
  await assert.rejects(bridge.delete({ alias: 'empty' }), error => error.code === 'write_outcome_unknown');
  await assert.rejects(bridge.delete({ alias: 'empty' }), error => error.code === 'write_outcome_unknown');
});

test('enforces the documented 30-character alias maximum', async () => {
  const { config } = setup();
  let calls = 0;
  const bridge = createBridge(config, { fetchImpl: async () => { calls++; return readOk(aliasData()); } });
  const tooLong = 'a'.repeat(31);
  await assert.rejects(bridge.create({ url: 'https://example.com', alias: tooLong }), error => error.code === 'invalid_alias');
  await assert.rejects(bridge.read({ alias: tooLong }), error => error.code === 'invalid_alias');
  await assert.rejects(bridge.update({ alias: tooLong, new_tags: ['x'] }), error => error.code === 'invalid_alias');
  assert.equal(calls, 0);
});

test('an autogenerated alias touched by a concurrent mutation is never reported', async () => {
  const { config, stateDir } = setup();
  let releaseCreate;
  const gate = new Promise(resolve => { releaseCreate = resolve; });
  const bridge = createBridge(config, {
    fetchImpl: async (_input, init) => {
      if (init.method === 'POST') {
        await gate;
        return createOk({ url: 'https://example.com/auto', domain: 'tinyurl.com', alias: 'autoalias', tiny_url: 'https://tinyurl.com/autoalias' });
      }
      return readOk(aliasData('autoalias', 'https://example.com/auto'));
    },
  });
  const creating = bridge.create({ url: 'https://example.com/auto' });
  await new Promise(resolve => setTimeout(resolve, 10));
  await bridge.delete({ alias: 'autoalias' });
  releaseCreate();
  await assert.rejects(creating, error => error.code === 'write_outcome_unknown');
  const operations = path.join(stateDir, 'operations');
  const records = fs.readdirSync(operations).map(name => JSON.parse(fs.readFileSync(path.join(operations, name), 'utf8')));
  assert.ok(records.every(record => record.status !== 'ok'));
});

test('update metadata succeeds when the documented response omits the URL', async () => {
  const { config } = setup();
  const bridge = createBridge(config, {
    fetchImpl: async (_input, init) => {
      if (init.method === 'POST') return createOk({ url: 'https://example.com/meta', domain: 'tinyurl.com', alias: 'meta', tiny_url: 'https://tinyurl.com/meta' });
      return readOk({ domain: 'tinyurl.com', alias: 'meta', tiny_url: 'https://tinyurl.com/meta' });
    },
  });
  await bridge.create({ url: 'https://example.com/meta', alias: 'meta' });
  const output = await bridge.update({ alias: 'meta', new_description: 'Metadata only' });
  assert.equal(output.status, 'ok');
  assert.equal(output.destination, undefined);
  assert.equal(output.tinyUrl, 'https://tinyurl.com/meta');
});

test('a malformed updated short link is ambiguous and keeps the barrier', async () => {
  const { config, stateDir } = setup();
  const bridge = createBridge(config, {
    fetchImpl: async (_input, init) => {
      if (init.method === 'POST') return createOk({ url: 'https://example.com/badlink', domain: 'tinyurl.com', alias: 'badlink', tiny_url: 'https://tinyurl.com/badlink' });
      return readOk({ domain: 'tinyurl.com', alias: 'badlink', tiny_url: 'https://attacker.example/badlink' });
    },
  });
  await bridge.create({ url: 'https://example.com/badlink', alias: 'badlink' });
  await assert.rejects(bridge.update({ alias: 'badlink', new_tags: ['x'] }), error => error.code === 'write_outcome_unknown');
  assert.ok(fs.readdirSync(path.join(stateDir, 'mutations')).some(name => name.endsWith('.json')));
});
