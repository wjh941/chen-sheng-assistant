// ============================================================================
// 访问口令鉴权（可选，适配局域网多人部署）+ 登录失败限速
//
// 通过 createAuth({ accessToken, rateWindowMs, rateMaxFails, rateLockMs }) 显式
// 传入依赖并持有私有状态（会话签名密钥、失败计数表），不用全局单例：
//   1. 会话：Cookie 存的是"HMAC(进程随机密钥, ACCESS_TOKEN)"而非口令本身；
//      登出时轮换密钥（rotateSecret），所有已发会话立即失效，
//      服务重启也会使全部会话失效；
//   2. 限速：滑动窗口内登录失败达上限即锁定一段时间，锁定期间不比对口令、
//      一律 429（不给枚举口令的机会）。只存进程内存：重启即清零，
//      对单进程本地部署足够，也避免引入存储依赖。
// ============================================================================
'use strict';

const crypto = require('crypto');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function createAuth({ accessToken, rateWindowMs, rateMaxFails, rateLockMs }) {
  // 进程随机签名密钥：登出/重启即失效所有已发会话
  let sessionSecret = crypto.randomUUID();

  function sessionSig() {
    return crypto.createHmac('sha256', sessionSecret).update(accessToken).digest('base64url');
  }

  function hasToken(req) {
    const m = /(?:^|;\s*)ops_token=([^;]+)/.exec(req.headers.cookie || '');
    if (!m) return false;
    // 畸形 Cookie（如 ops_token=%zz）会令 decodeURIComponent 抛 URIError，
    // 必须按“未登录”处理而不是让它炸成 500
    let token;
    try { token = decodeURIComponent(m[1]); } catch { return false; }
    return safeEqual(token, sessionSig());
  }

  function tokenOk(req) {
    return !accessToken || hasToken(req);
  }

  // 登录口令比对：恒定时间比较，锁定判定之外的唯一入口
  function tokenMatches(candidate) {
    return safeEqual(String(candidate), accessToken);
  }

  // 登出时轮换签名密钥：所有已发会话立即失效
  function rotateSecret() {
    sessionSecret = crypto.randomUUID();
  }

  // ---- 登录失败限速（进程内存，按远端 IP） ----
  // 窗口/阈值/锁定时长由启动方经环境变量注入（测试用它缩短等待，默认生产值不变）。
  const loginFails = new Map(); // ip -> { fails: number[], lockUntil: number }

  function loginLockedMs(req) {
    const rec = loginFails.get(req.socket.remoteAddress || '');
    return rec && Date.now() < rec.lockUntil ? rec.lockUntil - Date.now() : 0;
  }

  function recordLoginFail(req) {
    const ip = req.socket.remoteAddress || '';
    const now = Date.now();
    const rec = loginFails.get(ip) || { fails: [], lockUntil: 0 };
    rec.fails = rec.fails.filter(t => now - t < rateWindowMs); // 滑动窗口：过期失败不再计数，也防数组膨胀
    rec.fails.push(now);
    if (rec.fails.length >= rateMaxFails) rec.lockUntil = now + rateLockMs;
    if (loginFails.size > 10000) loginFails.clear(); // 兜底：极端扫描下防止 Map 无限膨胀（代价仅是限速计数归零）
    loginFails.set(ip, rec);
  }

  function clearLoginFails(req) {
    loginFails.delete(req.socket.remoteAddress || ''); // 成功登录清零，避免误伤同 IP 的正常使用
  }

  return { hasToken, tokenOk, tokenMatches, sessionSig, rotateSecret, loginLockedMs, recordLoginFail, clearLoginFails };
}

// 登录页（无脚本依赖的内联表单，登录成功回跳首页）
function loginPage(msg) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录</title></head>' +
    '<body style="font-family:system-ui;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f5f7f9">' +
    '<form onsubmit="fetch(\'/login\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({token:document.getElementById(\'t\').value})}).then(r=>{if(r.ok)location.href=\'/\';else document.getElementById(\'m\').textContent=\'口令错误，请重试\'})" ' +
    'style="background:#fff;padding:40px;border-radius:14px;box-shadow:0 10px 40px #0002;width:320px">' +
    '<h2 style="margin:0 0 8px">经营助手</h2><p style="color:#71817d;margin:0 0 16px">请输入访问口令</p>' +
    '<input id="t" type="password" autofocus style="width:100%;box-sizing:border-box;padding:11px;border:1px solid #d5e0da;border-radius:7px;margin-bottom:14px">' +
    '<button style="width:100%;padding:12px;border:0;border-radius:8px;background:#d0f878;font-weight:700;cursor:pointer">进入</button>' +
    '<p id="m" style="color:#c05621;margin:12px 0 0;min-height:1em">' + (msg || '') + '</p></form></body></html>';
}

module.exports = { createAuth, loginPage, safeEqual };
