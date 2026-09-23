// ============================================================================
// 本地经营助手 · 本地服务（v0.7.0 多商家适配版）
//
// 设计原则：
//   1. 零第三方依赖，Node.js >= 18 直接运行；
//   2. 数据只落本机 JSON 文件，原子写入，不连任何云端；
//   3. 对外部账本（默认速达，可配置为任何 ERP/手工账本）只做"人工登记单号"，
//      不直接连接、不修改账本数据库；
//   4. 商家品牌 / 外部账本名称等全部在 config/merchant.json 配置，
//      换一家商家 = 换一份配置 + 换一份数据文件，代码不用改。
// ============================================================================
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readXlsx, writeXlsx } = require('./lib/xlsx');

const root = __dirname;
const pkg = require('./package.json');
const APP_VERSION = pkg.version;

const DATA_FILE = process.env.DATA_FILE || path.join(root, 'data', 'demo.json');
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(root, 'config', 'merchant.json');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3088;
// 可选访问口令：设置后所有页面与接口（除 /login、/api/health）都需要登录
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';

// ---------------------------------------------------------------------------
// 商家配置：默认值 + config/merchant.json 覆盖（允许只写部分字段）
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  app: {
    name: '本地经营助手',           // 浏览器标题 / 健康检查
    short: '本地助手',              // 侧边栏品牌短名
    tagline: '本地经营智能助手',     // 品牌下一行小字
    eyebrow: 'LOCAL · OPS',        // 顶部装饰小字
    header: '早上好，今天也高效出货。',
    company: '',                   // 公司全称行
    footer: '● 局域网本地运行',
    footerSmall: '数据不会上传云端',
  },
  erp: {
    name: '外部账本',               // 完整账本名称（展示用）
    short: '账本',                  // 短名：界面里"速达单号"等文案会动态替换
  },
};

function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

let configCache = null, configMtime = 0;
function readConfig() {
  try {
    const stat = fs.statSync(CONFIG_FILE);
    if (configCache && stat.mtimeMs === configMtime) return configCache;
    const merged = deepMerge(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    configCache = merged; configMtime = stat.mtimeMs;
    return merged;
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[config] 配置文件读取失败，使用默认配置：' + e.message);
    return deepMerge(DEFAULT_CONFIG, {});
  }
}

// ---------------------------------------------------------------------------
// 数据层：临时文件 + 原子替换；基于 mtime 的内存缓存；文件缺失自动播种空库
// ---------------------------------------------------------------------------
function emptyData() {
  return {
    customers: [], products: [], orders: [], inventory: [], vehicles: [], audit: [],
    appMeta: { version: APP_VERSION, createdAt: new Date().toISOString() },
  };
}

let cache = null, cacheMtime = 0;
function read() {
  let stat;
  try {
    stat = fs.statSync(DATA_FILE);
  } catch (e) {
    if (e.code === 'ENOENT') { save(emptyData()); return structuredClone(cache); }
    throw e;
  }
  if (cache && stat.mtimeMs === cacheMtime) return structuredClone(cache);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    throw new Error('数据文件不是有效的 JSON（' + DATA_FILE + '），请先备份并修复该文件');
  }
  for (const k of ['customers', 'products', 'orders', 'inventory', 'vehicles', 'audit']) {
    if (!Array.isArray(parsed[k])) parsed[k] = [];
  }
  cache = parsed; cacheMtime = stat.mtimeMs;
  return structuredClone(parsed);
}

// 每日自动备份：每天第一次写入前，把当前数据文件快照到 backups/，保留最近 14 份
let lastBackupDay = '';
function backupDaily() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastBackupDay === today || !fs.existsSync(DATA_FILE)) return;
  try {
    const dir = path.join(path.dirname(DATA_FILE), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(DATA_FILE).replace(/\.json$/i, '');
    fs.copyFileSync(DATA_FILE, path.join(dir, base + '-' + today.replaceAll('-', '') + '.json'));
    const files = fs.readdirSync(dir).filter(f => f.startsWith(base + '-') && f.endsWith('.json')).sort().reverse();
    for (const f of files.slice(14)) fs.unlinkSync(path.join(dir, f));
    lastBackupDay = today;
  } catch (e) {
    console.warn('[backup] 每日备份失败（不影响主流程）：' + e.message);
  }
}

function save(d) {
  backupDaily();
  d.appMeta = Object.assign({}, d.appMeta, { version: APP_VERSION });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n');
  fs.renameSync(tmp, DATA_FILE);
  cache = structuredClone(d);
  cacheMtime = fs.statSync(DATA_FILE).mtimeMs;
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------
let seq = 0;
function newId(prefix) {
  // 时间戳 + 序号 + 随机段，避免同毫秒并发创建撞号
  return prefix + '-' + Date.now().toString(36) + (seq++).toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

function audit(d, action, detail, operator) {
  d.audit = d.audit || [];
  const item = { id: Date.now() + seq, time: new Date().toISOString(), action, detail };
  if (operator) item.operator = operator; // 操作员标识（前端填写，仅作记录）
  d.audit.unshift(item);
  d.audit = d.audit.slice(0, 500); // 防止审计日志无限膨胀
}

// 操作员标识：前端通过 X-Operator 头携带（HTTP 头仅支持 ASCII，故传输前经 URI 编码，≤20 字符）
function opOf(req) {
  let v = String(req.headers['x-operator'] || '').trim();
  if (!v) return '';
  try { v = decodeURIComponent(v); } catch { /* 保留原值 */ }
  return v.slice(0, 20);
}

function send(res, status, body, type, extraHeaders) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8' }, extraHeaders || {}));
  if (Buffer.isBuffer(body)) return res.end(body);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// ---------- 访问口令（可选，适配局域网多人部署） ----------
// Cookie 存的是"HMAC(进程随机密钥, ACCESS_TOKEN)"而非口令本身；
// 登出时轮换密钥，所有已发会话立即失效，服务重启也会使全部会话失效。
let sessionSecret = crypto.randomUUID();

function sessionSig() {
  return crypto.createHmac('sha256', sessionSecret).update(ACCESS_TOKEN).digest('base64url');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function hasToken(req) {
  const m = /(?:^|;\s*)ops_token=([^;]+)/.exec(req.headers.cookie || '');
  return !!m && safeEqual(decodeURIComponent(m[1]), sessionSig());
}

function tokenOk(req) {
  return !ACCESS_TOKEN || hasToken(req);
}

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

// 简单同源校验：浏览器发起的跨站请求会带 Origin 头，与 Host 不一致即拒绝（脚本工具无 Origin 不受影响）
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

function validItems(items) {
  return Array.isArray(items) && items.length > 0 && items.every(i => {
    const x = typeof i === 'string' ? parseItemLine(i) : i;
    return x && String(x.name || '').trim() && Number(x.qty) > 0;
  });
}

// "商品,数量,单位" 逐行解析：兼容制表符与中英文逗号，缺数量默认 1（导入与手填行为一致）
function parseItemLine(line) {
  const c = String(line).split(/[\t,，]/).map(v => v.trim());
  return { name: c[0], qty: Number(c[1]) > 0 ? Number(c[1]) : 1, unit: c[2] || '件' };
}

function productFor(d, name) {
  return (d.products || []).find(p => p.name === name || (p.aliases || []).includes(name) || p.sku === name);
}

function customerFor(d, name) {
  return (d.customers || []).find(c => c.name === name || (c.aliases || []).includes(name));
}

// 订单派生信息：商品匹配、客户匹配（软提示，不阻断）、异常列表、createdAt 回填
function enrich(d, order) {
  if (!order.createdAt) {
    const m = /^(LOCAL|IMP)-(\d{13})/.exec(String(order.id)); // 旧版毫秒时间戳 ID 可反解
    order.createdAt = (m && new Date(Number(m[2])).toISOString()) || order.confirmedAt || '1970-01-01T00:00:00.000Z';
  }
  order.matching = (order.items || []).map(i => {
    const p = i.sku ? (d.products || []).find(v => v.sku === i.sku) : productFor(d, i.name);
    return { ...i, sku: (p && p.sku) || i.sku || '', matched: !!p || !!i.sku };
  });
  order.exceptions = order.matching.filter(i => !i.matched).map(i => '未匹配商品：' + i.name);
  order.customerMatched = !!customerFor(d, order.customer);
  if (order.exceptions.length && order.status === '待人工确认') order.status = '异常待审核';
  return order;
}

// 拣货计划：同一订单内同 SKU 先到先得，超出可用量记缺口
function pickPlan(d, o) {
  const used = {};
  return o.matching.map(i => {
    const inv = (d.inventory || []).find(v => v.sku === i.sku);
    const qty = Number(i.qty);
    const available = Math.max(0, (inv ? inv.stock : 0) - (used[i.sku] || 0));
    used[i.sku] = (used[i.sku] || 0) + qty;
    return { sku: i.sku, name: i.name, requested: qty, available, shortage: Math.max(0, qty - available), unit: i.unit || (inv && inv.unit) || '件' };
  });
}

// 经营分析：全部由本地订单实时汇总（不再使用写死的 metrics）
function analytics(d) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const costBySku = {};
  for (const inv of d.inventory || []) costBySku[inv.sku] = Number(inv.cost) || 0;
  let todaySales = 0, monthSales = 0, monthCost = 0;
  for (const o of d.orders || []) {
    if (o.status === '已取消') continue;
    const ts = Date.parse(o.createdAt || '') || 0;
    if (!ts) continue;
    if (ts >= todayStart) todaySales += Number(o.amount) || 0;
    if (ts >= monthStart) {
      monthSales += Number(o.amount) || 0;
      for (const i of o.matching || o.items || []) monthCost += (Number(i.qty) || 0) * (costBySku[i.sku] || 0);
    }
  }
  return {
    todaySales,
    monthSales,
    monthCost: Math.round(monthCost * 100) / 100,
    monthProfit: Math.round((monthSales - monthCost) * 100) / 100,
    pending: (d.orders || []).filter(o => !['已登记速达单号', '已取消'].includes(o.status)).length,
    lowStock: (d.inventory || []).filter(x => Number(x.stock) < Number(x.safe)).length,
  };
}

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const pubDir = path.join(root, 'public');

const server = http.createServer((req, res) => {
  try {
    route(req, res);
  } catch (e) {
    console.error('[error]', req.method, req.url, e);
    send(res, 500, { error: '服务器内部错误：' + e.message });
  }
});

function route(req, res) {
  req.res = res;
  const u = new URL(req.url, 'http://localhost');

  // ---- 访问口令门禁（设置 ACCESS_TOKEN 环境变量时启用） --------------------
  if (ACCESS_TOKEN) {
    const open = u.pathname === '/login' || u.pathname === '/logout' || u.pathname === '/api/health';
    if (!open && !hasToken(req)) {
      if (req.method === 'GET' && !u.pathname.startsWith('/api/')) {
        return send(res, 302, '', 'text/plain', { Location: '/login' });
      }
      return send(res, 401, { error: '请先登录' });
    }
  }
  if (req.method === 'GET' && u.pathname === '/login') return send(res, 200, loginPage(), 'text/html; charset=utf-8');
  if (req.method === 'POST' && u.pathname === '/login') {
    return body(req, x => {
      if (!safeEqual(String(x.token || ''), ACCESS_TOKEN)) return send(res, 401, { error: '口令错误' });
      send(res, 200, { ok: true }, 'application/json; charset=utf-8', {
        'Set-Cookie': 'ops_token=' + encodeURIComponent(sessionSig()) + '; Path=/; HttpOnly; SameSite=Strict',
      });
    });
  }
  if (req.method === 'GET' && u.pathname === '/logout') {
    sessionSecret = crypto.randomUUID(); // 轮换签名密钥：所有已发会话立即失效
    return send(res, 302, '', 'text/plain', { Location: '/login', 'Set-Cookie': 'ops_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
  }

  let d;

  // ---- 配置与健康检查 -----------------------------------------------------
  if (req.method === 'GET' && u.pathname === '/api/config') {
    return send(res, 200, {
      config: readConfig(),
      meta: {
        version: APP_VERSION,
        dataFile: path.basename(DATA_FILE),
        configFile: path.basename(CONFIG_FILE),
        host: HOST,
        port: server.address() ? server.address().port : PORT,
      },
    });
  }
  if (req.method === 'GET' && u.pathname === '/api/health') {
    d = read();
    return send(res, 200, {
      ok: true, localOnly: true, version: APP_VERSION,
      merchant: readConfig().app.short,
      orders: d.orders.length, customers: d.customers.length, products: d.products.length,
    });
  }

  // ---- 查询类 -------------------------------------------------------------
  if (req.method === 'GET' && u.pathname === '/api/overview') {
    d = read();
    d.orders.forEach(o => enrich(d, o));
    return send(res, 200, {
      version: APP_VERSION, config: readConfig(),
      customers: d.customers, products: d.products,
      orders: d.orders, inventory: d.inventory, vehicles: d.vehicles,
      audit: d.audit, analytics: analytics(d),
    });
  }
  if (req.method === 'GET' && u.pathname === '/api/catalog') {
    d = read();
    return send(res, 200, { customers: d.customers, products: d.products });
  }
  if (req.method === 'GET' && u.pathname === '/api/audit') {
    d = read();
    return send(res, 200, { items: (d.audit || []).slice(0, 100) });
  }
  if (req.method === 'GET' && u.pathname === '/api/export') {
    // 数据备份：原样下载当前数据文件
    const raw = fs.readFileSync(DATA_FILE);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return send(res, 200, raw, 'application/json; charset=utf-8', {
      'Content-Disposition': 'attachment; filename="backup-' + stamp + '.json"',
    });
  }
  if (req.method === 'GET' && u.pathname === '/api/export/orders.xlsx') {
    // 订单对账导出：?month=YYYY-MM 可选，默认全部订单
    d = read();
    const month = u.searchParams.get('month');
    const rows = [['订单号', '创建时间', '客户', '来源', '状态', '金额', '速达单号', '配送状态', '商品明细', '取消原因']];
    for (const o of d.orders) {
      if (month && String(o.createdAt || '').slice(0, 7) !== month) continue;
      const items = (o.matching || o.items || []).map(i => `${i.name}×${i.qty}${i.unit || ''}`).join('；');
      rows.push([o.id, String(o.createdAt || '').replace('T', ' ').slice(0, 16), o.customer, o.source, o.status, String(o.amount ?? ''), o.speedaNo || '', o.deliveryStatus || '未安排', items, o.cancelReason || '']);
    }
    const xlsx = writeXlsx([{ name: '订单', rows }]);
    const fname = month ? 'orders-' + month + '.xlsx' : 'orders-all.xlsx';
    return send(res, 200, xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', {
      'Content-Disposition': 'attachment; filename="' + fname + '"',
    });
  }

  // ---- 写操作：同源校验 ---------------------------------------------------
  if (req.method === 'POST' && !sameOrigin(req)) {
    return send(res, 403, { error: '拒绝跨站请求' });
  }

  // ---- 创建订单 -----------------------------------------------------------
  if (req.method === 'POST' && u.pathname === '/api/orders') {
    return body(req, x => {
      if (!String(x.customer || '').trim() || !validItems(x.items)) return send(res, 400, { error: '客户和有效商品明细必填，数量必须大于0' });
      if (x.amount !== undefined && (Number.isNaN(Number(x.amount)) || Number(x.amount) < 0)) return send(res, 400, { error: '订单金额必须是非负数字' });
      d = read();
      const order = {
        id: newId('LOCAL'),
        customer: x.customer.trim(),
        source: x.source || '手工录入',
        status: '待人工确认',
        amount: Number(x.amount) || 0,
        items: x.items.map(i => (typeof i === 'string' ? parseItemLine(i) : i)),
        createdAt: new Date().toISOString(),
        speedaNo: '',
        deliveryStatus: '未安排',
      };
      enrich(d, order);
      d.orders.unshift(order);
      audit(d, '新增订单', order.id + ' ' + order.customer, opOf(req));
      save(d);
      send(res, 201, order);
    });
  }

  // ---- 导入订单（CSV/TXT 文本 或 .xlsx 第一个工作表） ----------------------
  if (req.method === 'POST' && u.pathname === '/api/import') {
    return body(req, x => {
      if (!String(x.customer || '').trim()) return send(res, 400, { error: '客户必填' });
      let items;
      if (x.contentBase64 && /\.xlsx$/i.test(String(x.filename || ''))) {
        let parsed;
        try {
          parsed = readXlsx(Buffer.from(String(x.contentBase64), 'base64'));
        } catch (e) {
          return send(res, 400, { error: '无法解析 xlsx 文件：' + e.message });
        }
        const rows = parsed.rows.filter(r => (r || []).some(c => String(c ?? '').trim()));
        const body = rows.length && /^(商品|品名|名称)/.test(String(rows[0][0] || '').trim()) ? rows.slice(1) : rows;
        items = body.map(r => ({ name: String(r[0] ?? '').trim(), qty: Number(r[1]) > 0 ? Number(r[1]) : 1, unit: String(r[2] ?? '').trim() || '件' })).filter(i => i.name);
      } else {
        if (!String(x.content || '').trim()) return send(res, 400, { error: '客户和文件内容必填' });
        const lines = String(x.content).split(/\r?\n/).map(v => v.trim()).filter(Boolean);
        const rows = /^(商品|品名|名称)/i.test(lines[0]) ? lines.slice(1) : lines;
        items = rows.map(parseItemLine);
      }
      if (!validItems(items)) return send(res, 400, { error: '导入内容没有有效商品或数量' });
      d = read();
      const o = {
        id: newId('IMP'),
        customer: x.customer.trim(),
        source: x.source || x.filename || 'Excel/CSV',
        status: '待人工确认',
        amount: Number(x.amount) || 0,
        items,
        createdAt: new Date().toISOString(),
        speedaNo: '',
        deliveryStatus: '未安排',
      };
      enrich(d, o);
      d.orders.unshift(o);
      audit(d, '导入订单', o.id + ' ' + o.source, opOf(req));
      save(d);
      send(res, 201, o);
    });
  }

  // ---- 订单状态机 ---------------------------------------------------------
  const match = u.pathname.match(/^\/api\/orders\/([^/]+)\/(approve|speeda|pick|resolve|cancel|edit)$/);
  if (req.method === 'POST' && match) {
    return body(req, x => {
      d = read();
      const o = d.orders.find(v => v.id === decodeURIComponent(match[1]));
      if (!o) return send(res, 404, { error: '订单不存在' });
      enrich(d, o);
      const act = match[2];

      if (act === 'edit') {
        // 确认前可修改：仅限"待人工确认 / 异常待审核"订单
        if (!['待人工确认', '异常待审核'].includes(o.status)) return send(res, 409, { error: '只有未确认的订单才能修改；已确认订单请先取消后重新录入' });
        if (x.customer !== undefined && !String(x.customer || '').trim()) return send(res, 400, { error: '客户不能为空' });
        if (x.amount !== undefined && (Number.isNaN(Number(x.amount)) || Number(x.amount) < 0)) return send(res, 400, { error: '订单金额必须是非负数字' });
        if (x.items !== undefined) {
          if (!validItems(x.items)) return send(res, 400, { error: '商品明细无效，数量必须大于0' });
          o.items = x.items.map(i => (typeof i === 'string' ? parseItemLine(i) : i));
        }
        if (String(x.customer || '').trim()) o.customer = x.customer.trim();
        if (x.amount !== undefined) o.amount = Number(x.amount) || 0;
        o.status = '待人工确认'; // 重新匹配商品与客户
        enrich(d, o);
        audit(d, '修改订单', o.id, opOf(req));

      } else if (act === 'resolve') {
        // 只允许从"异常待审核"处理，防止把已确认订单打回
        if (o.status !== '异常待审核') return send(res, 409, { error: '只有异常待审核订单才能处理商品异常' });
        const item = o.items.find(i => i.name === x.itemName);
        const p = (d.products || []).find(v => v.sku === x.sku);
        if (!item || !p) return send(res, 400, { error: '商品明细或SKU不存在' });
        item.name = p.name; item.sku = p.sku;
        o.status = '待人工确认';
        enrich(d, o);
        audit(d, '人工处理商品异常', o.id + ' ' + p.sku, opOf(req));

      } else if (act === 'cancel') {
        if (['已送达', '已取消'].includes(o.status) || o.deliveryStatus === '已送达') {
          return send(res, 409, { error: '当前订单不能取消' });
        }
        o.status = '已取消';
        o.cancelReason = String(x.reason || '人工取消');
        audit(d, '人工取消订单', o.id + ' ' + o.cancelReason, opOf(req));

      } else if (act === 'approve') {
        if (o.exceptions && o.exceptions.length) return send(res, 409, { error: '存在未匹配商品，请先处理异常' });
        if (o.status !== '待人工确认') return send(res, 409, { error: '只有待人工确认订单才能确认' });
        o.status = '已确认待速达开单';
        o.confirmedAt = new Date().toISOString();
        audit(d, '人工确认订单', o.id, opOf(req));

      } else if (act === 'pick') {
        if (o.status !== '已登记速达单号') return send(res, 409, { error: '请先完成速达单号登记' });
        const plan = pickPlan(d, o);
        if (plan.some(i => i.shortage > 0)) {
          return send(res, 409, { error: '库存不足，请先人工调整或采购', shortages: plan.filter(i => i.shortage > 0) });
        }
        // 校验通过后按拣货量扣减库存，避免多单合计超卖
        for (const line of plan) {
          const inv = d.inventory.find(v => v.sku === line.sku);
          if (inv) inv.stock = Math.max(0, Number(inv.stock) - line.requested);
        }
        o.pickPlan = plan;
        o.pickStatus = '已生成拣货任务';
        audit(d, '生成拣货任务（已扣减库存）', o.id, opOf(req));

      } else { // speeda：登记外部账本单号（已移除任何 force 旁路）
        if (o.status !== '已确认待速达开单') return send(res, 409, { error: '请先人工确认订单' });
        if (!String(x.speedaNo || '').trim()) return send(res, 400, { error: '请填写速达单号' });
        o.speedaNo = String(x.speedaNo).trim();
        o.status = '已登记速达单号';
        audit(d, '登记速达单号', o.id + ' → ' + o.speedaNo, opOf(req));
      }
      save(d);
      send(res, 200, o);
    });
  }

  // ---- 库存调整（入库 / 出库 / 盘点） --------------------------------------
  if (req.method === 'POST' && u.pathname === '/api/inventory/adjust') {
    return body(req, x => {
      const types = { in: '入库', out: '出库', set: '盘点' };
      if (!types[x.type]) return send(res, 400, { error: 'type 必须是 in（入库）/ out（出库）/ set（盘点）' });
      const qty = Number(x.qty);
      if (!Number.isFinite(qty) || qty < 0) return send(res, 400, { error: '数量必须是非负数字' });
      d = read();
      const inv = (d.inventory || []).find(v => v.sku === x.sku);
      if (!inv) return send(res, 404, { error: '库存条目不存在' });
      const before = Number(inv.stock);
      if (x.type === 'in') inv.stock = before + qty;
      else if (x.type === 'out') inv.stock = Math.max(0, before - qty);
      else inv.stock = qty;
      audit(d, '库存调整（' + types[x.type] + '）', inv.sku + ' ' + before + '→' + inv.stock + (x.reason ? ' ' + x.reason : ''), opOf(req));
      save(d);
      send(res, 200, inv);
    });
  }

  // ---- 配送调度 -----------------------------------------------------------
  if (req.method === 'POST' && u.pathname === '/api/dispatch') {
    return body(req, x => {
      d = read();
      const v = (d.vehicles || []).find(v => v.name === x.vehicle);
      if (!v) return send(res, 404, { error: '车辆不存在' });
      if (!String(x.route || '').trim()) return send(res, 400, { error: '配送路线不能为空' });
      v.route = String(x.route).trim();
      v.load = x.load || '已安排';
      audit(d, '人工安排配送', v.name + ' ' + v.route, opOf(req));
      save(d);
      send(res, 200, v);
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/delivery/status') {
    return body(req, x => {
      d = read();
      const RANK = { '未安排': 0, '待配送': 1, '配送中': 2, '已送达': 3 };
      const o = d.orders.find(v => v.id === x.orderId);
      if (!o || !(x.status in RANK)) return send(res, 400, { error: '订单或配送状态无效' });
      if (x.status !== '未安排' && o.status !== '已登记速达单号') return send(res, 409, { error: '请先登记速达单号' });
      const cur = RANK[o.deliveryStatus] ?? 0;
      if (RANK[x.status] < cur) return send(res, 409, { error: '配送状态只能前进，不能回退（当前：' + (o.deliveryStatus || '未安排') + '）' });
      o.deliveryStatus = x.status;
      audit(d, '更新配送状态', o.id + ' → ' + x.status, opOf(req));
      save(d);
      send(res, 200, o);
    });
  }

  // ---- 主数据管理：商品 / 客户 / 车辆（新商家上线在这里补齐数据） ----------
  // 别名字段接受数组或"逗号/顿号/空格"分隔字符串
  const aliasList = v => Array.isArray(v)
    ? v.map(s => String(s).trim()).filter(Boolean)
    : (typeof v === 'string' ? v.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean) : undefined);
  const num0 = v => (v === undefined || v === '' || v === null) ? null : (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : NaN);

  if (req.method === 'POST' && u.pathname === '/api/products/add') {
    return body(req, x => {
      const sku = String(x.sku || '').trim(), name = String(x.name || '').trim();
      if (!sku || !name) return send(res, 400, { error: 'SKU 和商品名称必填' });
      d = read();
      if (d.products.some(p => p.sku === sku)) return send(res, 409, { error: 'SKU ' + sku + ' 已存在' });
      const prod = { sku, name, aliases: aliasList(x.aliases) || [] };
      d.products.unshift(prod);
      const stock = num0(x.stock), safe = num0(x.safe), cost = num0(x.cost);
      if ([stock, safe, cost].some(v => Number.isNaN(v))) return send(res, 400, { error: '库存/安全库存/成本必须是非负数字' });
      if (stock !== null || safe !== null || cost !== null || String(x.unit || '').trim()) {
        const inv = d.inventory.find(v => v.sku === sku);
        if (!inv) d.inventory.push({ sku, name, stock: stock ?? 0, safe: safe ?? 0, unit: String(x.unit || '件').trim() || '件', cost: cost ?? 0 });
        else Object.assign(inv, { name, stock: stock ?? inv.stock, safe: safe ?? inv.safe, cost: cost ?? inv.cost, unit: String(x.unit || inv.unit || '件').trim() || '件' });
      }
      audit(d, '新增商品', sku + ' ' + name, opOf(req));
      save(d);
      send(res, 201, prod);
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/products/update') {
    return body(req, x => {
      const sku = String(x.sku || '').trim();
      d = read();
      const prod = d.products.find(p => p.sku === sku);
      if (!prod) return send(res, 404, { error: '商品不存在' });
      const name = String(x.name || '').trim();
      if (name) prod.name = name;
      const aliases = aliasList(x.aliases);
      if (aliases !== undefined) prod.aliases = aliases;
      const stock = num0(x.stock), safe = num0(x.safe), cost = num0(x.cost);
      if ([stock, safe, cost].some(v => Number.isNaN(v))) return send(res, 400, { error: '库存/安全库存/成本必须是非负数字' });
      if (stock !== null || safe !== null || cost !== null || String(x.unit || '').trim()) {
        let inv = d.inventory.find(v => v.sku === sku);
        if (!inv) d.inventory.push(inv = { sku, name: prod.name, stock: 0, safe: 0, unit: '件', cost: 0 });
        if (stock !== null) inv.stock = stock;
        if (safe !== null) inv.safe = safe;
        if (cost !== null) inv.cost = cost;
        if (String(x.unit || '').trim()) inv.unit = String(x.unit).trim();
        inv.name = prod.name;
      }
      audit(d, '修改商品', sku, opOf(req));
      save(d);
      send(res, 200, prod);
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/products/delete') {
    return body(req, x => {
      const sku = String(x.sku || '').trim();
      d = read();
      const i = d.products.findIndex(p => p.sku === sku);
      if (i < 0) return send(res, 404, { error: '商品不存在' });
      const invIndex = d.inventory.findIndex(v => v.sku === sku);
      if (invIndex >= 0 && !x.cascade) return send(res, 409, { error: '该商品存在库存条目，需级联删除库存', needCascade: true });
      d.products.splice(i, 1);
      if (invIndex >= 0) d.inventory.splice(invIndex, 1);
      audit(d, '删除商品', sku + (invIndex >= 0 ? '（含库存条目）' : ''), opOf(req));
      save(d);
      send(res, 200, { ok: true });
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/customers/add') {
    return body(req, x => {
      const name = String(x.name || '').trim();
      if (!name) return send(res, 400, { error: '客户名称必填' });
      d = read();
      if (d.customers.some(c => c.name === name || (c.aliases || []).includes(name))) return send(res, 409, { error: '客户或别名已存在：' + name });
      const cust = { id: 'C' + String(d.customers.length + 1).padStart(3, '0'), name, aliases: aliasList(x.aliases) || [] };
      d.customers.push(cust);
      audit(d, '新增客户', name, opOf(req));
      save(d);
      send(res, 201, cust);
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/customers/update') {
    return body(req, x => {
      const key = String(x.id || x.name || '').trim();
      d = read();
      const cust = d.customers.find(c => c.id === key || c.name === key);
      if (!cust) return send(res, 404, { error: '客户不存在' });
      const newName = String(x.newName || '').trim();
      if (newName && d.customers.some(c => c !== cust && (c.name === newName || (c.aliases || []).includes(newName)))) return send(res, 409, { error: '客户或别名已存在：' + newName });
      if (newName) cust.name = newName;
      const aliases = aliasList(x.aliases);
      if (aliases !== undefined) cust.aliases = aliases;
      audit(d, '修改客户', cust.name, opOf(req));
      save(d);
      send(res, 200, cust);
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/customers/delete') {
    return body(req, x => {
      const key = String(x.id || x.name || '').trim();
      d = read();
      const i = d.customers.findIndex(c => c.id === key || c.name === key);
      if (i < 0) return send(res, 404, { error: '客户不存在' });
      const [removed] = d.customers.splice(i, 1);
      audit(d, '删除客户', removed.name, opOf(req));
      save(d);
      send(res, 200, { ok: true });
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/vehicles/add') {
    return body(req, x => {
      const name = String(x.name || '').trim();
      if (!name) return send(res, 400, { error: '车辆名称必填' });
      d = read();
      if (d.vehicles.some(v => v.name === name)) return send(res, 409, { error: '车辆已存在：' + name });
      const v = { name, capacity: String(x.capacity || '').trim() || '—', route: String(x.route || '').trim(), load: '待安排' };
      d.vehicles.push(v);
      audit(d, '新增车辆', name, opOf(req));
      save(d);
      send(res, 201, v);
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/vehicles/update') {
    return body(req, x => {
      const key = String(x.name || '').trim();
      d = read();
      const v = d.vehicles.find(v => v.name === key);
      if (!v) return send(res, 404, { error: '车辆不存在' });
      const newName = String(x.newName || '').trim();
      if (newName && d.vehicles.some(o => o !== v && o.name === newName)) return send(res, 409, { error: '车辆已存在：' + newName });
      if (newName) v.name = newName;
      if (String(x.capacity || '').trim()) v.capacity = String(x.capacity).trim();
      if (String(x.route || '').trim()) v.route = String(x.route).trim();
      if (String(x.load || '').trim()) v.load = String(x.load).trim();
      audit(d, '修改车辆', v.name, opOf(req));
      save(d);
      send(res, 200, v);
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/vehicles/delete') {
    return body(req, x => {
      const key = String(x.name || '').trim();
      d = read();
      const i = d.vehicles.findIndex(v => v.name === key);
      if (i < 0) return send(res, 404, { error: '车辆不存在' });
      const [removed] = d.vehicles.splice(i, 1);
      audit(d, '删除车辆', removed.name, opOf(req));
      save(d);
      send(res, 200, { ok: true });
    });
  }

  // ---- 静态文件 -----------------------------------------------------------
  const file = u.pathname === '/' ? '/index.html' : u.pathname;
  const p = path.normalize(path.join(pubDir, file));
  const rel = path.relative(pubDir, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(p, (e, b) => (e ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, b, mime[path.extname(p)] || 'application/octet-stream')));
}

// 兜底：任何漏网异常只记日志，不让进程退出（局域网工具保持可用优先）
process.on('uncaughtException', e => console.error('[uncaught]', e));
process.on('unhandledRejection', e => console.error('[unhandled]', e));

// 端口绑定失败属于致命错误：响亮退出（不能被运行时兜底吞成静默不启动）
server.on('error', e => {
  console.error('[fatal] 无法监听 ' + HOST + ':' + PORT + ' —— ' + e.message);
  console.error('  端口被占用或被系统保留时，请换端口启动：PORT=其他端口 node server.js');
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const actual = server.address() ? server.address().port : PORT;
  console.log('LISTENING_PORT=' + actual); // 机器可读：测试/脚本用 PORT=0 时从这行取实际端口
  const cfg = readConfig();
  console.log('[' + cfg.app.name + '] v' + APP_VERSION + ' running at http://localhost:' + actual);
  console.log('  数据文件：' + DATA_FILE);
  console.log('  商家配置：' + CONFIG_FILE);
  if (HOST === '0.0.0.0') console.log('  已监听全部网卡（局域网可访问），请确认防火墙已放行 TCP ' + actual);
  else console.log('  当前仅本机可访问；局域网共享请用 HOST=0.0.0.0 启动');
  if (ACCESS_TOKEN) console.log('  已启用访问口令：打开页面需先登录（/login）');
});
