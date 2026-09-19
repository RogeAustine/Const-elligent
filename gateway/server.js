#!/usr/bin/env node
/**
 * 见仁建智 · 本地大模型网关（零依赖）
 * ---------------------------------------------------------------------------
 * 用途：把浏览器的模型请求转发到真实大模型服务，解决两件线上部署必须解决的事：
 *   1) API Key 不落到浏览器（浏览器直连必然把密钥暴露给前端）；
 *   2) 绕开第三方服务的 CORS 限制。
 *
 * 同时提供审计日志：每一次模型调用都落一行 JSON，供事后复核"智能体当时
 * 到底看到了什么"，这是工程场景可追溯性的一部分。
 *
 * 启动：
 *   node gateway/server.js --port 8787 --upstream https://api.deepseek.com/v1 --model deepseek-chat
 *   或设环境变量：
 *   JR_UPSTREAM / JR_MODEL / JR_API_KEY / JR_PORT
 *
 * 然后在页面「设置」里选“本地网关 / vLLM”，Base URL 填 http://127.0.0.1:8787/v1
 * （不要填 API Key，密钥只留在服务端进程里）。
 *
 * 暴露的接口：
 *   POST /v1/chat/completions   兼容 OpenAI，直接转发
 *   GET  /v1/models             返回配置的模型名
 *   GET  /healthz               健康检查
 *   GET  /audit?limit=50        最近若干条调用审计记录
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/* ------------------------------------------------------------ 参数解析 --- */
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.indexOf('--') === 0) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && next.indexOf('--') !== 0) { out[key] = next; i++; }
      else out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const CONFIG = {
  port: parseInt(args.port || process.env.JR_PORT || '8787', 10),
  upstream: (args.upstream || process.env.JR_UPSTREAM || 'https://api.deepseek.com/v1').replace(/\/$/, ''),
  model: args.model || process.env.JR_MODEL || 'deepseek-chat',
  apiKey: args.key || process.env.JR_API_KEY || '',
  auditFile: args.audit || process.env.JR_AUDIT || path.join(__dirname, 'audit.log')
};

if (!CONFIG.apiKey) {
  console.warn('[gateway] 警告：未提供上游 API Key（--key 或 JR_API_KEY）。');
  console.warn('[gateway] 若上游是本地 vLLM / Ollama 等无需鉴权的服务，可忽略此警告。');
}

/* ------------------------------------------------------------ 审计日志 --- */
function audit(record) {
  const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, record));
  try {
    fs.appendFileSync(CONFIG.auditFile, line + '\n', 'utf8');
  } catch (e) {
    console.error('[gateway] 审计写入失败：', e.message);
  }
  return line;
}

const startedAt = Date.now();

/* --------------------------------------------------------------- 工具 --- */
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > (limitBytes || 2 * 1024 * 1024)) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, headers) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    // 本地开发用：允许页面从 file:// 或任意端口访问
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, anthropic-version',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store'
  }, headers || {}));
  res.end(payload);
}

/**
 * 转发到上游。刻意用 Node 内置的 http/https 而不是 fetch：
 * 这份网关要能在只装了 Node 的评审电脑上直接跑起来，不依赖任何包。
 */
function forward(payload) {
  const target = new URL(CONFIG.upstream + '/chat/completions');
  const isHttps = target.protocol === 'https:';
  const transport = isHttps ? require('https') : require('http');
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': data.length,
    'Accept': 'application/json'
  };
  if (CONFIG.apiKey) headers['Authorization'] = 'Bearer ' + CONFIG.apiKey;

  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method: 'POST',
      headers,
      timeout: 120000
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
        ms: Date.now() - t0
      }));
    });
    req.on('timeout', () => { req.destroy(new Error('上游超时')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/* --------------------------------------------------------------- 主逻辑 --- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (url.pathname === '/healthz') {
    return send(res, 200, {
      ok: true,
      upstream: CONFIG.upstream,
      model: CONFIG.model,
      hasKey: !!CONFIG.apiKey,
      uptimeMs: Date.now() - startedAt
    });
  }

  if (url.pathname === '/v1/models') {
    return send(res, 200, {
      object: 'list',
      data: [{ id: CONFIG.model, object: 'model', created: Math.floor(startedAt / 1000), owned_by: 'jianrenjianzhi-gateway' }]
    });
  }

  if (url.pathname === '/audit') {
    const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 500));
    let lines = [];
    try {
      lines = fs.readFileSync(CONFIG.auditFile, 'utf8').trim().split('\n').filter(Boolean);
    } catch (e) { lines = []; }
    return send(res, 200, { count: lines.length, records: lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch (e) { return { raw: l }; } }) });
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (e) {
      return send(res, 400, { error: { message: '请求体不是合法 JSON：' + e.message } });
    }
    // 网关统一模型名：页面不需要知道上游到底叫什么
    const requestedModel = payload.model;
    payload.model = CONFIG.model;

    try {
      const upstream = await forward(payload);
      audit({
        model: CONFIG.model, requestedModel,
        status: upstream.status, ms: upstream.ms,
        messages: (payload.messages || []).length,
        promptChars: (payload.messages || []).reduce((n, m) => n + String(m.content || '').length, 0),
        ok: upstream.status >= 200 && upstream.status < 300
      });
      return send(res, upstream.status, upstream.body);
    } catch (e) {
      audit({ model: CONFIG.model, requestedModel, status: 0, error: e.message, ok: false });
      return send(res, 502, { error: { message: '转发失败：' + e.message, upstream: CONFIG.upstream } });
    }
  }

  send(res, 404, { error: { message: '未实现的路径：' + url.pathname } });
});

server.listen(CONFIG.port, () => {
  console.log('见仁建智 · 本地大模型网关已启动');
  console.log('  监听      : http://127.0.0.1:' + CONFIG.port + '/v1');
  console.log('  上游      : ' + CONFIG.upstream);
  console.log('  模型      : ' + CONFIG.model);
  console.log('  API Key   : ' + (CONFIG.apiKey ? '已配置（仅存于本进程）' : '未配置'));
  console.log('  审计日志  : ' + CONFIG.auditFile);
  console.log('');
  console.log('在页面「设置」中选择「本地网关 / vLLM」，Base URL 填 http://127.0.0.1:' + CONFIG.port + '/v1');
});
