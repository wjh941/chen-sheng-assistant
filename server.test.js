// ============================================================================
// 测试套件：node --test
// 每个用例使用独立的临时数据副本启动服务，不污染演示数据。
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { execFile } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const VERSION = require('./package.json').version;

function request(port, reqPath, method = 'GET', payload, extraHeaders) {
  return new Promise((resolve, reject) => {
    const b = payload && JSON.stringify(payload);
    const headers = { ...(extraHeaders || {}) };
    if (b) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(b);
    }
    const r = http.request({ hostname: 'localhost', port, path: reqPath, method, headers }, x => {
      let out = '';
      x.on('data', c => out += c);
      x.on('end', () => {
        let body;
        try { body = JSON.parse(out); } catch { body = out; }
        resolve({ status: x.statusCode, headers: x.headers, body });
      });
    });
    r.on('error', reject);
    if (b) r.write(b);
    r.end();
  });
}

function start(port, opts = {}) {
  const temp = opts.dataFile || path.join('data', 'test-' + port + '.json');
  if (opts.seed !== false) fs.copyFileSync('data/demo.json', temp);
  const s = execFile(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port), DATA_FILE: temp, ...(opts.env || {}) },
  });
  s.stderr.on('data', () => {}); // 静默服务端日志
  s.on('exit', () => { try { fs.unlinkSync(temp); } catch {} });
  return new Promise(r => setTimeout(() => r(s), 300));
}

// 完整走一遍：创建 → 确认 → 登记单号
async function flowToSpeeda(port, items, amount) {
  const created = await request(port, '/api/orders', 'POST', { customer: '测试食堂', items, amount });
  assert.equal(created.status, 201);
  const approved = await request(port, '/api/orders/' + created.body.id + '/approve', 'POST', {});
  assert.equal(approved.status, 200);
  const sped = await request(port, '/api/orders/' + created.body.id + '/speeda', 'POST', { speedaNo: 'SD-1' });
  assert.equal(sped.status, 200);
  return created.body.id;
}

const riceStock = file => JSON.parse(fs.readFileSync(file, 'utf8')).inventory.find(v => v.sku === 'RICE-25').stock;

// ---------------------------------------------------------------------------
test('项目文件和数据模型存在', () => {
  const d = JSON.parse(fs.readFileSync('data/demo.json'));
  assert.ok(fs.existsSync('README.md'));
  assert.ok(fs.existsSync('config/merchant.json'));
  assert.ok(fs.existsSync('scripts/init-merchant.js'));
  assert.ok(d.orders.length > 0 && d.products.length > 0 && d.vehicles.length === 2);
  assert.ok((d.customers || []).every(c => Array.isArray(c.aliases)));
});

test('健康接口返回本地模式、版本号与商家名', async () => {
  const s = await start(3099);
  const x = await request(3099, '/api/health');
  s.kill();
  assert.equal(x.body.ok, true);
  assert.equal(x.body.localOnly, true);
  assert.equal(x.body.version, VERSION);
  assert.equal(x.body.merchant, '晨升 · 盈泰');
  assert.ok(x.body.orders > 0);
});

test('配置接口返回商家配置与运行元信息', async () => {
  const s = await start(3098);
  const x = await request(3098, '/api/config');
  const e = await request(3098, '/api/export');
  s.kill();
  assert.equal(x.body.config.app.short, '晨升 · 盈泰');
  assert.equal(x.body.config.erp.short, '速达');
  assert.equal(x.body.meta.version, VERSION);
  assert.ok(x.body.meta.dataFile.endsWith('.json'));
  assert.equal(e.status, 200);
  assert.ok(String(e.headers['content-disposition']).startsWith('attachment'));
  assert.ok(e.body.orders.length > 0);
});

test('未匹配商品必须先人工处理，处理后回到待确认', async () => {
  const s = await start(3100);
  const created = await request(3100, '/api/orders', 'POST', { customer: '测试食堂', items: [{ name: '未知菜', qty: 2, unit: '箱' }] });
  assert.equal(created.body.status, '异常待审核');
  const blocked = await request(3100, '/api/orders/' + created.body.id + '/approve', 'POST', {});
  assert.equal(blocked.status, 409);
  const badSku = await request(3100, '/api/orders/' + created.body.id + '/resolve', 'POST', { itemName: '未知菜', sku: 'NOPE' });
  assert.equal(badSku.status, 400);
  const ok = await request(3100, '/api/orders/' + created.body.id + '/resolve', 'POST', { itemName: '未知菜', sku: 'RICE-25' });
  s.kill();
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, '待人工确认');
  assert.equal(ok.body.items[0].sku, 'RICE-25');
});

test('resolve 不能倒退已确认订单的状态', async () => {
  const s = await start(3101);
  const id = await flowToSpeeda(3101, [{ name: '大米', qty: 2, unit: '袋' }], 100);
  const downgraded = await request(3101, '/api/orders/' + id + '/resolve', 'POST', { itemName: '大米', sku: 'RICE-25' });
  s.kill();
  assert.equal(downgraded.status, 409);
});

test('speeda 的 force 旁路已移除，必须先人工确认', async () => {
  const s = await start(3102);
  const created = await request(3102, '/api/orders', 'POST', { customer: '测试食堂', items: [{ name: '大米', qty: 2, unit: '袋' }] });
  const forced = await request(3102, '/api/orders/' + created.body.id + '/speeda', 'POST', { force: true, speedaNo: 'X' });
  assert.equal(forced.status, 409);
  const approved = await request(3102, '/api/orders/' + created.body.id + '/approve', 'POST', {});
  const ok = await request(3102, '/api/orders/' + created.body.id + '/speeda', 'POST', { speedaNo: 'SD-1' });
  s.kill();
  assert.equal(approved.status, 200);
  assert.equal(ok.body.status, '已登记速达单号');
});

test('速达登记前不得推进配送', async () => {
  const s = await start(3103);
  const created = await request(3103, '/api/orders', 'POST', { customer: '测试食堂', items: [{ name: '大米', qty: 2, unit: '袋' }] });
  await request(3103, '/api/orders/' + created.body.id + '/approve', 'POST', {});
  const status = await request(3103, '/api/delivery/status', 'POST', { orderId: created.body.id, status: '配送中' });
  s.kill();
  assert.equal(status.status, 409);
});

test('配送状态只能前进不能回退，已送达不能取消', async () => {
  const s = await start(3104);
  const id = await flowToSpeeda(3104, [{ name: '大米', qty: 2, unit: '袋' }], 100);
  assert.equal((await request(3104, '/api/delivery/status', 'POST', { orderId: id, status: '配送中' })).status, 200);
  const backward = await request(3104, '/api/delivery/status', 'POST', { orderId: id, status: '待配送' });
  assert.equal(backward.status, 409);
  assert.equal((await request(3104, '/api/delivery/status', 'POST', { orderId: id, status: '已送达' })).status, 200);
  const cancelAfterDelivered = await request(3104, '/api/orders/' + id + '/cancel', 'POST', { reason: '测试' });
  s.kill();
  assert.equal(cancelAfterDelivered.status, 409);
});

test('拣货通过后按拣货量扣减库存', async () => {
  const file = 'data/test-3105.json';
  const s = await start(3105, { dataFile: file });
  const before = riceStock(file);
  const id = await flowToSpeeda(3105, [{ name: '大米', qty: 2, unit: '袋' }], 100);
  const pick = await request(3105, '/api/orders/' + id + '/pick', 'POST', {});
  s.kill();
  assert.equal(pick.body.pickStatus, '已生成拣货任务');
  assert.equal(riceStock(file), before - 2);
});

test('库存不足拒绝拣货且不扣减库存', async () => {
  const file = 'data/test-3106.json';
  const s = await start(3106, { dataFile: file });
  const before = riceStock(file);
  const id = await flowToSpeeda(3106, [{ name: '大米', qty: 999, unit: '袋' }], 0);
  const pick = await request(3106, '/api/orders/' + id + '/pick', 'POST', {});
  s.kill();
  assert.equal(pick.status, 409);
  assert.ok(pick.body.shortages.length > 0);
  assert.equal(riceStock(file), before);
});

test('库存调整：入库 / 出库 / 盘点', async () => {
  const file = 'data/test-3107.json';
  const s = await start(3107, { dataFile: file });
  const base = riceStock('data/demo.json');
  const adjust = (type, qty) => request(3107, '/api/inventory/adjust', 'POST', { sku: 'RICE-25', type, qty, reason: '测试' });
  assert.equal((await adjust('in', 5)).body.stock, base + 5);
  await adjust('out', 2);
  const set = await adjust('set', 10);
  const badType = await adjust('move', 1);
  const badSku = await request(3107, '/api/inventory/adjust', 'POST', { sku: 'NOPE', type: 'in', qty: 1 });
  s.kill();
  assert.equal(set.body.stock, 10);
  assert.equal(badType.status, 400);
  assert.equal(badSku.status, 404);
});

test('经营分析由订单实时汇总', async () => {
  const s = await start(3108);
  const before = (await request(3108, '/api/overview')).body.analytics;
  await request(3108, '/api/orders', 'POST', { customer: '测试食堂', items: [{ name: '大米', qty: 2, unit: '袋' }], amount: 100 });
  const after = (await request(3108, '/api/overview')).body.analytics;
  s.kill();
  assert.equal(after.todaySales - before.todaySales, 100);
  assert.equal(after.monthSales - before.monthSales, 100);
  assert.equal(Math.round(after.monthCost - before.monthCost), 256); // 2 袋 × 成本 128
});

test('导入与手填行为一致：缺数量行默认数量 1', async () => {
  const s = await start(3109);
  const imported = await request(3109, '/api/import', 'POST', { customer: '测试食堂', content: '鸡蛋\n东北大米,10,袋\n' });
  s.kill();
  assert.equal(imported.status, 201);
  assert.equal(imported.body.items[0].qty, 1);
  assert.equal(imported.body.items[1].qty, 10);
});

test('数据文件缺失时自动播种空库', async () => {
  const file = 'data/test-seed.json';
  try { fs.unlinkSync(file); } catch {}
  const s = await start(3110, { dataFile: file, seed: false });
  const x = await request(3110, '/api/health');
  const seeded = fs.existsSync(file);
  s.kill();
  assert.equal(x.body.ok, true);
  assert.equal(x.body.orders, 0);
  assert.ok(seeded);
});

test('数据文件损坏返回 500 且进程不崩溃', async () => {
  const file = 'data/test-corrupt.json';
  fs.writeFileSync(file, '{ 这不是JSON');
  const s = await start(3111, { dataFile: file, seed: false });
  const first = await request(3111, '/api/health');
  const second = await request(3111, '/api/health');
  s.kill();
  assert.equal(first.status, 500);
  assert.ok(second.status === 500); // 还能继续响应，说明进程没有退出
});

test('审计日志截断到 500 条，不会无限膨胀', async () => {
  const file = 'data/test-audit.json';
  const d = JSON.parse(fs.readFileSync('data/demo.json'));
  d.audit = Array.from({ length: 600 }, (_, i) => ({ id: i, time: '2026-01-01T00:00:00.000Z', action: '测试', detail: String(i) }));
  fs.writeFileSync(file, JSON.stringify(d));
  const s = await start(3125, { dataFile: file, seed: false });
  await request(3125, '/api/orders', 'POST', { customer: '测试食堂', items: [{ name: '大米', qty: 1, unit: '袋' }] });
  const len = JSON.parse(fs.readFileSync(file, 'utf8')).audit.length;
  s.kill();
  assert.equal(len, 500);
});

test('跨站 Origin 的 POST 被拒绝，非 JSON 内容类型返回 415', async () => {
  const s = await start(3113);
  const evil = await request(3113, '/api/orders', 'POST', { customer: 'x', items: ['大米'] }, { Origin: 'http://evil.example' });
  const wrongType = await request(3113, '/api/orders', 'POST', { customer: 'x', items: ['大米'] }, { 'Content-Type': 'text/plain' });
  s.kill();
  assert.equal(evil.status, 403);
  assert.equal(wrongType.status, 415);
});

test('订单 ID 唯一（快速连续创建不撞号）', async () => {
  const s = await start(3114);
  const ids = (await Promise.all([
    request(3114, '/api/orders', 'POST', { customer: '测试食堂', items: ['大米'] }),
    request(3114, '/api/orders', 'POST', { customer: '测试食堂', items: ['大米'] }),
    request(3114, '/api/orders', 'POST', { customer: '测试食堂', items: ['大米'] }),
  ])).map(x => x.body.id);
  s.kill();
  assert.equal(new Set(ids).size, 3);
});
