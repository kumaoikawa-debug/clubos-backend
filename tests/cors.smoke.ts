/**
 * CORS 冒烟（离线可跑，不需 DB / Key）
 *
 * 为什么要有这个脚本：CORS 是浏览器独有的约束，Node 侧 curl 完全感知不到 ——
 * 缺 Access-Control-Allow-Origin 时服务端一切"正常"，浏览器却直接抛错。
 * 所以必须用一个"像浏览器"的探针把这两个头钉死，避免以后有人重构掉 app.use(cors)。
 *
 * 跑法：npx tsx tests/cors.smoke.ts
 */
import express from 'express';
import { cors } from '../src/middleware';

const app = express();
app.use(cors);
app.post('/api/pay/admin/login', (_req, res) => {
  res.json({ code: 0, data: { token: 'x' } });
});

const server = app.listen(0);

async function main() {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const results: string[] = [];
  let failed = 0;

  const check = (name: string, cond: boolean, detail: string) => {
    results.push(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${detail}`}`);
    if (!cond) failed++;
  };

  // 1) 预检必须 204 + 带 ACAO / ACAM / ACAH
  const pre = await fetch(`${base}/api/pay/admin/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://kumaoikawa-debug.github.io',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  check('预检 OPTIONS 返回 204', pre.status === 204, `got ${pre.status}`);
  check(
    '预检带 Access-Control-Allow-Origin',
    pre.headers.get('access-control-allow-origin') === 'https://kumaoikawa-debug.github.io',
    `got ${pre.headers.get('access-control-allow-origin')}`
  );
  check(
    '预检带 Access-Control-Allow-Headers（含 content-type）',
    /content-type/i.test(pre.headers.get('access-control-allow-headers') || ''),
    `got ${pre.headers.get('access-control-allow-headers')}`
  );
  check(
    '预检带 Access-Control-Allow-Methods（含 POST）',
    /POST/.test(pre.headers.get('access-control-allow-methods') || ''),
    `got ${pre.headers.get('access-control-allow-methods')}`
  );
  check('带 Vary: Origin（防止 CDN 缓存串源）', /origin/i.test(pre.headers.get('vary') || ''), `got ${pre.headers.get('vary')}`);

  // 2) 真实响应也必须带 ACAO，否则浏览器会丢弃响应
  const post = await fetch(`${base}/api/pay/admin/login`, {
    method: 'POST',
    headers: { Origin: 'https://kumaoikawa-debug.github.io', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'x', merchant_id: '1' }),
  });
  check('真实 POST 返回 200', post.status === 200, `got ${post.status}`);
  check(
    '真实 POST 带 Access-Control-Allow-Origin',
    !!post.headers.get('access-control-allow-origin'),
    'header 缺失 → 浏览器会丢弃响应'
  );
  const body = await post.json().catch(() => null);
  check('业务响应体未被中间件破坏', !!body && (body as { code?: number }).code === 0, JSON.stringify(body));

  // 3) 白名单模式：不在名单内不得回 ACAO
  process.env.CORS_ORIGINS = 'https://allowed.example.com';
  // config 在模块加载时求值，这里直接改内存对象验证分支
  const { config } = await import('../src/config');
  (config as { corsOrigins: string }).corsOrigins = 'https://allowed.example.com';
  const bad = await fetch(`${base}/api/pay/admin/login`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example.com', 'Content-Type': 'application/json' },
    body: '{}',
  });
  check('白名单外来源不回 ACAO', !bad.headers.get('access-control-allow-origin'), `got ${bad.headers.get('access-control-allow-origin')}`);
  (config as { corsOrigins: string }).corsOrigins = '*';

  console.log(results.join('\n'));
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} ${results.length - failed}/${results.length}`);
  server.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  server.close();
  process.exit(1);
});
