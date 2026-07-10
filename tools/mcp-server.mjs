#!/usr/bin/env node
// mcp-server.mjs — samemind MCP stdio server. JSON-RPC 2.0, newline-delimited, no SDK dependency.
//   node tools/mcp-server.mjs            (OKF_ROOT or cwd = bundle root)
//   npx samemind serve                   (routed here by bin/samemind.mjs)
//
// Methods: initialize / notifications/initialized / tools/list / tools/call / ping.
// stdout carries ONLY protocol frames (one JSON object per line) — every diagnostic goes to stderr.
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  TOOLS, callTool, SERVER_NAME, SERVER_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS, DEFAULT_PROTOCOL_VERSION,
} from './lib/mcp.mjs';

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || !msg.method) {
    console.error('samemind serve: ignoring non-JSON-RPC message', msg);
    return;
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined;

  try {
    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
      reply(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    } else if (method === 'notifications/initialized' || method === 'initialized') {
      // notification — no reply per protocol
    } else if (method === 'notifications/cancelled') {
      // no-op: single-step tools, nothing to cancel
    } else if (method === 'ping') {
      if (!isNotification) reply(id, {});
    } else if (method === 'tools/list') {
      reply(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      const result = await callTool(name, args || {});
      if (!isNotification) reply(id, result);
    } else if (!isNotification) {
      replyError(id, -32601, `Method not found: ${method}`);
    } else {
      console.error(`samemind serve: unknown notification ${method}`);
    }
  } catch (e) {
    if (!isNotification) replyError(id, -32603, e.message);
    else console.error(`samemind serve: error in notification ${method}:`, e.message);
  }
}

function main() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (e) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${e.message}` } });
      return;
    }
    handleMessage(msg).catch(e => console.error('samemind serve: unhandled error', e));
  });
  rl.on('close', () => process.exit(0));
  process.stdin.on('error', (e) => console.error('samemind serve: stdin error', e.message));

  console.error(`samemind serve: MCP stdio server ready (root ${process.env.OKF_ROOT || process.cwd()}, v${SERVER_VERSION})`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
