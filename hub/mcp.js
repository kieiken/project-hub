#!/usr/bin/env node
'use strict';
const { lt } = require('./lib/locale');
// Project Hub の MCP（ChatGPT などの AI が Hub の作業を読み、結果を書き戻すための道具）
// 使い方: node mcp.js（標準入出力で JSON-RPC 2.0。1行に1つ）。tunnel-client などから起動する
// 中身は動いている Hub（http://127.0.0.1:<HUB_PORT||4545>）に聞くだけ。書くのは Hub だけ。記録は標準エラーへ
const http = require('http');
const PORT = Number(process.env.HUB_PORT || 4545);
const VERSION = (() => { try { return require('./package.json').version; } catch (e) { return '0'; } })();
const PROTOCOL = '2025-06-18';
const log = (...a) => process.stderr.write(`[project-hub mcp] ${a.join(' ')}\n`);

function hub(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const rq = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { 'X-Hub': '1', Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { let j = {}; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { j = { error: lt('Hub の返事を読めません') }; } resolve({ status: res.statusCode, body: j }); });
    });
    rq.setTimeout(150000, () => rq.destroy(Error(lt('Hub の返事が来ません'))));
    rq.on('error', e => reject(Object.assign(Error(lt`Project Hub（127.0.0.1:${PORT}）につながりません。Hub を起動してください（${e.code || e.message}）`), { down: true })));
    if (data) rq.write(data); rq.end();
  });
}

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const error = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

async function handle(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    if (msg && typeof msg === 'object' && !msg.method && ('result' in msg || 'error' in msg)) return undefined; // 相手からの返事（使わない）
    return error(msg && msg.id !== undefined ? msg.id : null, -32600, 'Invalid Request');
  }
  const { id, method, params = {} } = msg;
  if (!('id' in msg)) return undefined; // notifications/initialized など：返事しない
  try {
    if (method === 'initialize') return reply(id, { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'project-hub', title: 'Project Hub', version: VERSION },
      instructions: lt('Project Hub（作業の管理ソフト）の道具です。まず hub_get_task で作業を読み、終わったら hub_report で結果を書き戻し、人の判断が要る時は hub_ask_owner で質問してください。') });
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') {
      let r;
      // Hub が止まっている時は、読む・報告する道具だけを見せる（呼ぶと「Hub を起動して」と返る）
      try { r = await hub('GET', '/api/mcp/tools'); } catch (e) { log(e.message); return reply(id, { tools: require('./lib/chatgpt').TOOLS.filter(t => !t.work).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }); }
      if (r.status !== 200) return error(id, -32603, r.body.error || lt`Hub が断りました（${r.status}）`);
      return reply(id, { tools: r.body.tools });
    }
    if (method === 'tools/call') {
      if (!params || typeof params.name !== 'string') return error(id, -32602, lt('name がありません'));
      if (params.arguments !== undefined && (typeof params.arguments !== 'object' || params.arguments === null || Array.isArray(params.arguments))) return error(id, -32602, lt('arguments はオブジェクトにしてください'));
      let r;
      try { r = await hub('POST', '/api/mcp/call', { name: params.name, arguments: params.arguments || {} }); }
      catch (e) { return reply(id, { content: [{ type: 'text', text: e.message }], isError: true }); }
      if (r.body.unknown) return error(id, -32602, `Unknown tool: ${params.name}`);
      if (r.status !== 200) return reply(id, { content: [{ type: 'text', text: r.body.error || lt`失敗しました（${r.status}）` }], isError: true });
      return reply(id, { content: [{ type: 'text', text: String(r.body.text ?? '') }] });
    }
    return error(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    log('error', e.stack || e);
    return error(id, -32603, String(e.message || e));
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { error(null, -32700, 'Parse error'); continue; }
    handle(msg);
  }
});
log(lt`起動しました（Hub: 127.0.0.1:${PORT}）`);
