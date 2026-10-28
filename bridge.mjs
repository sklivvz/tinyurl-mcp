import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const DOMAIN = 'tinyurl.com';
export const TIMEOUT_MS = 4000;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_BULK_ITEMS = 100;
export const MAX_BULK_REPORT_PAGE = 500;
export const MAX_RAW_LOG_PAGE = 1000;
const ALIAS = /^[A-Za-z0-9_-]{1,30}$/;
const TOKEN = /^[A-Za-z0-9._~+/=-]{10,4096}$/;
const LOCK_STALE_MS = 60000;
const INTERVALS = ['minute', 'hour', 'day', 'week', 'month'];
const ANALYTICS_REPORTS = ['timeline', 'general', 'weekday', 'hour', 'top_sources', 'top_languages', 'location'];
const BULK_OPERATIONS = ['create', 'update', 'change', 'delete', 'archive', 'unarchive'];
const DATETIME = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2}| ?[A-Z]{2,5})?)?$/;
const ISO_DURATION = /^P(?=\d|T\d)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/;
const REGION = /^(?:world|[A-Za-z]{2})$/;
const OPERATION_LABEL = Object.freeze({ 0: 'new', 1: 'processing', 2: 'processed' });
const MAX_TIMELINE_POINTS = 1000;
const MAX_ANALYTICS_ITEMS = 100;
const MAX_CHILDREN = 100;
const MAX_RAW_LOGS_FETCH = 50000;
const MAX_URL = 8192;

class Blocked extends Error {
  constructor(code, nextAction) {
    super(code);
    this.code = code;
    this.nextAction = nextAction;
  }
}

const stop = (code, nextAction) => { throw new Blocked(code, nextAction); };
const shortUrlMatches = (value, alias) => {
  if (typeof value !== 'string') return false;
  try {
    const tiny = new URL(value);
    return tiny.protocol === 'https:' && tiny.hostname === DOMAIN && !tiny.username && !tiny.password
      && !tiny.search && !tiny.hash && tiny.pathname === `/${alias}`;
  } catch { return false; }
};
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
  : item);
export const operationKey = ({ url, domain, alias, expires_at: expiresAt }) => createHash('sha256')
  .update(canonical({ url, domain, alias: alias ?? null, expires_at: expiresAt ?? null })).digest('hex');

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const text = (value, max) => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined);
const nullableText = (value, max) => (value === null ? null : text(value, max));
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : undefined);

class BodyTooLarge extends Error {}
class InvalidJsonBody extends Error {}

async function readBoundedJson(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new BodyTooLarge();
  if (!response.body || typeof response.body.getReader !== 'function') {
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new BodyTooLarge();
    try { return JSON.parse(body); } catch { throw new InvalidJsonBody(); }
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch {}
        throw new BodyTooLarge();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new InvalidJsonBody(); }
}

function boundedItems(value, max, map) {
  if (!Array.isArray(value)) stop('response_invalid', 'TinyURL returned an unexpected list; no partial report is reported.');
  const items = [];
  for (const item of value.slice(0, Math.min(value.length, max))) {
    const mapped = map(item);
    if (mapped !== undefined) items.push(mapped);
  }
  return { items, total: value.length, truncated: value.length > max };
}

function validDatetime(value) {
  return typeof value === 'string' && value.length >= 10 && value.length <= 100 && DATETIME.test(value);
}

function validateAnalyticsInstant(value, field, required) {
  if (value === undefined && !required) return undefined;
  if (!validDatetime(value)) stop('invalid_datetime', `${field} must be an ISO 8601 date or date-time accepted by TinyURL, for example 2021-08-10T10:00:00-0800.`);
  return value;
}

function privateFile(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    stop('private_file_invalid', 'Operator must provide a regular 0600 file.');
  }
  if (info.size === 0 || info.size > 65536) {
    stop('private_file_invalid', 'Operator must provide a non-empty file of at most 64 KiB.');
  }
  return fs.readFileSync(file, 'utf8');
}

function readToken(file) {
  let text;
  try { text = privateFile(file).trim(); } catch (error) {
    if (error instanceof Blocked) throw error;
    stop('credentials_unavailable', 'Operator must provide the TinyURL API token in a valid private token file.');
  }
  if (text.startsWith('{')) {
    try { text = (JSON.parse(text).token ?? JSON.parse(text).apiToken ?? '').trim(); } catch { text = ''; }
  }
  if (!TOKEN.test(text)) stop('credentials_unavailable', 'Operator must provide a valid TinyURL API token in the configured private file.');
  return text;
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    stop('state_unreadable', 'Operator must repair or remove the private operation record.');
  }
}

function ensureStateDirs(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const current of [path.dirname(dir), dir]) {
    const info = fs.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      stop('private_directory_invalid', 'Operator must provide a real private state directory (0700).');
    }
  }
}

function syncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeState(dir, file, value) {
  ensureStateDirs(dir);
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  syncDir(dir);
}

function claimState(dir, file, value) {
  ensureStateDirs(dir);
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    fs.linkSync(tmp, file);
    syncDir(dir);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function removeState(file) {
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  syncDir(path.dirname(file));
}

function aliasLockName(alias) {
  return createHash('sha256').update(`${DOMAIN}\0${alias}`).digest('hex');
}

async function acquireAliasLocks(stateDir, aliases, waitMs) {
  const locksDir = path.join(stateDir, 'locks');
  const acquired = [];
  try {
    ensureStateDirs(locksDir);
    for (const alias of [...new Set(aliases)].sort()) {
      const lock = path.join(locksDir, `${aliasLockName(alias)}.lock`);
      const until = Date.now() + waitMs;
      for (;;) {
        try {
          fs.mkdirSync(lock, 0o700);
          acquired.push(lock);
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          try {
            const info = fs.statSync(lock);
            if (Date.now() - info.mtimeMs > LOCK_STALE_MS) { fs.rmdirSync(lock); continue; }
          } catch { continue; }
          if (Date.now() >= until) stop('operation_in_progress', 'Another operation for this exact alias is in progress. Retry after it finishes.');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
    }
  } catch (error) {
    for (const lock of acquired.reverse()) { try { fs.rmdirSync(lock); } catch {} }
    throw error;
  }
  return () => { for (const lock of acquired.reverse()) { try { fs.rmdirSync(lock); } catch {} } };
}

function ambiguousMutationFile(stateDir, alias) {
  return path.join(stateDir, 'mutations', `${aliasLockName(alias)}.json`);
}

function aliasMutationEventFile(stateDir, alias) {
  return path.join(stateDir, 'mutations', 'events', `${aliasLockName(alias)}.json`);
}

function markAliasReceiptsStale(operations, alias) {
  let names;
  try { names = fs.readdirSync(operations); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(operations, name);
    const record = readState(file);
    if (!record || record.domain !== DOMAIN || record.alias !== alias) continue;
    if (record.status === 'ok') {
      writeState(operations, file, { ...record, status: 'stale', staleReason: 'alias_updated_or_deleted', updatedAt: new Date().toISOString() });
    } else if (record.status === 'pending') {
      writeState(operations, file, { ...record, status: 'unknown', failure: 'alias_updated_or_deleted', updatedAt: new Date().toISOString() });
    }
  }
}

function validateUrl(input) {
  if (input.length > MAX_URL) stop('invalid_url', `Supply an absolute http(s) URL of at most ${MAX_URL} characters.`);
  let parsed;
  try { parsed = new URL(input); } catch { stop('invalid_url', 'Supply an absolute http(s) URL exactly as it should be shortened.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    stop('invalid_url', 'Supply an absolute http(s) URL without embedded credentials.');
  }
  return input;
}

function validateAlias(input) {
  if (input === undefined) return undefined;
  if (typeof input !== 'string' || !ALIAS.test(input)) {
    stop('invalid_alias', 'Alias must be 1-30 characters using only letters, digits, underscore or hyphen.');
  }
  return input;
}

function validateDomain(input) {
  if (input !== undefined && input !== DOMAIN) {
    stop('unsupported_domain', `This connector is fixed to the ${DOMAIN} domain.`);
  }
  return DOMAIN;
}

function validateExpiration(input, field) {
  if (input === null) return null;
  if (typeof input !== 'string' || input.length < 1 || input.length > 100) {
    stop('invalid_expiration', `${field} must be null or an ISO 8601 date-time or duration string accepted by TinyURL.`);
  }
  if (!DATETIME.test(input) && !ISO_DURATION.test(input)) {
    stop('invalid_expiration', `${field} must be null or an ISO 8601 date-time or duration string accepted by TinyURL.`);
  }
  if (DATETIME.test(input)) {
    const parsed = Date.parse(input.replace(' ', 'T'));
    if (!Number.isFinite(parsed) && !/[A-Za-z]{2,5}$/.test(input)) {
      stop('invalid_expiration', `${field} must be a real ISO 8601 date-time or duration.`);
    }
  }
  return input;
}

function validResult(input, record) {
  if (record?.status !== 'ok' || record.url !== input.url || record.domain !== input.domain) return false;
  if (input.alias !== undefined && record.alias !== input.alias) return false;
  if ((input.expires_at ?? null) !== (record.expires_at ?? null)) return false;
  if (typeof record.tinyUrl !== 'string') return false;
  try {
    const tiny = new URL(record.tinyUrl);
    if (tiny.protocol !== 'https:' || tiny.hostname !== DOMAIN || tiny.username || tiny.password
      || tiny.search || tiny.hash || tiny.pathname !== `/${record.alias}`) return false;
  } catch { return false; }
  return true;
}

function result(record, reused) {
  return {
    status: 'ok',
    destination: record.url,
    domain: record.domain,
    alias: record.alias,
    tinyUrl: record.tinyUrl,
    ...(record.expires_at === undefined ? {} : { expiresAt: record.expires_at }),
    reused,
  };
}

function parseResponse(input, body) {
  if (body?.code !== 0 || !body?.data) stop('api_rejected', 'TinyURL rejected the request. Check the destination URL and alias.');
  const { url, domain, alias, tiny_url: tinyUrl } = body.data;
  if (typeof url !== 'string' || url !== input.url) {
    stop('destination_mismatch', 'TinyURL returned a different destination; no short link is reported.');
  }
  if (domain !== input.domain || typeof alias !== 'string' || !ALIAS.test(alias) || typeof tinyUrl !== 'string') {
    stop('response_invalid', 'TinyURL returned an incomplete or unexpected response; no short link is reported.');
  }
  if (!shortUrlMatches(tinyUrl, alias)) {
    stop('response_invalid', 'TinyURL returned a short link that does not match the reported alias.');
  }
  if (input.alias !== undefined && alias !== input.alias) {
    stop('alias_mismatch', 'TinyURL returned a different alias; no short link is reported.');
  }
  if (input.expires_at !== undefined && body.data.expires_at !== undefined
    && !expirationMatches(input.expires_at, body.data.expires_at)) {
    stop('response_invalid', 'TinyURL returned a different expiration than requested; no short link is reported.');
  }
  return { url, domain, alias, tinyUrl };
}

function sameInstant(left, right) {
  if (left === null || right === null) return left === right;
  if (left === right) return true;
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftMs = Date.parse(left.replace(' ', 'T'));
  const rightMs = Date.parse(right.replace(' ', 'T'));
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

function expirationMatches(requested, actual) {
  if (requested === null || actual === null) return requested === actual;
  if (typeof requested === 'string' && ISO_DURATION.test(requested)) {
    if (typeof actual !== 'string') return false;
    const expiry = Date.parse(actual.replace(' ', 'T'));
    return Number.isFinite(expiry) && expiry > Date.now();
  }
  return sameInstant(requested, actual);
}

export function createBridge(config, { fetchImpl = globalThis.fetch } = {}) {
  if (!config || typeof config !== 'object' || typeof config.tokenFile !== 'string' || !path.isAbsolute(config.tokenFile)
    || typeof config.stateDir !== 'string' || !path.isAbsolute(config.stateDir)) {
    stop('configuration_invalid', 'Operator must set absolute tokenFile and stateDir values.');
  }
  const timeoutMs = config.timeoutMs ?? TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 4000) {
    stop('configuration_invalid', 'timeoutMs must be an integer between 100 and 4000.');
  }
  if (typeof fetchImpl !== 'function') stop('configuration_invalid', 'A fetch implementation is required.');

  const operations = path.join(config.stateDir, 'operations');
  const bulkDir = path.join(config.stateDir, 'bulk');
  const bulkReceipts = path.join(bulkDir, 'receipts');
  const bulkBarrier = path.join(bulkDir, 'barrier.json');
  const bulkLock = path.join(bulkDir, 'lock');
  const inflight = new Map();

  function status() {
    let token = false;
    try { readToken(config.tokenFile); token = true; } catch { token = false; }
    let stateDirectory = false;
    try {
      const info = fs.lstatSync(config.stateDir);
      stateDirectory = info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0;
    } catch { stateDirectory = false; }
    let mutationBarrierCount = 0;
    try {
      mutationBarrierCount = fs.readdirSync(path.join(config.stateDir, 'mutations'))
        .filter(name => name.endsWith('.json')).length;
    } catch {}
    let bulkBarrierPresent = false;
    try { bulkBarrierPresent = fs.existsSync(bulkBarrier); } catch {}
    return {
      status: 'ok',
      configured: token && stateDirectory,
      domain: DOMAIN,
      tokenPresent: token,
      stateDirectoryPresent: stateDirectory,
      timeoutMs,
      mutationBarrierCount,
      bulkBarrierPresent,
    };
  }

  function existingOutcome(input, cached) {
    if (cached.status === 'ok') {
      if (!validResult(input, cached)) {
        stop('cache_mismatch', 'A cached operation record does not match this exact destination. Operator must review the private state file.');
      }
      return result(cached, true);
    }
    stop('write_outcome_unknown', 'A previous attempt for this exact operation may have reached TinyURL. Do not retry blindly; operator must reconcile the alias.');
  }

  async function waitForOperation(file) {
    const until = Date.now() + timeoutMs + 250;
    for (;;) {
      const current = readState(file);
      if (current && current.status !== 'pending') return current;
      if (Date.now() >= until) return current;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  async function createUnlocked(input, key, file) {
    const cached = readState(file);
    if (cached?.status === 'pending') {
      const other = await waitForOperation(file);
      if (!other) stop('state_unavailable', 'Another process removed this operation record. Retry only after confirming no short link was created.');
      return existingOutcome(input, other);
    }
    if (cached?.status === 'stale') {
      removeState(file);
    } else if (cached) return existingOutcome(input, cached);

    const token = readToken(config.tokenFile);
    const startedMs = Date.now();
    const now = new Date().toISOString();
    const pending = { key, ...input, status: 'pending', createdAt: now, updatedAt: now };
    if (!claimState(operations, file, pending)) {
      const other = await waitForOperation(file);
      if (!other) stop('state_unavailable', 'Another process removed this operation record. Retry only after confirming no short link was created.');
      return existingOutcome(input, other);
    }

    let response;
    try {
      response = await fetchImpl('https://api.tinyurl.com/create', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          url: input.url,
          domain: input.domain,
          ...(input.alias === undefined ? {} : { alias: input.alias }),
          ...(input.expires_at === undefined ? {} : { expires_at: input.expires_at }),
        }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      writeState(operations, file, {
        ...pending,
        status: 'unknown',
        failure: error?.name === 'TimeoutError' ? 'timeout' : 'network',
        updatedAt: new Date().toISOString(),
      });
      stop('write_outcome_unknown', 'The create request was interrupted or timed out and may have reached TinyURL. Do not retry blindly; operator must reconcile the alias.');
    }

    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        removeState(file);
        stop('api_rejected', `TinyURL rejected the request with HTTP ${response.status}.`);
      }
      writeState(operations, file, { ...pending, status: 'unknown', failure: 'http', updatedAt: new Date().toISOString() });
      stop('write_outcome_unknown', `TinyURL returned HTTP ${response.status} and the write outcome is unknown. Do not retry blindly.`);
    }

    let body;
    try { body = await readBoundedJson(response); } catch {
      writeState(operations, file, { ...pending, status: 'unknown', failure: 'response', updatedAt: new Date().toISOString() });
      stop('write_outcome_unknown', 'TinyURL returned an unreadable or oversized response and the write outcome is unknown. Do not retry blindly.');
    }

    let parsed;
    try { parsed = parseResponse(input, body); } catch (error) {
      writeState(operations, file, { ...pending, status: 'unknown', failure: 'response', updatedAt: new Date().toISOString() });
      throw error;
    }
    const record = { key, ...input, ...parsed, status: 'ok', createdAt: now, updatedAt: new Date().toISOString() };
    if (input.alias === undefined) {
      const release = await acquireAliasLocks(config.stateDir, [parsed.alias], Math.min(Math.max(timeoutMs * 2, 1000), 10000));
      try {
        const event = readState(aliasMutationEventFile(config.stateDir, parsed.alias));
        if (event && Number.isFinite(event.atMs) && event.atMs >= startedMs) {
          writeState(operations, file, {
            ...pending,
            status: 'unknown',
            failure: 'alias_mutated_during_create',
            updatedAt: new Date().toISOString(),
          });
          stop('write_outcome_unknown', 'A mutation touched the generated alias while the create was in flight. The link may be dead; do not report or retry blindly.');
        }
        writeState(operations, file, record);
      } finally { release(); }
    } else {
      writeState(operations, file, record);
    }
    return result(record, false);
  }

  async function create(args = {}) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) stop('invalid_arguments', 'Provide a JSON object with url, optional domain, alias and expires_at.');
    const unknown = Object.keys(args).filter(key => !['url', 'domain', 'alias', 'expires_at'].includes(key));
    if (unknown.length) stop('invalid_arguments', `Unknown fields: ${unknown.join(', ')}.`);
    if (typeof args.url !== 'string') stop('invalid_url', 'Supply the exact absolute URL to shorten.');
    const input = {
      url: validateUrl(args.url),
      domain: validateDomain(args.domain),
      ...(args.alias === undefined ? {} : { alias: validateAlias(args.alias) }),
      ...(args.expires_at === undefined ? {} : { expires_at: validateExpiration(args.expires_at, 'expires_at') }),
    };
    const key = operationKey(input);
    const file = path.join(operations, `${key}.json`);
    if (inflight.has(key)) return inflight.get(key);
    const work = (async () => {
      const release = input.alias === undefined
        ? () => {}
        : await acquireAliasLocks(config.stateDir, [input.alias], Math.min(Math.max(timeoutMs * 2, 1000), 10000));
      try {
        if (input.alias !== undefined && readState(ambiguousMutationFile(config.stateDir, input.alias))) {
          stop('write_outcome_unknown', 'A previous mutation for this exact alias has an unknown outcome. Do not retry blindly; operator must reconcile the alias.');
        }
        return await createUnlocked(input, key, file);
      } finally { release(); }
    })().finally(() => inflight.delete(key));
    inflight.set(key, work);
    return work;
  }

  async function providerRequest({ method, pathname, body, write, token, writeHint }) {
    if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//') || pathname.includes('://')) {
      stop('internal_error', 'Connector refused a non-relative provider path.');
    }
    let response;
    try {
      response = await fetchImpl(`https://api.tinyurl.com${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      if (write) {
        stop('write_outcome_unknown', writeHint ?? 'The write request was interrupted or timed out and may have reached TinyURL. Do not retry blindly; reconcile the exact alias.');
      }
      stop(error?.name === 'TimeoutError' ? 'read_timeout' : 'read_failed', 'The TinyURL read did not complete and may be retried.');
    }
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        stop('api_rejected', `TinyURL rejected the request with HTTP ${response.status}.`);
      }
      if (write) stop('write_outcome_unknown', writeHint ?? `TinyURL returned HTTP ${response.status} and the write outcome is unknown. Do not retry blindly.`);
      stop('provider_unavailable', `TinyURL returned HTTP ${response.status} for the read.`);
    }
    let payload;
    try { payload = await readBoundedJson(response); } catch (error) {
      if (write) stop('write_outcome_unknown', writeHint ?? 'TinyURL returned an unreadable or oversized response and the write outcome is unknown. Do not retry blindly.');
      stop(error instanceof BodyTooLarge ? 'response_too_large' : 'response_invalid',
        error instanceof BodyTooLarge
          ? `TinyURL returned more than ${MAX_RESPONSE_BYTES} bytes. Narrow the date range or report scope.`
          : 'TinyURL returned an unreadable read response.');
    }
    if (payload?.code !== 0) {
      if (write && payload?.code === 7) {
        stop('write_outcome_unknown', writeHint ?? 'TinyURL reported an internal error for the write. The outcome is unknown; do not retry blindly.');
      }
      stop('api_rejected', 'TinyURL rejected the request with a provider error code.');
    }
    if (!isPlainObject(payload) || payload.data === null || typeof payload.data !== 'object') {
      if (write) stop('write_outcome_unknown', writeHint ?? 'TinyURL returned an incomplete response and the write outcome is unknown. Do not retry blindly.');
      stop('response_invalid', 'TinyURL returned an incomplete read response.');
    }
    return payload.data;
  }

  function parseAliasArgs(args) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) stop('invalid_arguments', 'Provide a JSON object with alias and optional domain.');
    const unknown = Object.keys(args).filter(key => !['alias', 'domain'].includes(key));
    if (unknown.length) stop('invalid_arguments', `Unknown fields: ${unknown.join(', ')}.`);
    if (typeof args.alias !== 'string') stop('invalid_alias', 'Supply the exact alias to read, update, change or delete.');
    return { alias: validateAlias(args.alias), domain: validateDomain(args.domain) };
  }

  function checkedTinyUrl(data, alias, required) {
    if (data.tiny_url === undefined && !required) return undefined;
    if (!shortUrlMatches(data.tiny_url, alias)) stop('response_invalid', 'TinyURL returned a short link that does not match the exact alias.');
    return data.tiny_url;
  }

  function clearMutationBarrier(aliases) {
    for (const alias of new Set(aliases)) {
      try { removeState(ambiguousMutationFile(config.stateDir, alias)); } catch {}
    }
  }

  function beginMutationBarriers(aliases, action) {
    const at = new Date().toISOString();
    const atMs = Date.now();
    for (const alias of new Set(aliases)) {
      writeState(path.join(config.stateDir, 'mutations', 'events'), aliasMutationEventFile(config.stateDir, alias), {
        domain: DOMAIN, alias, action, at, atMs,
      });
      writeState(path.join(config.stateDir, 'mutations'), ambiguousMutationFile(config.stateDir, alias), {
        domain: DOMAIN, alias, action, status: 'pending', at,
      });
    }
  }

  async function mutationRequest(aliases, request) {
    const unique = [...new Set(aliases)];
    for (const alias of unique) {
      if (readState(ambiguousMutationFile(config.stateDir, alias))) {
        stop('write_outcome_unknown', 'A previous mutation for this exact alias has an unknown outcome. Do not retry blindly; operator must reconcile the alias.');
      }
    }
    beginMutationBarriers(unique, request.pathname);
    try {
      return await providerRequest(request);
    } catch (error) {
      if (error?.code !== 'write_outcome_unknown') clearMutationBarrier(unique);
      throw error;
    }
  }

  async function read(args) {
    const input = parseAliasArgs(args);
    const token = readToken(config.tokenFile);
    const data = await providerRequest({
      method: 'GET',
      pathname: `/alias/${DOMAIN}/${encodeURIComponent(input.alias)}`,
      write: false,
      token,
    });
    if (data.domain !== DOMAIN || data.alias !== input.alias || typeof data.url !== 'string' || data.url.length > MAX_URL) {
      stop('response_invalid', 'TinyURL returned data that does not match the exact alias.');
    }
    const output = { status: 'ok', destination: data.url, domain: DOMAIN, alias: input.alias };
    const tinyUrl = checkedTinyUrl(data, input.alias, false);
    if (tinyUrl !== undefined) output.tinyUrl = tinyUrl;
    if (typeof data.deleted === 'boolean') output.deleted = data.deleted;
    if (typeof data.archived === 'boolean') output.archived = data.archived;
    if (Array.isArray(data.tags)) output.tags = data.tags.filter(tag => typeof tag === 'string' && tag.length <= 45).slice(0, 50);
    if (data.expires_at === null || (typeof data.expires_at === 'string' && data.expires_at.length <= 100)) output.expiresAt = data.expires_at;
    if (typeof data.created_at === 'string' && data.created_at.length <= 64) output.createdAt = data.created_at;
    if (data.analytics && typeof data.analytics === 'object') {
      output.analytics = {
        ...(typeof data.analytics.enabled === 'boolean' ? { enabled: data.analytics.enabled } : {}),
        ...(typeof data.analytics.public === 'boolean' ? { public: data.analytics.public } : {}),
      };
    }
    return output;
  }

  async function update(args) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) stop('invalid_arguments', 'Provide a JSON object with alias and metadata changes.');
    const allowed = ['alias', 'domain', 'new_alias', 'new_stats', 'new_tags', 'new_expires_at', 'new_description'];
    const unknown = Object.keys(args).filter(key => !allowed.includes(key));
    if (unknown.length) stop('invalid_arguments', `Unknown fields: ${unknown.join(', ')}.`);
    if (typeof args.alias !== 'string') stop('invalid_alias', 'Supply the exact alias to update.');
    const input = { alias: validateAlias(args.alias), domain: validateDomain(args.domain) };
    const changes = {};
    if (args.new_alias !== undefined) changes.new_alias = validateAlias(args.new_alias);
    if (args.new_stats !== undefined) {
      if (typeof args.new_stats !== 'boolean') stop('invalid_arguments', 'new_stats must be a boolean.');
      changes.new_stats = args.new_stats;
    }
    if (args.new_tags !== undefined) {
      if (!Array.isArray(args.new_tags) || args.new_tags.length > 50
        || args.new_tags.some(tag => typeof tag !== 'string' || tag.length < 1 || tag.length > 45)) {
        stop('invalid_arguments', 'new_tags must be an array of at most 50 non-empty strings of at most 45 characters.');
      }
      changes.new_tags = args.new_tags;
    }
    if (args.new_expires_at !== undefined) {
      changes.new_expires_at = validateExpiration(args.new_expires_at, 'new_expires_at');
    }
    if (args.new_description !== undefined) {
      if (args.new_description !== null && (typeof args.new_description !== 'string' || args.new_description.length < 3 || args.new_description.length > 1000)) {
        stop('invalid_arguments', 'new_description must be null or a string of 3-1000 characters.');
      }
      changes.new_description = args.new_description;
    }
    if (Object.keys(changes).length === 0) stop('invalid_arguments', 'Supply at least one new_alias, new_stats, new_tags, new_expires_at or new_description change.');
    const aliases = changes.new_alias === undefined ? [input.alias] : [input.alias, changes.new_alias];
    const release = await acquireAliasLocks(config.stateDir, aliases, Math.min(Math.max(timeoutMs * 2, 1000), 10000));
    try {
      const token = readToken(config.tokenFile);
      for (const alias of new Set(aliases)) markAliasReceiptsStale(operations, alias);
      const data = await mutationRequest(aliases, {
        method: 'PATCH',
        pathname: '/update',
        body: { domain: DOMAIN, alias: input.alias, ...changes },
        write: true,
        token,
      });
      const alias = changes.new_alias ?? input.alias;
      if (data.domain !== DOMAIN || data.alias !== alias
        || (data.url !== undefined && (typeof data.url !== 'string' || data.url.length > MAX_URL))) {
        stop('write_outcome_unknown', 'TinyURL did not confirm the updated domain and alias. The write may have been applied; do not retry blindly.');
      }
      let tinyUrl;
      if (data.tiny_url !== undefined && !shortUrlMatches(data.tiny_url, alias)) {
        stop('write_outcome_unknown', 'TinyURL returned a short link that does not match the updated alias. The write may have been applied; do not retry blindly.');
      }
      if (data.tiny_url !== undefined) tinyUrl = data.tiny_url;
      let expiresAt = data.expires_at;
      if (changes.new_expires_at !== undefined) {
        if (expiresAt === undefined) {
          let current;
          try {
            current = await providerRequest({
              method: 'GET',
              pathname: `/alias/${DOMAIN}/${encodeURIComponent(alias)}`,
              write: false,
              token,
            });
          } catch {
            stop('write_outcome_unknown', 'The update response did not confirm the expiration and the verification read failed. The write may have been applied; do not retry blindly.');
          }
          if (current.domain !== DOMAIN || current.alias !== alias) {
            stop('write_outcome_unknown', 'The update response did not confirm the expiration and the verification read returned another alias. The write may have been applied; do not retry blindly.');
          }
          expiresAt = current.expires_at;
        }
        if (!expirationMatches(changes.new_expires_at, expiresAt ?? null)) {
          stop('write_outcome_unknown', 'TinyURL did not confirm the requested expiration. The write may have been applied; do not retry blindly.');
        }
      }
      clearMutationBarrier(aliases);
      const output = { status: 'ok', action: 'updated', domain: DOMAIN, alias, destination: data.url };
      if (tinyUrl !== undefined) output.tinyUrl = tinyUrl;
      if (expiresAt === null || (typeof expiresAt === 'string' && expiresAt.length <= 100)) output.expiresAt = expiresAt;
      if (Array.isArray(data.tags)) output.tags = data.tags.filter(tag => typeof tag === 'string' && tag.length <= 45).slice(0, 50);
      if (typeof data.analytics === 'object' && data.analytics) {
        output.analytics = {
          ...(typeof data.analytics.enabled === 'boolean' ? { enabled: data.analytics.enabled } : {}),
          ...(typeof data.analytics.public === 'boolean' ? { public: data.analytics.public } : {}),
        };
      }
      return output;
    } finally { release(); }
  }

  async function changeDestination(args) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) stop('invalid_arguments', 'Provide a JSON object with alias, url and optional domain.');
    const unknown = Object.keys(args).filter(key => !['alias', 'domain', 'url'].includes(key));
    if (unknown.length) stop('invalid_arguments', `Unknown fields: ${unknown.join(', ')}.`);
    if (typeof args.alias !== 'string') stop('invalid_alias', 'Supply the exact alias whose destination will change.');
    if (typeof args.url !== 'string') stop('invalid_url', 'Supply the exact new absolute http(s) destination URL.');
    const input = { alias: validateAlias(args.alias), domain: validateDomain(args.domain), url: validateUrl(args.url) };
    const release = await acquireAliasLocks(config.stateDir, [input.alias], Math.min(Math.max(timeoutMs * 2, 1000), 10000));
    try {
      const token = readToken(config.tokenFile);
      markAliasReceiptsStale(operations, input.alias);
      const data = await mutationRequest([input.alias], {
        method: 'PATCH',
        pathname: '/change',
        body: { domain: DOMAIN, alias: input.alias, url: input.url },
        write: true,
        token,
      });
      if (data.url !== input.url
        || (data.domain !== undefined && data.domain !== DOMAIN)
        || (data.alias !== undefined && data.alias !== input.alias)) {
        stop('write_outcome_unknown', 'TinyURL did not confirm the exact new destination. The write may have been applied; do not retry blindly.');
      }
      clearMutationBarrier([input.alias]);
      return { status: 'ok', action: 'destination_changed', destination: input.url, domain: DOMAIN, alias: input.alias };
    } finally { release(); }
  }

  async function remove(args) {
    const input = parseAliasArgs(args);
    const release = await acquireAliasLocks(config.stateDir, [input.alias], Math.min(Math.max(timeoutMs * 2, 1000), 10000));
    try {
      const token = readToken(config.tokenFile);
      markAliasReceiptsStale(operations, input.alias);
      const data = await mutationRequest([input.alias], {
        method: 'DELETE',
        pathname: `/alias/${DOMAIN}/${encodeURIComponent(input.alias)}`,
        write: true,
        token,
      });
      if (data.domain !== DOMAIN || data.alias !== input.alias) {
        stop('write_outcome_unknown', 'TinyURL did not confirm deletion of the exact domain and alias. The write may have been applied; do not retry blindly.');
      }
      clearMutationBarrier([input.alias]);
      const output = { status: 'ok', action: 'deleted', domain: DOMAIN, alias: input.alias };
      if (typeof data.url === 'string' && data.url.length <= MAX_URL) output.destination = data.url;
      return output;
    } finally { release(); }
  }

  function validateTagsInput(value, field) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 50
      || value.some(tag => typeof tag !== 'string' || tag.length < 1 || tag.length > 45)) {
      stop('invalid_arguments', `${field} must be an array of at most 50 non-empty strings of at most 45 characters.`);
    }
    return value;
  }

  function validateDescriptionInput(value, field) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'string' || value.length < 3 || value.length > 1000) {
      stop('invalid_arguments', `${field} must be null or a string of 3-1000 characters.`);
    }
    return value;
  }

  function validateMetadataInput(value) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 20) {
      stop('invalid_arguments', 'metadata must be an array of at most 20 string, number or boolean values.');
    }
    for (const item of value) {
      if (typeof item === 'string' ? item.length > 1000 : typeof item === 'number' ? !Number.isFinite(item) : typeof item !== 'boolean') {
        stop('invalid_arguments', 'metadata must be an array of at most 20 string, number or boolean values.');
      }
    }
    return value;
  }

  function validateTagInput(value) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length < 1 || value.length > 100 || [...value].some(char => char.charCodeAt(0) < 32)) {
      stop('invalid_arguments', 'tag must be a non-empty single-line string of at most 100 characters.');
    }
    return value;
  }

  function validateAliasInput(value, field) {
    if (typeof value !== 'string') stop('invalid_alias', `${field} must be the exact alias.`);
    return validateAlias(value);
  }

  function parseAnalyticsScope(args) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) stop('invalid_arguments', 'Provide a JSON object with analytics parameters.');
    const input = {
      from: validateAnalyticsInstant(args.from, 'from', true),
      to: validateAnalyticsInstant(args.to, 'to', false),
      alias: args.alias === undefined ? undefined : validateAliasInput(args.alias, 'alias'),
      domain: validateDomain(args.domain),
      tag: validateTagInput(args.tag),
    };
    if (input.from !== undefined && input.to !== undefined) {
      const fromMs = Date.parse(input.from.replace(' ', 'T'));
      const toMs = Date.parse(input.to.replace(' ', 'T'));
      if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs < fromMs) {
        stop('invalid_datetime', 'to must not be earlier than from.');
      }
    }
    return input;
  }

  function analyticsQuery(input, extra) {
    const query = new URLSearchParams();
    query.set('from', input.from);
    if (input.to !== undefined) query.set('to', input.to);
    if (extra.interval !== undefined) query.set('interval', extra.interval);
    if (input.alias !== undefined) query.set('alias', `${DOMAIN}/${input.alias}`);
    if (input.tag !== undefined) query.set('tag', input.tag);
    return query.toString();
  }

  function sanitizeBucket(item) {
    if (!isPlainObject(item)) return undefined;
    const output = {};
    const name = text(item.name, 200);
    if (name !== undefined) output.name = name;
    if (count(item.value) !== undefined) output.value = item.value;
    if (Array.isArray(item.children)) {
      const children = boundedItems(item.children, MAX_CHILDREN, child => {
        if (!isPlainObject(child)) return undefined;
        const out = {};
        const childName = text(child.name, 200);
        if (childName !== undefined) out.name = childName;
        if (count(child.value) !== undefined) out.value = child.value;
        return Object.keys(out).length ? out : undefined;
      });
      output.children = children.items;
      if (children.truncated) output.childrenTruncated = true;
    }
    return Object.keys(output).length ? output : undefined;
  }

  function sanitizeGeneralDimensions(item) {
    if (!isPlainObject(item)) return undefined;
    const dataset = {};
    let returned = 0;
    let total = 0;
    let truncated = false;
    for (const key of ['browser', 'os', 'device']) {
      if (item[key] === undefined) continue;
      if (!Array.isArray(item[key])) stop('response_invalid', `TinyURL returned an unexpected ${key} analytics list.`);
      const bucket = boundedItems(item[key], MAX_ANALYTICS_ITEMS, sanitizeBucket);
      dataset[key] = bucket.items;
      returned += bucket.items.length;
      total += bucket.total;
      if (bucket.truncated) truncated = true;
    }
    return { dataset, returned, total, truncated };
  }

  function sanitizeAnalyticsReport(report, data) {
    if (!isPlainObject(data)) stop('response_invalid', 'TinyURL returned an unexpected analytics report shape.');
    if (report === 'timeline') {
      const dataset = boundedItems(data.dataset, MAX_TIMELINE_POINTS, item => {
        if (!isPlainObject(item)) return undefined;
        const out = {};
        const datetime = text(item.datetime, 64);
        if (datetime !== undefined) out.datetime = datetime;
        for (const key of ['total', 'unique', 'human']) if (count(item[key]) !== undefined) out[key] = item[key];
        return Object.keys(out).length ? out : undefined;
      });
      return {
        data: {
          dataset: dataset.items,
          ...(INTERVALS.includes(data.interval) ? { interval: data.interval } : {}),
          ...(text(data.timezone, 32) !== undefined ? { timezone: data.timezone } : {}),
        },
        bounded: { returned: dataset.items.length, total: dataset.total, truncated: dataset.truncated },
      };
    }
    if (report === 'general') {
      if (isPlainObject(data.dataset)) {
        const dimensions = sanitizeGeneralDimensions(data.dataset);
        return {
          data: { dataset: dimensions.dataset, ...(count(data.total) !== undefined ? { total: data.total } : {}) },
          bounded: { returned: dimensions.returned, total: dimensions.total, truncated: dimensions.truncated },
        };
      }
      let truncated = false;
      const dataset = boundedItems(data.dataset, MAX_ANALYTICS_ITEMS, item => {
        const dimensions = sanitizeGeneralDimensions(item);
        if (dimensions === undefined) return undefined;
        if (dimensions.truncated) truncated = true;
        return dimensions.dataset;
      });
      if (dataset.truncated) truncated = true;
      return {
        data: { dataset: dataset.items, ...(count(data.total) !== undefined ? { total: data.total } : {}) },
        bounded: { returned: dataset.items.length, total: dataset.total, truncated },
      };
    }
    if (report === 'weekday' || report === 'hour') {
      const expected = report === 'weekday' ? 7 : 24;
      if (!Array.isArray(data.dataset) || data.dataset.length !== expected || data.dataset.some(item => count(item) === undefined)) {
        stop('response_invalid', `TinyURL returned an unexpected ${report} popularity dataset.`);
      }
      return { data: { dataset: data.dataset }, bounded: { returned: data.dataset.length, total: data.dataset.length, truncated: false } };
    }
    const key = report === 'top_sources' ? 'source' : report === 'top_languages' ? 'language' : 'name';
    const dataset = boundedItems(data.dataset, MAX_ANALYTICS_ITEMS, item => {
      if (!isPlainObject(item)) return undefined;
      const out = {};
      const label = text(item[key], 200);
      if (label !== undefined) out[key] = label;
      if (count(item.hits) !== undefined) out.hits = item.hits;
      if (count(item.value) !== undefined) out.value = item.value;
      return Object.keys(out).length ? out : undefined;
    });
    return {
      data: {
        dataset: dataset.items,
        ...(count(data.total) !== undefined ? { total: data.total } : {}),
        ...(count(data.direct) !== undefined ? { direct: data.direct } : {}),
        ...(count(data.none) !== undefined ? { none: data.none } : {}),
      },
      bounded: { returned: dataset.items.length, total: dataset.total, truncated: dataset.truncated },
    };
  }

  async function analyticsReport(args) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) stop('invalid_arguments', 'Provide a JSON object with report, from and optional filters.');
    const allowed = ['report', 'from', 'to', 'interval', 'alias', 'domain', 'tag', 'region'];
    const unknown = Object.keys(args).filter(key => !allowed.includes(key));
    if (unknown.length) stop('invalid_arguments', `Unknown fields: ${unknown.join(', ')}.`);
    if (!ANALYTICS_REPORTS.includes(args.report)) stop('invalid_report', `report must be one of ${ANALYTICS_REPORTS.join(', ')}.`);
    const input = parseAnalyticsScope(args);
    if (args.interval !== undefined && args.report !== 'timeline') stop('invalid_arguments', 'interval is valid only for the timeline report.');
    if (args.interval !== undefined && !INTERVALS.includes(args.interval)) stop('invalid_interval', `interval must be one of ${INTERVALS.join(', ')}.`);
    if (args.region !== undefined && args.report !== 'location') stop('invalid_arguments', 'region is valid only for the location report.');
    if (args.report === 'location' && args.region !== undefined && !REGION.test(args.region)) {
      stop('invalid_region', 'region must be world or a two-letter ISO 3166-1 country code.');
    }
    const report = args.report;
    const region = report === 'location' ? (args.region ?? 'world') : undefined;
    const base = {
      timeline: '/analytics/timeline',
      general: '/analytics/general',
      weekday: '/analytics/popularity/weekday',
      hour: '/analytics/popularity/hour',
      top_sources: '/analytics/sources/top',
      top_languages: '/analytics/languages/top',
      location: `/analytics/location/${encodeURIComponent(region)}`,
    }[report];
    const token = readToken(config.tokenFile);
    const data = await providerRequest({
      method: 'GET',
      pathname: `${base}?${analyticsQuery(input, { interval: args.interval })}`,
      write: false,
      token,
    });
    const sanitized = sanitizeAnalyticsReport(report, data);
    return {
      status: 'ok',
      report,
      from: input.from,
      ...(input.to === undefined ? {} : { to: input.to }),
      ...(args.interval === undefined ? {} : { interval: args.interval }),
      ...(input.alias === undefined ? {} : { alias: input.alias }),
      domain: DOMAIN,
      ...(input.tag === undefined ? {} : { tag: input.tag }),
      ...(region === undefined ? {} : { region }),
      ...sanitized,
    };
  }

  function sanitizeRawLog(item) {
    if (!isPlainObject(item)) stop('response_invalid', 'TinyURL returned an unexpected raw log row.');
    const output = {};
    for (const [key, max] of [['datetime', 64], ['tiny_url', MAX_URL], ['url', MAX_URL], ['ip', 64], ['device', 64], ['language', 32]]) {
      const value = text(item[key], max);
      if (value !== undefined) output[key] = value;
    }
    for (const key of ['referer', 'country']) {
      const value = nullableText(item[key], key === 'referer' ? MAX_URL : 8);
      if (value !== undefined) output[key] = value;
    }
    if (typeof item.is_bot === 'boolean' || item.is_bot === null) output.is_bot = item.is_bot;
    for (const key of ['browser', 'os']) {
      if (!isPlainObject(item[key])) continue;
      const nested = {};
      const name = nullableText(item[key].name, 100);
      const version = nullableText(item[key].version, 100);
      if (name !== undefined) nested.name = name;
      if (version !== undefined) nested.version = version;
      if (Object.keys(nested).length) output[key] = nested;
    }
    if (Array.isArray(item.tags)) {
      output.tags = item.tags.filter(tag => typeof tag === 'string' && tag.length <= 45).slice(0, 50);
    }
    return output;
  }

  async function rawLogs(args) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) stop('invalid_arguments', 'Provide a JSON object with from and optional filters.');
    const allowed = ['from', 'to', 'alias', 'domain', 'tag', 'limit', 'offset'];
    const unknown = Object.keys(args).filter(key => !allowed.includes(key));
    if (unknown.length) stop('invalid_arguments', `Unknown fields: ${unknown.join(', ')}.`);
    const input = parseAnalyticsScope(args);
    const limit = args.limit ?? 100;
    const offset = args.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RAW_LOG_PAGE) {
      stop('invalid_arguments', `limit must be an integer between 1 and ${MAX_RAW_LOG_PAGE}.`);
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > MAX_RAW_LOGS_FETCH) {
      stop('invalid_arguments', `offset must be an integer between 0 and ${MAX_RAW_LOGS_FETCH}.`);
    }
    const token = readToken(config.tokenFile);
    const data = await providerRequest({
      method: 'GET',
      pathname: `/analytics/raw/json?${analyticsQuery(input, {})}`,
      write: false,
      token,
    });
    if (!Array.isArray(data)) stop('response_invalid', 'TinyURL returned an unexpected raw analytics response.');
    if (data.length > MAX_RAW_LOGS_FETCH) {
      stop('response_too_large', `TinyURL returned more than ${MAX_RAW_LOGS_FETCH} raw log rows. Narrow the date range.`);
    }
    const from = Math.min(offset, data.length);
    const page = data.slice(from, from + limit);
    const logs = page.map(sanitizeRawLog);
    const hasMore = from + logs.length < data.length;
    return {
      status: 'ok',
      report: 'raw_logs',
      from: input.from,
      ...(input.to === undefined ? {} : { to: input.to }),
      ...(input.alias === undefined ? {} : { alias: input.alias }),
      domain: DOMAIN,
      ...(input.tag === undefined ? {} : { tag: input.tag }),
      offset: from,
      limit,
      total: data.length,
      returned: logs.length,
      hasMore,
      nextOffset: hasMore ? from + logs.length : null,
      logs,
    };
  }

  async function setAnalyticsFlag(kind, args) {
    const flag = kind === 'status' ? 'enabled' : 'public';
    const pathname = kind === 'status' ? '/analytics/status' : '/analytics/sharing';
    if (args === null || typeof args !== 'object' || Array.isArray(args)) stop('invalid_arguments', `Provide alias, domain and ${flag}.`);
    const unknown = Object.keys(args).filter(key => !['alias', 'domain', flag].includes(key));
    if (unknown.length) stop('invalid_arguments', `Unknown fields: ${unknown.join(', ')}.`);
    const input = {
      alias: validateAliasInput(args.alias, 'alias'),
      domain: validateDomain(args.domain),
    };
    if (!has(args, flag) || typeof args[flag] !== 'boolean') stop('invalid_arguments', `${flag} must be a boolean.`);
    const value = args[flag];
    const release = await acquireAliasLocks(config.stateDir, [input.alias], Math.min(Math.max(timeoutMs * 2, 1000), 10000));
    try {
      const token = readToken(config.tokenFile);
      markAliasReceiptsStale(operations, input.alias);
      const data = await mutationRequest([input.alias], {
        method: 'PATCH',
        pathname,
        body: { domain: DOMAIN, alias: input.alias, [flag]: value },
        write: true,
        token,
      });
      if (data.domain !== DOMAIN || data.alias !== input.alias) {
        stop('write_outcome_unknown', 'TinyURL did not confirm the exact domain and alias. The analytics write may have been applied; do not retry blindly.');
      }
      let actual = isPlainObject(data.analytics) ? data.analytics[flag] : undefined;
      if (actual === undefined) {
        let current;
        try {
          current = await providerRequest({
            method: 'GET',
            pathname: `/alias/${DOMAIN}/${encodeURIComponent(input.alias)}`,
            write: false,
            token,
          });
        } catch {
          stop('write_outcome_unknown', 'The analytics write response did not confirm the setting and the verification read failed. The write may have been applied; do not retry blindly.');
        }
        if (current.domain !== DOMAIN || current.alias !== input.alias || !isPlainObject(current.analytics)) {
          stop('write_outcome_unknown', 'The analytics write response did not confirm the setting and the verification read was inconclusive. The write may have been applied; do not retry blindly.');
        }
        actual = current.analytics[flag];
      }
      if (actual !== value) {
        stop('write_outcome_unknown', 'TinyURL did not confirm the requested analytics setting. The write may have been applied; do not retry blindly.');
      }
      clearMutationBarrier([input.alias]);
      return {
        status: 'ok',
        action: kind === 'status' ? 'analytics_status_updated' : 'analytics_sharing_updated',
        domain: DOMAIN,
        alias: input.alias,
        [flag]: value,
      };
    } finally { release(); }
  }

  async function archive(args) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) stop('invalid_arguments', 'Provide alias, optional domain and action.');
    const unknown = Object.keys(args).filter(key => !['alias', 'domain', 'action'].includes(key));
    if (unknown.length) stop('invalid_arguments', `Unknown fields: ${unknown.join(', ')}.`);
    const input = { alias: validateAliasInput(args.alias, 'alias'), domain: validateDomain(args.domain) };
    if (!['toggle', 'archive', 'unarchive'].includes(args.action)) {
      stop('invalid_arguments', 'action must be toggle, archive or unarchive.');
    }
    const release = await acquireAliasLocks(config.stateDir, [input.alias], Math.min(Math.max(timeoutMs * 2, 1000), 10000));
    try {
      if (readState(ambiguousMutationFile(config.stateDir, input.alias))) {
        stop('write_outcome_unknown', 'A previous mutation for this exact alias has an unknown outcome. Do not retry blindly; operator must reconcile the alias.');
      }
      const token = readToken(config.tokenFile);
      let before;
      try {
        before = await providerRequest({
          method: 'GET',
          pathname: `/alias/${DOMAIN}/${encodeURIComponent(input.alias)}`,
          write: false,
          token,
        });
      } catch {
        stop('read_failed', 'The archive state could not be read, so no toggle was attempted.');
      }
      if (before.domain !== DOMAIN || before.alias !== input.alias || typeof before.archived !== 'boolean') {
        stop('response_invalid', 'TinyURL did not return the exact alias archive state, so no toggle was attempted.');
      }
      const desired = args.action === 'archive' ? true : args.action === 'unarchive' ? false : !before.archived;
      if (desired === before.archived) {
        return {
          status: 'ok',
          action: desired ? 'archived' : 'unarchived',
          changed: false,
          wasArchived: before.archived,
          archived: before.archived,
          domain: DOMAIN,
          alias: input.alias,
        };
      }
      markAliasReceiptsStale(operations, input.alias);
      const data = await mutationRequest([input.alias], {
        method: 'PATCH',
        pathname: '/archive',
        body: { domain: DOMAIN, alias: input.alias },
        write: true,
        token,
      });
      if (data.domain !== DOMAIN || data.alias !== input.alias) {
        stop('write_outcome_unknown', 'TinyURL did not confirm the exact archive target. The write may have been applied; do not retry blindly.');
      }
      let after = data.archived;
      if (typeof after !== 'boolean') {
        try {
          const current = await providerRequest({
            method: 'GET',
            pathname: `/alias/${DOMAIN}/${encodeURIComponent(input.alias)}`,
            write: false,
            token,
          });
          if (current.domain !== DOMAIN || current.alias !== input.alias || typeof current.archived !== 'boolean') {
            stop('write_outcome_unknown', 'The archive response and verification read were inconclusive. The write may have been applied; do not retry blindly.');
          }
          after = current.archived;
        } catch (error) {
          if (error?.code === 'write_outcome_unknown') throw error;
          stop('write_outcome_unknown', 'The archive response did not confirm the state and the verification read failed. The write may have been applied; do not retry blindly.');
        }
      }
      if (after !== desired) {
        stop('write_outcome_unknown', 'TinyURL returned an unexpected archive state. The write may have been applied; do not retry blindly.');
      }
      clearMutationBarrier([input.alias]);
      return {
        status: 'ok',
        action: args.action === 'toggle' ? 'toggled' : desired ? 'archived' : 'unarchived',
        changed: true,
        wasArchived: before.archived,
        archived: after,
        domain: DOMAIN,
        alias: input.alias,
      };
    } finally { release(); }
  }

  async function setExpiration(args) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) stop('invalid_arguments', 'Provide alias, optional domain and new_expires_at.');
    const unknown = Object.keys(args).filter(key => !['alias', 'domain', 'new_expires_at'].includes(key));
    if (unknown.length) stop('invalid_arguments', `Unknown fields: ${unknown.join(', ')}.`);
    if (!has(args, 'new_expires_at')) stop('invalid_arguments', 'new_expires_at is required; use null so the link never expires.');
    const output = await update({ alias: args.alias, domain: args.domain, new_expires_at: args.new_expires_at });
    return { ...output, action: 'expiration_set', expiresAt: output.expiresAt ?? args.new_expires_at };
  }

  function bulkAffectedAliases(items) {
    const aliases = [];
    for (const item of items) {
      if (item.alias !== undefined) aliases.push(item.alias);
      if (item.new_alias !== undefined) aliases.push(item.new_alias);
    }
    return [...new Set(aliases)];
  }

  function normalizeBulkItem(value, index) {
    if (!isPlainObject(value)) stop('invalid_arguments', `items[${index}] must be an object.`);
    if (!BULK_OPERATIONS.includes(value.operation)) {
      stop('invalid_arguments', `items[${index}].operation must be one of ${BULK_OPERATIONS.join(', ')}.`);
    }
    const operation = value.operation;
    const allowed = {
      create: ['operation', 'url', 'domain', 'alias', 'tags', 'expires_at', 'description', 'metadata'],
      update: ['operation', 'domain', 'alias', 'new_alias', 'new_stats', 'new_tags', 'new_expires_at', 'new_description', 'metadata'],
      change: ['operation', 'domain', 'alias', 'url', 'metadata'],
      delete: ['operation', 'domain', 'alias', 'metadata'],
      archive: ['operation', 'domain', 'alias', 'metadata'],
      unarchive: ['operation', 'domain', 'alias', 'metadata'],
    }[operation];
    const unknown = Object.keys(value).filter(key => !allowed.includes(key));
    if (unknown.length) stop('invalid_arguments', `items[${index}] has unknown fields: ${unknown.join(', ')}.`);
    const metadata = validateMetadataInput(value.metadata);
    if (operation === 'create') {
      if (typeof value.url !== 'string') stop('invalid_url', `items[${index}].url must be the exact absolute http(s) URL.`);
      return {
        operation,
        url: validateUrl(value.url),
        domain: validateDomain(value.domain),
        ...(value.alias === undefined ? {} : { alias: validateAliasInput(value.alias, `items[${index}].alias`) }),
        ...(value.tags === undefined ? {} : { tags: validateTagsInput(value.tags, `items[${index}].tags`) }),
        ...(value.expires_at === undefined ? {} : { expires_at: validateExpiration(value.expires_at, `items[${index}].expires_at`) }),
        ...(value.description === undefined ? {} : { description: validateDescriptionInput(value.description, `items[${index}].description`) }),
        ...(metadata === undefined ? {} : { metadata }),
      };
    }
    const item = { operation, domain: validateDomain(value.domain), alias: validateAliasInput(value.alias, `items[${index}].alias`) };
    if (operation === 'update') {
      const changes = {};
      if (value.new_alias !== undefined) changes.new_alias = validateAliasInput(value.new_alias, `items[${index}].new_alias`);
      if (value.new_stats !== undefined) {
        if (typeof value.new_stats !== 'boolean') stop('invalid_arguments', `items[${index}].new_stats must be a boolean.`);
        changes.new_stats = value.new_stats;
      }
      if (value.new_tags !== undefined) changes.new_tags = validateTagsInput(value.new_tags, `items[${index}].new_tags`);
      if (value.new_expires_at !== undefined) changes.new_expires_at = validateExpiration(value.new_expires_at, `items[${index}].new_expires_at`);
      if (value.new_description !== undefined) changes.new_description = validateDescriptionInput(value.new_description, `items[${index}].new_description`);
      if (Object.keys(changes).length === 0) stop('invalid_arguments', `items[${index}] update needs at least one new_* field.`);
      return { ...item, ...changes, ...(metadata === undefined ? {} : { metadata }) };
    }
    if (operation === 'change') {
      if (typeof value.url !== 'string') stop('invalid_url', `items[${index}].url must be the exact absolute http(s) URL.`);
      return { ...item, url: validateUrl(value.url), ...(metadata === undefined ? {} : { metadata }) };
    }
    return { ...item, ...(metadata === undefined ? {} : { metadata }) };
  }

  function parseBulkCreate(args) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) stop('invalid_arguments', 'Provide a JSON object with items.');
    const unknown = Object.keys(args).filter(key => !['domain', 'items'].includes(key));
    if (unknown.length) stop('invalid_arguments', `Unknown fields: ${unknown.join(', ')}.`);
    const domain = validateDomain(args.domain);
    if (!Array.isArray(args.items) || args.items.length < 1 || args.items.length > MAX_BULK_ITEMS) {
      stop('invalid_arguments', `items must contain between 1 and ${MAX_BULK_ITEMS} operations.`);
    }
    return { domain, items: args.items.map(normalizeBulkItem) };
  }

  function bulkKey(input) {
    return createHash('sha256').update(canonical(input)).digest('hex');
  }

  async function acquireLockDirectory(lock, waitMs) {
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    ensureStateDirs(path.dirname(lock));
    const until = Date.now() + waitMs;
    for (;;) {
      try {
        fs.mkdirSync(lock, { mode: 0o700 });
        return () => { try { fs.rmdirSync(lock); } catch {} };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const info = fs.statSync(lock);
          if (Date.now() - info.mtimeMs > LOCK_STALE_MS) { fs.rmdirSync(lock); continue; }
        } catch { continue; }
        if (Date.now() >= until) stop('operation_in_progress', 'Another bulk operation is in progress. Retry after it finishes.');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }

  function readBulkReceipt(key) {
    const record = readState(path.join(bulkReceipts, `${key}.json`));
    if (record === null) return null;
    if (!isPlainObject(record) || record.key !== key || !Number.isSafeInteger(record.bulkRequestId) || record.bulkRequestId < 1
      || ![0, 1, 2].includes(record.requestStatus) || !Array.isArray(record.aliases)) {
      stop('state_unreadable', 'Operator must repair or remove the private bulk receipt.');
    }
    return record;
  }

  function bulkCreateOutput(record, reused) {
    return {
      status: 'ok',
      action: 'bulk_created',
      bulkRequestId: record.bulkRequestId,
      requestStatus: record.requestStatus,
      ...(OPERATION_LABEL[record.requestStatus] === undefined ? {} : { requestStatusLabel: OPERATION_LABEL[record.requestStatus] }),
      ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
      ...(record.updatedAt === undefined ? {} : { updatedAt: record.updatedAt }),
      ...(record.total === undefined ? {} : { total: record.total }),
      ...(record.success === undefined ? {} : { success: record.success }),
      ...(record.failed === undefined ? {} : { failed: record.failed }),
      reused,
    };
  }

  function parseBulkStatus(data, write) {
    const code = write ? 'write_outcome_unknown' : 'response_invalid';
    const next = write
      ? 'TinyURL returned an unexpected bulk status and the write outcome is unknown. Do not retry blindly; reconcile the batch in TinyURL.'
      : 'TinyURL returned an unexpected bulk status.';
    if (!isPlainObject(data) || !Number.isSafeInteger(data.id) || data.id < 1 || ![0, 1, 2].includes(data.status)) stop(code, next);
    return {
      bulkRequestId: data.id,
      requestStatus: data.status,
      ...(text(data.created_at, 64) === undefined ? {} : { createdAt: data.created_at }),
      ...(text(data.updated_at, 64) === undefined ? {} : { updatedAt: data.updated_at }),
      ...(count(data.total) === undefined ? {} : { total: data.total }),
      ...(count(data.success) === undefined ? {} : { success: data.success }),
      ...(count(data.failed) === undefined ? {} : { failed: data.failed }),
    };
  }

  async function bulkCreate(args) {
    const input = parseBulkCreate(args);
    const key = bulkKey(input);
    const releaseLock = await acquireLockDirectory(bulkLock, Math.min(Math.max(timeoutMs * 2, 1000), 10000));
    try {
      const receipt = readBulkReceipt(key);
      const barrier = readState(bulkBarrier);
      if (barrier) {
        if (isPlainObject(barrier) && barrier.key === key && receipt) {
          clearMutationBarrier(receipt.aliases);
          try { removeState(bulkBarrier); } catch {}
          return bulkCreateOutput(receipt, true);
        }
        stop('write_outcome_unknown', 'A previous bulk write has an unknown outcome. Do not retry blindly; reconcile the batch in TinyURL, then remove the private bulk barrier.');
      }
      if (receipt) return bulkCreateOutput(receipt, true);

      const token = readToken(config.tokenFile);
      const aliases = bulkAffectedAliases(input.items);
      const releaseAliases = aliases.length
        ? await acquireAliasLocks(config.stateDir, aliases, Math.min(Math.max(timeoutMs * 2, 1000), 10000))
        : () => {};
      try {
        for (const alias of aliases) {
          if (readState(ambiguousMutationFile(config.stateDir, alias))) {
            stop('write_outcome_unknown', 'A previous mutation for an alias in this batch has an unknown outcome. Do not submit the batch; reconcile that alias first.');
          }
        }
        for (const alias of aliases) markAliasReceiptsStale(operations, alias);
        const at = new Date().toISOString();
        writeState(bulkDir, bulkBarrier, { key, action: 'POST /bulk', itemCount: input.items.length, aliases, status: 'pending', at });
        beginMutationBarriers(aliases, 'POST /bulk');
        let data;
        try {
          data = await providerRequest({
            method: 'POST',
            pathname: '/bulk',
            body: input,
            write: true,
            token,
            writeHint: 'The bulk write may have reached TinyURL and its outcome is unknown. Do not resubmit; reconcile the batch in TinyURL.',
          });
        } catch (error) {
          if (error?.code !== 'write_outcome_unknown') {
            clearMutationBarrier(aliases);
            try { removeState(bulkBarrier); } catch {}
          }
          throw error;
        }
        const status = parseBulkStatus(data, true);
        const record = {
          key,
          ...status,
          aliases,
          createdAtRecord: at,
        };
        writeState(bulkReceipts, path.join(bulkReceipts, `${key}.json`), record);
        clearMutationBarrier(aliases);
        try { removeState(bulkBarrier); } catch {}
        return bulkCreateOutput(record, false);
      } finally { releaseAliases(); }
    } finally { releaseLock(); }
  }

  function parseBulkId(value) {
    if (!Number.isSafeInteger(value) || value < 1) stop('invalid_bulk_request_id', 'bulkRequestId must be a positive integer.');
    return value;
  }

  async function bulkStatus(args) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) stop('invalid_arguments', 'Provide bulkRequestId.');
    const unknown = Object.keys(args).filter(key => key !== 'bulkRequestId');
    if (unknown.length) stop('invalid_arguments', `Unknown fields: ${unknown.join(', ')}.`);
    const id = parseBulkId(args.bulkRequestId);
    const token = readToken(config.tokenFile);
    const data = await providerRequest({
      method: 'GET',
      pathname: `/bulk/${id}/status`,
      write: false,
      token,
    });
    const status = parseBulkStatus(data, false);
    return {
      status: 'ok',
      action: 'bulk_status',
      ...status,
      ...(OPERATION_LABEL[status.requestStatus] === undefined ? {} : { requestStatusLabel: OPERATION_LABEL[status.requestStatus] }),
    };
  }

  function sanitizeBulkReportItem(item) {
    if (!isPlainObject(item) || !BULK_OPERATIONS.includes(item.operation) || !['success', 'failed'].includes(item.status)) {
      stop('response_invalid', 'TinyURL returned an unexpected bulk report row.');
    }
    const output = { operation: item.operation, status: item.status };
    for (const [key, max] of [['domain', 253], ['alias', 30], ['url', MAX_URL], ['tinyurl', MAX_URL], ['expires_at', 100], ['comment', 2000]]) {
      const value = text(item[key], max);
      if (value !== undefined) output[key] = value;
    }
    if (Array.isArray(item.metadata)) {
      output.metadata = item.metadata
        .filter(value => typeof value === 'string' ? value.length <= 1000 : typeof value === 'number' ? Number.isFinite(value) : typeof value === 'boolean')
        .slice(0, 20);
    }
    return output;
  }

  async function bulkReport(args) {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) stop('invalid_arguments', 'Provide bulkRequestId and optional offset and limit.');
    const unknown = Object.keys(args).filter(key => !['bulkRequestId', 'offset', 'limit'].includes(key));
    if (unknown.length) stop('invalid_arguments', `Unknown fields: ${unknown.join(', ')}.`);
    const id = parseBulkId(args.bulkRequestId);
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 100;
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000) stop('invalid_arguments', 'offset must be an integer between 0 and 100000.');
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BULK_REPORT_PAGE) {
      stop('invalid_arguments', `limit must be an integer between 1 and ${MAX_BULK_REPORT_PAGE}.`);
    }
    const token = readToken(config.tokenFile);
    const data = await providerRequest({
      method: 'GET',
      pathname: `/bulk/${id}/report`,
      write: false,
      token,
    });
    if (!Array.isArray(data)) stop('response_invalid', 'TinyURL returned an unexpected bulk report response.');
    const from = Math.min(offset, data.length);
    const page = data.slice(from, from + limit);
    const items = page.map(sanitizeBulkReportItem);
    const hasMore = from + items.length < data.length;
    return {
      status: 'ok',
      action: 'bulk_report',
      bulkRequestId: id,
      offset: from,
      limit,
      total: data.length,
      returned: items.length,
      hasMore,
      nextOffset: hasMore ? from + items.length : null,
      items,
    };
  }

  return {
    create, read, update, changeDestination, remove, delete: remove, status,
    archive, setExpiration, analyticsReport, rawLogs,
    analyticsStatus: args => setAnalyticsFlag('status', args),
    analyticsSharing: args => setAnalyticsFlag('sharing', args),
    bulkCreate, bulkStatus, bulkReport,
  };
}

const DOMAIN_PROPERTY = { type: 'string', enum: [DOMAIN], description: `Fixed ${DOMAIN} domain.` };
const ALIAS_PROPERTY = { type: 'string', maxLength: 30, description: 'Exact alias: 1-30 letters, digits, underscore or hyphen.' };
const EXPIRES_PROPERTY = {
  type: ['string', 'null'],
  description: 'ISO 8601 date-time or duration accepted by TinyURL, or null for never.',
};
const METADATA_PROPERTY = {
  type: 'array',
  maxItems: 20,
  items: {
    oneOf: [
      { type: 'string', maxLength: 1000 },
      { type: 'number' },
      { type: 'boolean' },
    ],
  },
  description: 'Optional caller metadata returned in the bulk report (at most 20 primitive values).',
};
const BULK_ITEM_PROPERTIES = {
  operation: { type: 'string', enum: BULK_OPERATIONS },
  domain: DOMAIN_PROPERTY,
  alias: ALIAS_PROPERTY,
  url: { type: 'string', maxLength: MAX_URL, description: 'Exact absolute http(s) URL.' },
  tags: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 45 } },
  expires_at: EXPIRES_PROPERTY,
  description: { type: ['string', 'null'], minLength: 3, maxLength: 1000 },
  new_alias: ALIAS_PROPERTY,
  new_stats: { type: 'boolean' },
  new_tags: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 45 } },
  new_expires_at: EXPIRES_PROPERTY,
  new_description: { type: ['string', 'null'], minLength: 3, maxLength: 1000 },
  metadata: METADATA_PROPERTY,
};
const BULK_ITEM_FIELDS = {
  create: ['operation', 'url', 'domain', 'alias', 'tags', 'expires_at', 'description', 'metadata'],
  update: ['operation', 'domain', 'alias', 'new_alias', 'new_stats', 'new_tags', 'new_expires_at', 'new_description', 'metadata'],
  change: ['operation', 'domain', 'alias', 'url', 'metadata'],
  delete: ['operation', 'domain', 'alias', 'metadata'],
  archive: ['operation', 'domain', 'alias', 'metadata'],
  unarchive: ['operation', 'domain', 'alias', 'metadata'],
};
const bulkItem = (operation, required) => ({
  type: 'object',
  additionalProperties: false,
  required: ['operation', ...required],
  properties: Object.fromEntries(BULK_ITEM_FIELDS[operation].map(key => [
    key,
    key === 'operation' ? { type: 'string', enum: [operation] } : BULK_ITEM_PROPERTIES[key],
  ])),
});

export const toolDefinitions = [
  {
    name: 'tinyurl_create',
    description: 'Create one exact TinyURL short link through POST /create. Requires url; domain is fixed to tinyurl.com; alias and expires_at are optional. Reuses durable operation results and never retries an ambiguous write blindly. Token permission: Create TinyURL.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', maxLength: MAX_URL, description: 'Exact absolute http(s) destination URL, preserved byte-for-byte.' },
        domain: DOMAIN_PROPERTY,
        alias: ALIAS_PROPERTY,
        expires_at: EXPIRES_PROPERTY,
      },
    },
  },
  {
    name: 'tinyurl_read',
    description: 'Read one exact TinyURL alias through GET /alias/{domain}/{alias}. Requires alias; domain is fixed to tinyurl.com. Token permission: Read TinyURL.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['alias'],
      properties: { alias: ALIAS_PROPERTY, domain: DOMAIN_PROPERTY },
    },
  },
  {
    name: 'tinyurl_update',
    description: 'Update metadata or rename one exact TinyURL alias through PATCH /update. Requires alias and at least one new_* field. Never changes the destination; use tinyurl_change_destination. Token permission: Update TinyURL.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['alias'],
      properties: {
        alias: ALIAS_PROPERTY,
        domain: DOMAIN_PROPERTY,
        new_alias: ALIAS_PROPERTY,
        new_stats: { type: 'boolean', description: 'Enable or disable click analytics collection.' },
        new_tags: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 45 } },
        new_expires_at: EXPIRES_PROPERTY,
        new_description: { type: ['string', 'null'], minLength: 3, maxLength: 1000 },
      },
    },
  },
  {
    name: 'tinyurl_change_destination',
    description: 'Change the destination of one exact TinyURL alias through PATCH /change. Requires alias and the exact new absolute http(s) url. Token permission: Update TinyURL.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['alias', 'url'],
      properties: {
        alias: ALIAS_PROPERTY,
        domain: DOMAIN_PROPERTY,
        url: { type: 'string', maxLength: MAX_URL, description: 'Exact new absolute http(s) destination URL, preserved byte-for-byte.' },
      },
    },
  },
  {
    name: 'tinyurl_delete',
    description: 'Delete one exact TinyURL alias through DELETE /alias/{domain}/{alias}. Requires alias; domain is fixed to tinyurl.com. Token permission: Delete TinyURL.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['alias'],
      properties: { alias: ALIAS_PROPERTY, domain: DOMAIN_PROPERTY },
    },
  },
  {
    name: 'tinyurl_archive',
    description: 'Toggle, archive or unarchive one exact TinyURL through PATCH /archive. The vendor body is only domain+alias, so the endpoint toggles; this tool reads the current state first and toggles only when archive/unarchive requires a change. action=toggle always sends one toggle. Verifies the resulting archived boolean. Token permission: Archive TinyURL.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['alias', 'action'],
      properties: {
        alias: ALIAS_PROPERTY,
        domain: DOMAIN_PROPERTY,
        action: { type: 'string', enum: ['toggle', 'archive', 'unarchive'], description: 'toggle flips once; archive/unarchive are idempotent and skip the write when already in that state.' },
      },
    },
  },
  {
    name: 'tinyurl_set_expiration',
    description: 'Set or clear one exact TinyURL expiration through PATCH /update using new_expires_at, then verify the returned or re-read expiry. Requires alias and new_expires_at (string or null). Token permission: Update TinyURL.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['alias', 'new_expires_at'],
      properties: { alias: ALIAS_PROPERTY, domain: DOMAIN_PROPERTY, new_expires_at: EXPIRES_PROPERTY },
    },
  },
  {
    name: 'tinyurl_analytics_report',
    description: 'Read one fixed TinyURL analytics report over GET /analytics/*. report selects timeline, general, weekday, hour, top_sources, top_languages or location. from is required; to, interval, alias, domain, tag and location region are validated and bounded. Token permission: Analytics.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['report', 'from'],
      properties: {
        report: { type: 'string', enum: ANALYTICS_REPORTS, description: 'Fixed report endpoint; no arbitrary path is accepted.' },
        from: { type: 'string', maxLength: 100, description: 'Report start, ISO 8601 date or date-time (for example 2021-08-10T10:00:00-0800).' },
        to: { type: 'string', maxLength: 100, description: 'Optional report end; omit for now.' },
        interval: { type: 'string', enum: INTERVALS, description: 'Timeline bucket size only.' },
        alias: ALIAS_PROPERTY,
        domain: DOMAIN_PROPERTY,
        tag: { type: 'string', maxLength: 100, description: 'Only links with this tag.' },
        region: { type: 'string', maxLength: 5, description: 'Location report only: world (default) or a two-letter ISO 3166-1 country code.' },
      },
    },
  },
  {
    name: 'tinyurl_analytics_raw_logs',
    description: 'Read bounded raw analytics JSON over GET /analytics/raw/json. from is required; to, alias, domain and tag are passed to the vendor. offset and limit bound the returned page and the report discloses total, returned, hasMore and nextOffset. Token permission: Analytics.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['from'],
      properties: {
        from: { type: 'string', maxLength: 100, description: 'Report start, ISO 8601 date or date-time.' },
        to: { type: 'string', maxLength: 100, description: 'Optional report end; omit for now.' },
        alias: ALIAS_PROPERTY,
        domain: DOMAIN_PROPERTY,
        tag: { type: 'string', maxLength: 100 },
        offset: { type: 'integer', minimum: 0, maximum: MAX_RAW_LOGS_FETCH, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_RAW_LOG_PAGE, default: 100 },
      },
    },
  },
  {
    name: 'tinyurl_analytics_status',
    description: 'Enable or disable analytics collection for one exact TinyURL through PATCH /analytics/status. Requires alias and enabled. Uses the durable alias mutation barrier and invalidates create receipts. Token permission: Update TinyURL or Analytics settings.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['alias', 'enabled'],
      properties: { alias: ALIAS_PROPERTY, domain: DOMAIN_PROPERTY, enabled: { type: 'boolean' } },
    },
  },
  {
    name: 'tinyurl_analytics_sharing',
    description: 'Enable or disable public analytics sharing for one exact TinyURL through PATCH /analytics/sharing. Requires alias and public. Uses the durable alias mutation barrier and invalidates create receipts. Token permission: Update TinyURL or Analytics settings.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['alias', 'public'],
      properties: { alias: ALIAS_PROPERTY, domain: DOMAIN_PROPERTY, public: { type: 'boolean' } },
    },
  },
  {
    name: 'tinyurl_bulk_create',
    description: 'Submit one bounded batch through POST /bulk (1-100 typed create/update/change/delete/archive/unarchive items). The request is serialized, checkpointed to a durable barrier before sending, and keyed by the canonical payload. A crash or unknown outcome blocks all further bulk submissions until an operator reconciles the batch; an exact repeat of a verified submission returns the stored bulkRequestId. Token permission: Bulk Requests.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        domain: DOMAIN_PROPERTY,
        items: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_BULK_ITEMS,
          description: 'Typed bulk operations; fields match the vendor BulkRequestItem variants.',
          items: {
            oneOf: [
              bulkItem('create', ['url']),
              bulkItem('update', ['alias']),
              bulkItem('change', ['alias', 'url']),
              bulkItem('delete', ['alias']),
              bulkItem('archive', ['alias']),
              bulkItem('unarchive', ['alias']),
            ],
          },
        },
      },
    },
  },
  {
    name: 'tinyurl_bulk_status',
    description: 'Read one bulk request status through GET /bulk/{bulkRequestId}/status. Requires a positive integer bulkRequestId. Token permission: Bulk Requests.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['bulkRequestId'],
      properties: { bulkRequestId: { type: 'integer', minimum: 1 } },
    },
  },
  {
    name: 'tinyurl_bulk_report',
    description: 'Read a bounded page of one bulk request report through GET /bulk/{bulkRequestId}/report. Requires a positive integer bulkRequestId; offset and limit bound the returned items and the response discloses total, returned, hasMore and nextOffset. Token permission: Bulk Requests.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['bulkRequestId'],
      properties: {
        bulkRequestId: { type: 'integer', minimum: 1 },
        offset: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_BULK_REPORT_PAGE, default: 100 },
      },
    },
  },
  {
    name: 'tinyurl_status',
    description: 'Read-only check for TinyURL connector configuration, token and private state directory. Does not create a link or write state.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
];
