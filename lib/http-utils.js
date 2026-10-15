// ============================================================================
// 请求层通用工具：响应发送、安全头、JSON 请求体解析、操作员标识、同源校验
//
// 全部为无状态纯函数（零依赖），被 lib/router.js 与 server.js 共用。
// send() 统一附加 SECURITY_HEADERS；body() 在解析失败/超限时直接回错，
// 业务回调 done(x) 抛出的异常也在此兜底转 500（进程不退出）。
// ============================================================================
'use strict';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function send(res, status, body, type, extraHeaders) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, Object.assign({}, SECURITY_HEADERS, { 'Content-Type': type || 'application/json; charset=utf-8' }, extraHeaders || {}));
  if (Buffer.isBuffer(body)) return res.end(body);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// POST 只接受 JSON；带请求体的 POST 必须声明 application/json（顺带挡掉表单型 CSRF）
function body(req, done) {
  let b = '';
  req.on('data', c => {
    b += c;
    if (b.length > 8 * 1024 * 1024) { send(req.res, 413, { error: '请求内容超过8 MB限制' }); req.destroy(); }
  });
  req.on('end', () => {
    let x;
    try {
      if (b && !String(req.headers['content-type'] || '').includes('application/json')) {
        return send(req.res, 415, { error: '请使用 application/json 内容类型' });
      }
      x = JSON.parse(b || '{}');
    } catch {
      return send(req.res, 400, { error: 'JSON无效' });
    }
    try {
      done(x);
    } catch (e) {
      console.error('[error]', req.method, req.url, e);
      send(req.res, 500, { error: '服务器内部错误：' + e.message });
    }
  });
}

// 操作员标识：前端通过 X-Operator 头携带（HTTP 头仅支持 ASCII，故传输前经 URI 编码，≤20 字符）
function opOf(req) {
  let v = String(req.headers['x-operator'] || '').trim();
  if (!v) return '';
  try { v = decodeURIComponent(v); } catch { /* 保留原值 */ }
  return v.slice(0, 20);
}

// 简单同源校验：浏览器发起的跨站请求会带 Origin 头，与 Host 不一致即拒绝（脚本工具无 Origin 不受影响）
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

module.exports = { SECURITY_HEADERS, send, body, opOf, sameOrigin };
