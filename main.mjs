#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createBridge, toolDefinitions } from './bridge.mjs';

let bridge;
let buffer = '';
let queue = Promise.resolve();
let pending = 0;

function loadConfig() {
  const file = process.env.TINYURL_CONFIG_FILE;
  if (!file || !path.isAbsolute(file)) throw new Error('absolute config path required');
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 || (info.mode & 0o077) !== 0) throw new Error('private config required');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  return config;
}

function blocked(code, nextAction) {
  return { status: 'blocked', code, nextAction };
}

async function call(name, args) {
  if (name === 'tinyurl_status') {
    try {
      bridge ??= createBridge(loadConfig());
      return bridge.status();
    } catch {
      return { status: 'ok', configured: false, domain: 'tinyurl.com', tokenPresent: false, stateDirectoryPresent: false, timeoutMs: 4000 };
    }
  }
  const operations = {
    tinyurl_create: 'create',
    tinyurl_read: 'read',
    tinyurl_update: 'update',
    tinyurl_change_destination: 'changeDestination',
    tinyurl_delete: 'remove',
    tinyurl_archive: 'archive',
    tinyurl_set_expiration: 'setExpiration',
    tinyurl_analytics_report: 'analyticsReport',
    tinyurl_analytics_raw_logs: 'rawLogs',
    tinyurl_analytics_status: 'analyticsStatus',
    tinyurl_analytics_sharing: 'analyticsSharing',
    tinyurl_bulk_create: 'bulkCreate',
    tinyurl_bulk_status: 'bulkStatus',
    tinyurl_bulk_report: 'bulkReport',
  };
  const operation = operations[name];
  if (!operation) return blocked('unknown_tool', 'Use a listed tinyurl_* tool; use tools/list for the supported fixed endpoints.');
  try {
    bridge ??= createBridge(loadConfig());
    return await bridge[operation](args);
  } catch (error) {
    if (error?.code) return blocked(error.code, error.nextAction ?? 'Operator must review connector configuration.');
    return blocked('internal_error', 'Connector failed without an explicit outcome. Do not retry an ambiguous write.');
  }
}

async function dispatch(line) {
  let message;
  try {
    message = JSON.parse(line);
    if (message.id === undefined) return;
    let result;
    if (message.method === 'initialize') {
      result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tinyurl', version: '1.0.0' } };
    } else if (message.method === 'tools/list') {
      result = { tools: toolDefinitions };
    } else if (message.method === 'ping') {
      result = {};
    } else if (message.method === 'tools/call') {
      const output = await call(message.params?.name, message.params?.arguments ?? {});
      result = { ...(output.status === 'blocked' ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(output) }] };
    } else {
      throw new Error('unsupported method');
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  } catch {
    if (message?.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Invalid request' } }) + '\n');
    }
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 65536) {
    process.stderr.write('TinyURL MCP request exceeds 64 KiB.\n');
    process.exit(1);
  }
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    pending++;
    if (pending > 32) {
      process.stderr.write('TinyURL MCP queue exceeds 32 requests.\n');
      process.exit(1);
    }
    queue = queue.then(() => dispatch(line)).finally(() => { pending--; });
  }
});
