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
const { readXlsx, writeXlsx } = require('./lib/xlsx');
const { createStore } = require('./lib/store');
const { validItems, parseItemLine, enrich, analytics, orderActions } = require('./lib/orders');
const { send, body, opOf, sameOrigin } = require('./lib/http-utils');
const { createAuth, loginPage } = require('./lib/auth');

const root = __dirname;
const pkg = require('./package.json');
const APP_VERSION = pkg.version;

const DATA_FILE = process.env.DATA_FILE || path.join(root, 'data', 'demo.json');
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(root, 'config', 'merchant.json');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3088;
// 可选访问口令：设置后所有页面与接口（除 /login、/api/health）都需要登录
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';

// 数据层实例：配置 + 数据文件 + 审计（依赖显式注入，不用全局单例）
const store = createStore({ dataFile: DATA_FILE, configFile: CONFIG_FILE, appVersion: APP_VERSION });

// 鉴权实例：会话签名密钥与登录限速计数都在实例内（进程内存，重启即清零）
// 窗口/阈值/锁定时长可用环境变量覆盖（测试用它缩短等待，默认生产值不变）。
const auth = createAuth({
  accessToken: ACCESS_TOKEN,
  rateWindowMs: Number(process.env.LOGIN_RATE_WINDOW_MS) || 60 * 1000,  // 失败计数窗口：60 秒
  rateMaxFails: Number(process.env.LOGIN_RATE_MAX_FAILS) || 5,          // 窗口内允许失败次数
  rateLockMs: Number(process.env.LOGIN_RATE_LOCK_MS) || 5 * 60 * 1000,  // 达上限后锁定：5 分钟
});

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
    if (!open && !auth.hasToken(req)) {
      if (req.method === 'GET' && !u.pathname.startsWith('/api/')) {
        return send(res, 302, '', 'text/plain', { Location: '/login' });
      }
      return send(res, 401, { error: '请先登录' });
    }
  }
  if (req.method === 'GET' && u.pathname === '/login') return send(res, 200, loginPage(), 'text/html; charset=utf-8');
  if (req.method === 'POST' && u.pathname === '/login') {
    return body(req, x => {
      // 锁定期内不比对口令直接 429：让暴力尝试的代价随次数上升，而非恒定可枚举
      const lockedMs = auth.loginLockedMs(req);
      if (lockedMs > 0) {
        return send(res, 429, { error: '登录失败次数过多，请稍后再试' }, 'application/json; charset=utf-8', {
          'Retry-After': String(Math.ceil(lockedMs / 1000)), // 机器可读的剩余锁定秒数
        });
      }
      if (!auth.tokenMatches(String(x.token || ''))) {
        auth.recordLoginFail(req);
        return send(res, 401, { error: '口令错误' });
      }
      auth.clearLoginFails(req);
      send(res, 200, { ok: true }, 'application/json; charset=utf-8', {
        'Set-Cookie': 'ops_token=' + encodeURIComponent(auth.sessionSig()) + '; Path=/; HttpOnly; SameSite=Strict',
      });
    });
  }
  if (req.method === 'GET' && u.pathname === '/logout') {
    auth.rotateSecret(); // 轮换签名密钥：所有已发会话立即失效
    return send(res, 302, '', 'text/plain', { Location: '/login', 'Set-Cookie': 'ops_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
  }

  let d;

  // ---- 配置与健康检查 -----------------------------------------------------
  if (req.method === 'GET' && u.pathname === '/api/config') {
    return send(res, 200, {
      config: store.readConfig(),
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
    d = store.read();
    return send(res, 200, {
      ok: true, localOnly: true, version: APP_VERSION,
      merchant: store.readConfig().app.short,
      orders: d.orders.length, customers: d.customers.length, products: d.products.length,
    });
  }

  // ---- 查询类 -------------------------------------------------------------
  if (req.method === 'GET' && u.pathname === '/api/overview') {
    d = store.read();
    d.orders.forEach(o => enrich(d, o));
    return send(res, 200, {
      version: APP_VERSION, config: store.readConfig(),
      customers: d.customers, products: d.products,
      orders: d.orders, inventory: d.inventory, vehicles: d.vehicles,
      audit: d.audit, analytics: analytics(d),
    });
  }
  if (req.method === 'GET' && u.pathname === '/api/catalog') {
    d = store.read();
    return send(res, 200, { customers: d.customers, products: d.products });
  }
  if (req.method === 'GET' && u.pathname === '/api/audit') {
    d = store.read();
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
    d = store.read();
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
      d = store.read();
      const order = {
        id: store.newId('LOCAL'),
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
      store.audit(d, '新增订单', order.id + ' ' + order.customer, opOf(req));
      store.save(d);
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
      d = store.read();
      const o = {
        id: store.newId('IMP'),
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
      store.audit(d, '导入订单', o.id + ' ' + o.source, opOf(req));
      store.save(d);
      send(res, 201, o);
    });
  }

  // ---- 订单状态机 ---------------------------------------------------------
  const match = u.pathname.match(/^\/api\/orders\/([^/]+)\/(approve|speeda|pick|resolve|cancel|edit)$/);
  if (req.method === 'POST' && match) {
    return body(req, x => {
      d = store.read();
      const o = d.orders.find(v => v.id === decodeURIComponent(match[1]));
      if (!o) return send(res, 404, { error: '订单不存在' });
      enrich(d, o);
      // 状态机在 lib/orders.js：校验 → 流转 → 审计；返回错误描述则原样响应
      const err = orderActions[match[2]](d, o, x, { audit: store.audit, operator: opOf(req) });
      if (err) return send(res, err.status, err.body);
      store.save(d);
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
      d = store.read();
      const inv = (d.inventory || []).find(v => v.sku === x.sku);
      if (!inv) return send(res, 404, { error: '库存条目不存在' });
      const before = Number(inv.stock);
      if (x.type === 'in') inv.stock = before + qty;
      else if (x.type === 'out') inv.stock = Math.max(0, before - qty);
      else inv.stock = qty;
      store.audit(d, '库存调整（' + types[x.type] + '）', inv.sku + ' ' + before + '→' + inv.stock + (x.reason ? ' ' + x.reason : ''), opOf(req));
      store.save(d);
      send(res, 200, inv);
    });
  }

  // ---- 配送调度 -----------------------------------------------------------
  if (req.method === 'POST' && u.pathname === '/api/dispatch') {
    return body(req, x => {
      d = store.read();
      const v = (d.vehicles || []).find(v => v.name === x.vehicle);
      if (!v) return send(res, 404, { error: '车辆不存在' });
      if (!String(x.route || '').trim()) return send(res, 400, { error: '配送路线不能为空' });
      v.route = String(x.route).trim();
      v.load = x.load || '已安排';
      store.audit(d, '人工安排配送', v.name + ' ' + v.route, opOf(req));
      store.save(d);
      send(res, 200, v);
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/delivery/status') {
    return body(req, x => {
      d = store.read();
      const RANK = { '未安排': 0, '待配送': 1, '配送中': 2, '已送达': 3 };
      const o = d.orders.find(v => v.id === x.orderId);
      if (!o || !(x.status in RANK)) return send(res, 400, { error: '订单或配送状态无效' });
      if (x.status !== '未安排' && o.status !== '已登记速达单号') return send(res, 409, { error: '请先登记速达单号' });
      const cur = RANK[o.deliveryStatus] ?? 0;
      if (RANK[x.status] < cur) return send(res, 409, { error: '配送状态只能前进，不能回退（当前：' + (o.deliveryStatus || '未安排') + '）' });
      o.deliveryStatus = x.status;
      store.audit(d, '更新配送状态', o.id + ' → ' + x.status, opOf(req));
      store.save(d);
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
      d = store.read();
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
      store.audit(d, '新增商品', sku + ' ' + name, opOf(req));
      store.save(d);
      send(res, 201, prod);
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/products/update') {
    return body(req, x => {
      const sku = String(x.sku || '').trim();
      d = store.read();
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
      store.audit(d, '修改商品', sku, opOf(req));
      store.save(d);
      send(res, 200, prod);
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/products/delete') {
    return body(req, x => {
      const sku = String(x.sku || '').trim();
      d = store.read();
      const i = d.products.findIndex(p => p.sku === sku);
      if (i < 0) return send(res, 404, { error: '商品不存在' });
      const invIndex = d.inventory.findIndex(v => v.sku === sku);
      if (invIndex >= 0 && !x.cascade) return send(res, 409, { error: '该商品存在库存条目，需级联删除库存', needCascade: true });
      d.products.splice(i, 1);
      if (invIndex >= 0) d.inventory.splice(invIndex, 1);
      store.audit(d, '删除商品', sku + (invIndex >= 0 ? '（含库存条目）' : ''), opOf(req));
      store.save(d);
      send(res, 200, { ok: true });
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/customers/add') {
    return body(req, x => {
      const name = String(x.name || '').trim();
      if (!name) return send(res, 400, { error: '客户名称必填' });
      d = store.read();
      if (d.customers.some(c => c.name === name || (c.aliases || []).includes(name))) return send(res, 409, { error: '客户或别名已存在：' + name });
      const maxNo = d.customers.reduce((n, c) => Math.max(n, parseInt(String(c.id).slice(1), 10) || 0), 0);
      const cust = { id: 'C' + String(maxNo + 1).padStart(3, '0'), name, aliases: aliasList(x.aliases) || [] };
      d.customers.push(cust);
      store.audit(d, '新增客户', name, opOf(req));
      store.save(d);
      send(res, 201, cust);
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/customers/update') {
    return body(req, x => {
      const key = String(x.id || x.name || '').trim();
      d = store.read();
      const cust = d.customers.find(c => c.id === key || c.name === key);
      if (!cust) return send(res, 404, { error: '客户不存在' });
      const newName = String(x.newName || '').trim();
      if (newName && d.customers.some(c => c !== cust && (c.name === newName || (c.aliases || []).includes(newName)))) return send(res, 409, { error: '客户或别名已存在：' + newName });
      if (newName) cust.name = newName;
      const aliases = aliasList(x.aliases);
      if (aliases !== undefined) cust.aliases = aliases;
      store.audit(d, '修改客户', cust.name, opOf(req));
      store.save(d);
      send(res, 200, cust);
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/customers/delete') {
    return body(req, x => {
      const key = String(x.id || x.name || '').trim();
      d = store.read();
      const i = d.customers.findIndex(c => c.id === key || c.name === key);
      if (i < 0) return send(res, 404, { error: '客户不存在' });
      const [removed] = d.customers.splice(i, 1);
      store.audit(d, '删除客户', removed.name, opOf(req));
      store.save(d);
      send(res, 200, { ok: true });
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/vehicles/add') {
    return body(req, x => {
      const name = String(x.name || '').trim();
      if (!name) return send(res, 400, { error: '车辆名称必填' });
      d = store.read();
      if (d.vehicles.some(v => v.name === name)) return send(res, 409, { error: '车辆已存在：' + name });
      const v = { name, capacity: String(x.capacity || '').trim() || '—', route: String(x.route || '').trim(), load: '待安排' };
      d.vehicles.push(v);
      store.audit(d, '新增车辆', name, opOf(req));
      store.save(d);
      send(res, 201, v);
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/vehicles/update') {
    return body(req, x => {
      const key = String(x.name || '').trim();
      d = store.read();
      const v = d.vehicles.find(v => v.name === key);
      if (!v) return send(res, 404, { error: '车辆不存在' });
      const newName = String(x.newName || '').trim();
      if (newName && d.vehicles.some(o => o !== v && o.name === newName)) return send(res, 409, { error: '车辆已存在：' + newName });
      if (newName) v.name = newName;
      if (String(x.capacity || '').trim()) v.capacity = String(x.capacity).trim();
      if (String(x.route || '').trim()) v.route = String(x.route).trim();
      if (String(x.load || '').trim()) v.load = String(x.load).trim();
      store.audit(d, '修改车辆', v.name, opOf(req));
      store.save(d);
      send(res, 200, v);
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/vehicles/delete') {
    return body(req, x => {
      const key = String(x.name || '').trim();
      d = store.read();
      const i = d.vehicles.findIndex(v => v.name === key);
      if (i < 0) return send(res, 404, { error: '车辆不存在' });
      const [removed] = d.vehicles.splice(i, 1);
      store.audit(d, '删除车辆', removed.name, opOf(req));
      store.save(d);
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
  const cfg = store.readConfig();
  console.log('[' + cfg.app.name + '] v' + APP_VERSION + ' running at http://localhost:' + actual);
  console.log('  数据文件：' + DATA_FILE);
  console.log('  商家配置：' + CONFIG_FILE);
  if (HOST === '0.0.0.0') console.log('  已监听全部网卡（局域网可访问），请确认防火墙已放行 TCP ' + actual);
  else console.log('  当前仅本机可访问；局域网共享请用 HOST=0.0.0.0 启动');
  if (ACCESS_TOKEN) console.log('  已启用访问口令：打开页面需先登录（/login）');
});
