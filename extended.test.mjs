import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge, operationKey, toolDefinitions } from './bridge.mjs';

const TOKEN = 'tinyurl-test-token-123456';
const BASE = 'https://api.tinyurl.com';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyurl-extended-test-'));
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
const ok = data => json({ code: 0, data });
const aliasData = (alias = 'launch', url = 'https://example.com/launch', extra = {}) => ({
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
  ...extra,
});
const createData = (url, alias) => ({ url, domain: 'tinyurl.com', alias, tiny_url: `https://tinyurl.com/${alias}` });
const mutationFiles = stateDir => {
  try {
    return fs.readdirSync(path.join(stateDir, 'mutations')).filter(name => name.endsWith('.json'));
  } catch { return []; }
};

test('exposes every fixed extension tool and no endpoint or method escape hatch', () => {
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
  for (const tool of toolDefinitions) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'endpoint'), false, tool.name);
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'path'), false, tool.name);
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'method'), false, tool.name);
  }
  const bulk = toolDefinitions.find(tool => tool.name === 'tinyurl_bulk_create');
  assert.equal(bulk.inputSchema.properties.items.maxItems, 100);
  assert.equal(bulk.inputSchema.properties.items.items.oneOf.length, 6);
});

test('timeline analytics uses a fixed endpoint, official query parameters, alias/domain and bounded data', async () => {
  const { config } = setup();
  let request;
  const bridge = createBridge(config, {
    fetchImpl: async (input, init) => {
      request = { input, init };
      return ok({
        dataset: [
          { datetime: '2024-01-01 10:00:00', total: 10020, unique: 6000, human: 9123 },
          { datetime: '2024-01-02 10:00:00', total: 4, unique: 3, human: 2 },
        ],
        interval: 'day',
        timezone: '-08:00',
      });
    },
  });
  const output = await bridge.analyticsReport({
    report: 'timeline',
    from: '2021-08-10T10:00:00-0800',
    to: '2021-08-11 14:00:00 CDT',
    interval: 'day',
    alias: 'launch',
    tag: 'release',
  });
  const url = new URL(request.input);
  assert.equal(url.origin, BASE);
  assert.equal(url.pathname, '/analytics/timeline');
  assert.equal(url.searchParams.get('from'), '2021-08-10T10:00:00-0800');
  assert.equal(url.searchParams.get('to'), '2021-08-11 14:00:00 CDT');
  assert.equal(url.searchParams.get('interval'), 'day');
  assert.equal(url.searchParams.get('alias'), 'tinyurl.com/launch');
  assert.equal(url.searchParams.get('tag'), 'release');
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(output.status, 'ok');
  assert.equal(output.report, 'timeline');
  assert.equal(output.alias, 'launch');
  assert.equal(output.domain, 'tinyurl.com');
  assert.deepEqual(output.data.dataset, [
    { datetime: '2024-01-01 10:00:00', total: 10020, unique: 6000, human: 9123 },
    { datetime: '2024-01-02 10:00:00', total: 4, unique: 3, human: 2 },
  ]);
  assert.deepEqual(output.bounded, { returned: 2, total: 2, truncated: false });
  assert.equal(JSON.stringify(output).includes(TOKEN), false);
});

test('all remaining analytics report endpoints map to their documented paths', async () => {
  const cases = [
    ['general', '/analytics/general', { dataset: [{ browser: [{ name: 'Chrome', value: 2, children: [{ name: '109', value: 2 }] }], os: [], device: [] }], total: 2 }],
    ['weekday', '/analytics/popularity/weekday', { dataset: [1, 2, 3, 4, 5, 6, 7] }],
    ['hour', '/analytics/popularity/hour', { dataset: Array.from({ length: 24 }, (_, index) => index) }],
    ['top_sources', '/analytics/sources/top', { dataset: [{ source: 'google.com', hits: 23 }], direct: 12, total: 123 }],
    ['top_languages', '/analytics/languages/top', { dataset: [{ language: 'en', hits: 23 }], none: 12, total: 123 }],
    ['location', '/analytics/location/us', { dataset: [{ name: 'CA', value: 23 }], none: 12, total: 123 }],
  ];
  for (const [report, pathname, data] of cases) {
    const { config } = setup();
    let request;
    const bridge = createBridge(config, {
      fetchImpl: async (input, init) => { request = { input, init }; return ok(data); },
    });
    const output = await bridge.analyticsReport({
      report,
      from: '2024-01-01',
      ...(report === 'location' ? { region: 'us' } : {}),
    });
    assert.equal(new URL(request.input).pathname, pathname, report);
    assert.equal(output.report, report);
    assert.deepEqual(output.data.dataset, data.dataset, report);
    assert.equal(request.init.redirect, 'error');
  }
});

test('general analytics preserves the live object-shaped dataset and zero total', async () => {
  const { config } = setup();
  const bridge = createBridge(config, {
    fetchImpl: async () => ok({ dataset: { browser: [], os: [], device: [] }, total: 0 }),
  });
  const output = await bridge.analyticsReport({ report: 'general', from: '2024-01-01' });
  assert.deepEqual(output.data, { dataset: { browser: [], os: [], device: [] }, total: 0 });
  assert.deepEqual(output.bounded, { returned: 0, total: 0, truncated: false });
});

test('general analytics bounds every object-shaped dimension list and nested children', async () => {
  const { config } = setup();
  const buckets = length => Array.from({ length }, (_, index) => ({ name: `bucket-${index}`, value: index }));
  const bridge = createBridge(config, {
    fetchImpl: async () => ok({
      dataset: {
        browser: [{ name: 'Chrome', value: 1, children: buckets(101) }, ...buckets(100)],
        os: buckets(101),
        device: [{ name: 'desktop', value: 99 }],
      },
      total: 5,
    }),
  });
  const output = await bridge.analyticsReport({ report: 'general', from: '2024-01-01' });
  assert.equal(Array.isArray(output.data.dataset), false);
  assert.equal(output.data.dataset.browser.length, 100);
  assert.equal(output.data.dataset.os.length, 100);
  assert.deepEqual(output.data.dataset.device, [{ name: 'desktop', value: 99 }]);
  assert.equal(output.data.dataset.browser[0].children.length, 100);
  assert.equal(output.data.dataset.browser[0].childrenTruncated, true);
  assert.equal(output.data.total, 5);
  assert.deepEqual(output.bounded, { returned: 201, total: 203, truncated: true });
});

test('raw analytics logs are paginated locally and every field is type-bounded', async () => {
  const { config } = setup();
  let calls = 0;
  const logs = [
    {
      datetime: '2020-12-21 14:10:00',
      tiny_url: 'https://tinyurl.com/launch',
      url: 'https://domain.com/target/url',
      referer: null,
      ip: '1.2.3.0',
      country: 'us',
      is_bot: false,
      browser: { name: 'Chrome', version: '109.0' },
      os: { name: 'Mac', version: '10.15' },
      device: 'desktop',
      language: 'en',
      tags: ['launch', 7],
      secret: TOKEN,
    },
    { datetime: '2020-12-21 14:11:00', tiny_url: 'https://tinyurl.com/launch', url: 'https://domain.com/2', ip: '1.2.3.1' },
    { datetime: '2020-12-21 14:12:00', tiny_url: 'https://tinyurl.com/launch', url: 'https://domain.com/3', ip: '1.2.3.2' },
  ];
  const bridge = createBridge(config, {
    fetchImpl: async input => {
      calls++;
      assert.equal(new URL(input).pathname, '/analytics/raw/json');
      return ok(logs);
    },
  });
  const first = await bridge.rawLogs({ from: '2020-12-21', limit: 2, offset: 0 });
  assert.equal(first.total, 3);
  assert.equal(first.returned, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 2);
  assert.equal(first.logs[0].ip, '1.2.3.0');
  assert.deepEqual(first.logs[0].browser, { name: 'Chrome', version: '109.0' });
  assert.deepEqual(first.logs[0].tags, ['launch']);
  assert.equal(Object.hasOwn(first.logs[0], 'secret'), false);
  assert.equal(JSON.stringify(first).includes(TOKEN), false);
  const second = await bridge.rawLogs({ from: '2020-12-21', limit: 2, offset: 2 });
  assert.equal(second.returned, 1);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextOffset, null);
  assert.equal(calls, 2);
});

test('analytics status and sharing write documented bodies, verify values and invalidate create receipts', async () => {
  const { config, stateDir } = setup();
  const requests = [];
  const bridge = createBridge(config, {
    fetchImpl: async (input, init) => {
      requests.push({ input, init });
      if (init.method === 'POST') return ok(createData('https://example.com/analytics', 'analytics'));
      if (init.method === 'PATCH' && new URL(input).pathname === '/analytics/status') {
        assert.ok(mutationFiles(stateDir).length > 0);
        return ok(aliasData('analytics', 'https://example.com/analytics', { analytics: { enabled: false, public: false } }));
      }
      if (init.method === 'PATCH' && new URL(input).pathname === '/analytics/sharing') {
        return ok(aliasData('analytics', 'https://example.com/analytics', { analytics: { enabled: false, public: true } }));
      }
      throw new Error(`unexpected ${init.method} ${input}`);
    },
  });
  await bridge.create({ url: 'https://example.com/analytics', alias: 'analytics' });
  const status = await bridge.analyticsStatus({ alias: 'analytics', enabled: false });
  assert.equal(status.action, 'analytics_status_updated');
  assert.deepEqual(JSON.parse(requests[1].init.body), { domain: 'tinyurl.com', alias: 'analytics', enabled: false });
  const receipt = path.join(stateDir, 'operations', `${operationKey({ url: 'https://example.com/analytics', domain: 'tinyurl.com', alias: 'analytics' })}.json`);
  assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).status, 'stale');
  const sharing = await bridge.analyticsSharing({ alias: 'analytics', public: true });
  assert.equal(sharing.action, 'analytics_sharing_updated');
  assert.deepEqual(JSON.parse(requests[2].init.body), { domain: 'tinyurl.com', alias: 'analytics', public: true });
  assert.equal(mutationFiles(stateDir).length, 0);
});

test('analytics status falls back to a verifying read when the write response omits analytics', async () => {
  const { config } = setup();
  const paths = [];
  const bridge = createBridge(config, {
    fetchImpl: async (input, init) => {
      paths.push(new URL(input).pathname);
      if (init.method === 'PATCH') return ok({ domain: 'tinyurl.com', alias: 'launch' });
      return ok(aliasData('launch', 'https://example.com/launch', { analytics: { enabled: true, public: true } }));
    },
  });
  const output = await bridge.analyticsStatus({ alias: 'launch', enabled: true });
  assert.equal(output.enabled, true);
  assert.deepEqual(paths, ['/analytics/status', '/alias/tinyurl.com/launch']);
});

test('a mismatched analytics write is ambiguous and blocks until reconciliation', async () => {
  const { config, stateDir } = setup();
  let patches = 0;
  const bridge = createBridge(config, {
    fetchImpl: async (_input, init) => {
      if (init.method !== 'PATCH') throw new Error('unexpected');
      patches++;
      return ok(aliasData('launch', 'https://example.com/launch', { analytics: { enabled: true } }));
    },
  });
  await assert.rejects(bridge.analyticsStatus({ alias: 'launch', enabled: false }), error => error.code === 'write_outcome_unknown');
  assert.ok(mutationFiles(stateDir).length > 0);
  await assert.rejects(bridge.analyticsStatus({ alias: 'launch', enabled: false }), error => error.code === 'write_outcome_unknown');
  assert.equal(patches, 1);
});

test('archive reads first, toggles once, verifies the flip and is idempotent for archive/unarchive', async () => {
  const { config } = setup();
  let archived = false;
  let patches = 0;
  const bridge = createBridge(config, {
    fetchImpl: async (input, init) => {
      if (init.method === 'GET') return ok(aliasData('launch', 'https://example.com/launch', { archived }));
      patches++;
      assert.equal(new URL(input).pathname, '/archive');
      assert.deepEqual(JSON.parse(init.body), { domain: 'tinyurl.com', alias: 'launch' });
      archived = !archived;
      return ok(aliasData('launch', 'https://example.com/launch', { archived }));
    },
  });
  const archivedOutput = await bridge.archive({ alias: 'launch', action: 'archive' });
  assert.equal(archivedOutput.changed, true);
  assert.equal(archivedOutput.wasArchived, false);
  assert.equal(archivedOutput.archived, true);
  const already = await bridge.archive({ alias: 'launch', action: 'archive' });
  assert.equal(already.changed, false);
  assert.equal(patches, 1);
  const toggled = await bridge.archive({ alias: 'launch', action: 'toggle' });
  assert.equal(toggled.action, 'toggled');
  assert.equal(toggled.archived, false);
  assert.equal(patches, 2);
  const unarchive = await bridge.archive({ alias: 'launch', action: 'unarchive' });
  assert.equal(unarchive.changed, false);
  assert.equal(patches, 2);
});

test('archive verifies through a follow-up read and an ambiguous toggle blocks repeats', async () => {
  const { config, stateDir } = setup();
  let reads = 0;
  let patches = 0;
  const bridge = createBridge(config, {
    fetchImpl: async (input, init) => {
      if (init.method === 'GET') {
        reads++;
        return ok(aliasData('launch', 'https://example.com/launch', { archived: reads > 1 }));
      }
      patches++;
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
      });
    },
  });
  await assert.rejects(bridge.archive({ alias: 'launch', action: 'toggle' }), error => error.code === 'write_outcome_unknown');
  assert.equal(patches, 1);
  assert.ok(mutationFiles(stateDir).length > 0);
  await assert.rejects(bridge.archive({ alias: 'launch', action: 'archive' }), error => error.code === 'write_outcome_unknown');
  assert.equal(patches, 1);
});

test('create supports expires_at and set_expiration sends and verifies new_expires_at', async () => {
  const { config } = setup();
  const requests = [];
  const bridge = createBridge(config, {
    fetchImpl: async (input, init) => {
      requests.push({ input, init });
      if (init.method === 'POST') {
        return ok({ ...createData('https://example.com/expiring', 'expiring'), expires_at: '2026-10-25 10:11:12' });
      }
      return ok({ domain: 'tinyurl.com', alias: 'expiring', expires_at: JSON.parse(init.body).new_expires_at });
    },
  });
  const created = await bridge.create({ url: 'https://example.com/expiring', alias: 'expiring', expires_at: '2026-10-25 10:11:12' });
  assert.equal(JSON.parse(requests[0].init.body).expires_at, '2026-10-25 10:11:12');
  assert.equal(created.expiresAt, '2026-10-25 10:11:12');
  const updated = await bridge.setExpiration({ alias: 'expiring', new_expires_at: '2027-01-01T00:00:00+00:00' });
  assert.equal(requests[1].input, `${BASE}/update`);
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    domain: 'tinyurl.com',
    alias: 'expiring',
    new_expires_at: '2027-01-01T00:00:00+00:00',
  });
  assert.equal(updated.action, 'expiration_set');
  assert.equal(updated.expiresAt, '2027-01-01T00:00:00+00:00');
  const cleared = await bridge.setExpiration({ alias: 'expiring', new_expires_at: null });
  assert.deepEqual(JSON.parse(requests[2].init.body), { domain: 'tinyurl.com', alias: 'expiring', new_expires_at: null });
  assert.equal(cleared.expiresAt, null);
});

test('a mismatched expiration response is an unknown write and keeps the barrier', async () => {
  const { config, stateDir } = setup();
  const bridge = createBridge(config, {
    fetchImpl: async (_input, init) => {
      if (init.method === 'POST') return ok(createData('https://example.com/expiring', 'expiring'));
      return ok({ domain: 'tinyurl.com', alias: 'expiring', expires_at: '2027-01-01T00:00:00+00:00' });
    },
  });
  await assert.rejects(
    bridge.setExpiration({ alias: 'expiring', new_expires_at: '2028-01-01T00:00:00+00:00' }),
    error => error.code === 'write_outcome_unknown',
  );
  assert.ok(mutationFiles(stateDir).length > 0);
});

test('bulk create persists barriers before POST /bulk, invalidates receipts and reuses a verified submission', async () => {
  const { config, stateDir } = setup();
  const url = 'https://example.com/bulk';
  const requests = [];
  let barrierSeen = false;
  const bridge = createBridge(config, {
    fetchImpl: async (input, init) => {
      requests.push({ input, init });
      if (init.method === 'POST' && new URL(input).pathname === '/create') {
        return ok(createData(url, 'bulkone'));
      }
      assert.equal(new URL(input).pathname, '/bulk');
      assert.ok(fs.existsSync(path.join(stateDir, 'bulk', 'barrier.json')));
      barrierSeen = mutationFiles(stateDir).length > 0;
      const receipt = path.join(stateDir, 'operations', `${operationKey({ url, domain: 'tinyurl.com', alias: 'bulkone' })}.json`);
      assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).status, 'stale');
      return ok({
        id: 42,
        status: 0,
        created_at: '2021-07-08 10:29:57',
        updated_at: '2021-07-08 10:29:57',
        total: 2,
        success: 0,
        failed: 0,
      });
    },
  });
  await bridge.create({ url, alias: 'bulkone' });
  const args = {
    items: [
      { operation: 'create', url: 'https://example.com/new', alias: 'bulktwo', expires_at: null },
      { operation: 'archive', alias: 'bulkone' },
    ],
  };
  const first = await bridge.bulkCreate(args);
  assert.equal(barrierSeen, true);
  assert.equal(first.bulkRequestId, 42);
  assert.equal(first.requestStatus, 0);
  assert.equal(first.reused, false);
  assert.deepEqual(JSON.parse(requests[1].init.body).items[1], { operation: 'archive', domain: 'tinyurl.com', alias: 'bulkone' });
  assert.equal(fs.existsSync(path.join(stateDir, 'bulk', 'barrier.json')), false);
  const second = await bridge.bulkCreate(args);
  assert.equal(second.reused, true);
  assert.equal(requests.filter(request => new URL(request.input).pathname === '/bulk').length, 1);
  assert.equal(JSON.stringify(first).includes(TOKEN), false);
  assert.equal(barrierSeen, true);
});

test('an ambiguous bulk write blocks every later bulk submission and the affected alias', async () => {
  const { config, stateDir } = setup();
  let bulkCalls = 0;
  const bridge = createBridge(config, {
    fetchImpl: async (input, init) => {
      if (init.method === 'POST') {
        bulkCalls++;
        return new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
        });
      }
      return ok(aliasData('blockedalias', 'https://example.com/blocked'));
    },
  });
  await assert.rejects(bridge.bulkCreate({
    items: [{ operation: 'delete', alias: 'blockedalias' }],
  }), error => error.code === 'write_outcome_unknown');
  assert.equal(bulkCalls, 1);
  assert.ok(fs.existsSync(path.join(stateDir, 'bulk', 'barrier.json')));
  assert.ok(mutationFiles(stateDir).length > 0);
  await assert.rejects(bridge.bulkCreate({
    items: [{ operation: 'delete', alias: 'otheralias' }],
  }), error => error.code === 'write_outcome_unknown');
  assert.equal(bulkCalls, 1);
  await assert.rejects(bridge.create({ url: 'https://example.com/blocked', alias: 'blockedalias' }), error => error.code === 'write_outcome_unknown');
});

test('a bulk receipt recovers a crash after the provider response but before barrier cleanup', async () => {
  const { config, stateDir } = setup();
  let bulkCalls = 0;
  const bridge = createBridge(config, {
    fetchImpl: async () => {
      bulkCalls++;
      return ok({ id: 77, status: 2, total: 1, success: 1, failed: 0 });
    },
  });
  const args = { items: [{ operation: 'create', url: 'https://example.com/recover' }] };
  const first = await bridge.bulkCreate(args);
  assert.equal(first.bulkRequestId, 77);
  const receiptDir = path.join(stateDir, 'bulk', 'receipts');
  const receiptName = fs.readdirSync(receiptDir).find(name => name.endsWith('.json'));
  const receipt = JSON.parse(fs.readFileSync(path.join(receiptDir, receiptName), 'utf8'));
  fs.writeFileSync(path.join(stateDir, 'bulk', 'barrier.json'), JSON.stringify({ key: receipt.key, aliases: receipt.aliases, status: 'pending' }));
  const recovered = await bridge.bulkCreate(args);
  assert.equal(recovered.reused, true);
  assert.equal(fs.existsSync(path.join(stateDir, 'bulk', 'barrier.json')), false);
  assert.equal(bulkCalls, 1);
});

test('bulk status and report use fixed endpoints, official payloads and bounded report pages', async () => {
  const { config } = setup();
  const paths = [];
  const report = [
    { operation: 'create', domain: 'tinyurl.com', alias: 'one', url: 'https://example.com/1', tinyurl: 'https://tinyurl.com/one', status: 'success', expires_at: null, metadata: ['a', 1, true] },
    { operation: 'create', domain: 'tinyurl.com', alias: 'two', url: 'https://example.com/2', tinyurl: 'https://tinyurl.com/two', status: 'failed', comment: 'Alias already exists' },
    { operation: 'archive', domain: 'tinyurl.com', alias: 'one', status: 'success' },
  ];
  const bridge = createBridge(config, {
    fetchImpl: async input => {
      const url = new URL(input);
      paths.push(url.pathname);
      if (url.pathname === '/bulk/42/status') {
        return ok({ id: 42, status: 2, created_at: '2021-07-08 10:29:57', updated_at: '2021-07-08 11:29:57', total: 3, success: 2, failed: 1 });
      }
      return ok(report);
    },
  });
  const status = await bridge.bulkStatus({ bulkRequestId: 42 });
  assert.equal(status.bulkRequestId, 42);
  assert.equal(status.requestStatus, 2);
  assert.equal(status.requestStatusLabel, 'processed');
  assert.equal(status.total, 3);
  const page = await bridge.bulkReport({ bulkRequestId: 42, offset: 1, limit: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.returned, 1);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 2);
  assert.deepEqual(page.items[0], {
    operation: 'create',
    status: 'failed',
    domain: 'tinyurl.com',
    alias: 'two',
    url: 'https://example.com/2',
    tinyurl: 'https://tinyurl.com/two',
    comment: 'Alias already exists',
  });
  assert.deepEqual(paths, ['/bulk/42/status', '/bulk/42/report']);
});

test('validation rejects arbitrary endpoints, unsupported domains, bad report/bulk fields and oversized pages before fetch', async () => {
  const { config } = setup();
  let calls = 0;
  const bridge = createBridge(config, { fetchImpl: async () => { calls++; return ok({}); } });
  await assert.rejects(bridge.analyticsReport({ report: 'timeline', from: '2024-01-01', endpoint: '/urls/available' }), error => error.code === 'invalid_arguments');
  await assert.rejects(bridge.analyticsReport({ report: 'arbitrary', from: '2024-01-01' }), error => error.code === 'invalid_report');
  await assert.rejects(bridge.analyticsReport({ report: 'general', from: '2024-01-01', interval: 'day' }), error => error.code === 'invalid_arguments');
  await assert.rejects(bridge.analyticsReport({ report: 'general', from: '2024-01-01', region: 'us' }), error => error.code === 'invalid_arguments');
  await assert.rejects(bridge.analyticsReport({ report: 'location', from: '2024-01-01', region: 'USA' }), error => error.code === 'invalid_region');
  await assert.rejects(bridge.analyticsReport({ report: 'general', from: 'not-a-date' }), error => error.code === 'invalid_datetime');
  await assert.rejects(bridge.analyticsReport({ report: 'general', from: '2024-01-02', to: '2024-01-01' }), error => error.code === 'invalid_datetime');
  await assert.rejects(bridge.rawLogs({ from: '2024-01-01', limit: 1001 }), error => error.code === 'invalid_arguments');
  await assert.rejects(bridge.analyticsStatus({ alias: 'launch', enabled: 'yes' }), error => error.code === 'invalid_arguments');
  await assert.rejects(bridge.analyticsSharing({ alias: 'launch', public: 1 }), error => error.code === 'invalid_arguments');
  await assert.rejects(bridge.archive({ alias: 'launch', action: 'delete' }), error => error.code === 'invalid_arguments');
  await assert.rejects(bridge.setExpiration({ alias: 'launch', new_expires_at: 'tomorrow' }), error => error.code === 'invalid_expiration');
  await assert.rejects(bridge.setExpiration({ alias: 'launch' }), error => error.code === 'invalid_arguments');
  await assert.rejects(bridge.bulkCreate({ items: [] }), error => error.code === 'invalid_arguments');
  await assert.rejects(bridge.bulkCreate({ items: Array.from({ length: 101 }, () => ({ operation: 'delete', alias: 'x' })) }), error => error.code === 'invalid_arguments');
  await assert.rejects(bridge.bulkCreate({ items: [{ operation: 'delete', alias: 'x', url: 'https://example.com' }] }), error => error.code === 'invalid_arguments');
  await assert.rejects(bridge.bulkCreate({ items: [{ operation: 'create', url: 'ftp://example.com' }] }), error => error.code === 'invalid_url');
  await assert.rejects(bridge.bulkCreate({ items: [{ operation: 'create', url: 'https://example.com', domain: 'evil.example' }] }), error => error.code === 'unsupported_domain');
  await assert.rejects(bridge.bulkStatus({ bulkRequestId: '42' }), error => error.code === 'invalid_bulk_request_id');
  await assert.rejects(bridge.bulkReport({ bulkRequestId: 42, limit: 501 }), error => error.code === 'invalid_arguments');
  assert.equal(calls, 0);
});

test('read failures are explicit, bounded and never leak the token or provider body', async () => {
  const { config } = setup();
  const unavailable = createBridge(config, {
    fetchImpl: async () => json({ code: 7, data: [], errors: [TOKEN] }, 503),
  });
  await assert.rejects(unavailable.analyticsReport({ report: 'general', from: '2024-01-01' }), error =>
    error.code === 'provider_unavailable' && !JSON.stringify(error).includes(TOKEN));
  const rejected = createBridge(config, {
    fetchImpl: async () => json({ code: 6, data: [], errors: [TOKEN] }),
  });
  await assert.rejects(rejected.bulkStatus({ bulkRequestId: 42 }), error =>
    error.code === 'api_rejected' && !JSON.stringify(error).includes(TOKEN));
  const wide = createBridge(config, {
    fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: { dataset: ['x'.repeat(5 * 1024 * 1024)] } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024) },
    }),
  });
  await assert.rejects(wide.analyticsReport({ report: 'general', from: '2024-01-01' }), error => error.code === 'response_too_large');
  const malformed = createBridge(config, {
    fetchImpl: async () => ok({ dataset: [{ browser: 'not-an-array' }] }),
  });
  await assert.rejects(malformed.analyticsReport({ report: 'general', from: '2024-01-01' }), error => error.code === 'response_invalid');
});

test('archive follows up with one read when the write response omits archived', async () => {
  const { config } = setup();
  let gets = 0;
  const bridge = createBridge(config, {
    fetchImpl: async (input, init) => {
      if (init.method === 'PATCH') return ok({ domain: 'tinyurl.com', alias: 'launch' });
      gets++;
      return ok(aliasData('launch', 'https://example.com/launch', { archived: gets > 1 }));
    },
  });
  const output = await bridge.archive({ alias: 'launch', action: 'archive' });
  assert.equal(output.changed, true);
  assert.equal(output.archived, true);
  assert.equal(gets, 2);
});

test('a definite bulk 4xx clears the global and alias barriers', async () => {
  const { config, stateDir } = setup();
  let calls = 0;
  const bridge = createBridge(config, {
    fetchImpl: async () => {
      calls++;
      return json({ code: 5, data: [], errors: ['Invalid', TOKEN] }, 422);
    },
  });
  await assert.rejects(bridge.bulkCreate({
    items: [{ operation: 'delete', alias: 'rejectedalias' }],
  }), error => error.code === 'api_rejected' && !JSON.stringify(error).includes(TOKEN));
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(path.join(stateDir, 'bulk', 'barrier.json')), false);
  assert.equal(mutationFiles(stateDir).length, 0);
});

test('a create response with a different expiry is rejected and not cached', async () => {
  const { config, stateDir } = setup();
  const bridge = createBridge(config, {
    fetchImpl: async () => ok({
      ...createData('https://example.com/expiry-mismatch', 'expirymismatch'),
      expires_at: '2028-01-01T00:00:00+00:00',
    }),
  });
  await assert.rejects(
    bridge.create({
      url: 'https://example.com/expiry-mismatch',
      alias: 'expirymismatch',
      expires_at: '2027-01-01T00:00:00+00:00',
    }),
    error => error.code === 'response_invalid',
  );
  const operations = path.join(stateDir, 'operations');
  const records = fs.existsSync(operations)
    ? fs.readdirSync(operations).map(name => JSON.parse(fs.readFileSync(path.join(operations, name), 'utf8')))
    : [];
  assert.ok(records.every(record => record.status !== 'ok'));
});

test('bulk refuses an affected alias that already has an ambiguous mutation barrier', async () => {
  const { config } = setup();
  let bulkCalls = 0;
  const bridge = createBridge(config, {
    fetchImpl: async (input, init) => {
      if (init.method === 'PATCH') {
        return new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
        });
      }
      if (new URL(input).pathname === '/bulk') bulkCalls++;
      return ok({ id: 9, status: 0, total: 1, success: 0, failed: 0 });
    },
  });
  await assert.rejects(bridge.update({ alias: 'blocked', new_tags: ['x'] }), error => error.code === 'write_outcome_unknown');
  await assert.rejects(
    bridge.bulkCreate({ items: [{ operation: 'archive', alias: 'blocked' }] }),
    error => error.code === 'write_outcome_unknown',
  );
  assert.equal(bulkCalls, 0);
});
