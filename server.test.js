// ============================================================================
// 测试套件：node --test
// - 服务以 PORT=0 随机端口启动（从 stdout 的 LISTENING_PORT= 取实际端口），
//   不依赖任何固定端口，规避 Windows 动态保留端口区间问题；
// - 每个用例使用独立的临时数据副本，不污染演示数据。
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
    const r = http.request({ hostname: '127.0.0.1', port, path: reqPath, method, headers }, x => {
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

// 启动服务（随机端口），返回 { proc, port, kill, file }
function start(opts = {}) {
  const temp = opts.dataFile || path.join('data', 'test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.json');
  if (opts.seed !== false) fs.copyFileSync('data/demo.json', temp);
  const proc = execFile(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: '0', DATA_FILE: temp, ...(opts.env || {}) },
  });
  proc.stderr.on('data', () => {}); // 静默服务端日志
  proc.on('exit', () => { try { fs.unlinkSync(temp); } catch {} });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务启动超时')), 8000);
    const onData = d => {
      const m = /LISTENING_PORT=(\d+)/.exec(String(d));
      if (m) {
        clearTimeout(timer);
        proc.stdout.off('data', onData);
        resolve({ proc, port: Number(m[1]), kill: () => proc.kill(), file: temp });
      }
    };
    proc.stdout.on('data', onData);
  });
}

// 用完即杀：即使断言失败也保证子进程被清理
async function withServer(opts, fn) {
  const s = await start(opts);
  try {
    return await fn(s.port);
  } finally {
    s.kill();
  }
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
  assert.ok(fs.existsSync('lib/xlsx.js'));
  assert.ok(d.orders.length > 0 && d.products.length > 0 && d.vehicles.length === 2);
  assert.ok((d.customers || []).every(c => Array.isArray(c.aliases)));
});

test('健康接口返回本地模式、版本号与商家名', async () => {
  await withServer({}, async p => {
    const x = await request(p, '/api/health');
    assert.equal(x.body.ok, true);
    assert.equal(x.body.localOnly, true);
    assert.equal(x.body.version, VERSION);
    assert.equal(x.body.merchant, '晨升 · 盈泰');
    assert.ok(x.body.orders > 0);
  });
});

test('配置接口返回商家配置与运行元信息', async () => {
  await withServer({}, async p => {
    const x = await request(p, '/api/config');
    const e = await request(p, '/api/export');
    assert.equal(x.body.config.app.short, '晨升 · 盈泰');
    assert.equal(x.body.config.erp.short, '速达');
    assert.equal(x.body.meta.version, VERSION);
    assert.ok(x.body.meta.port > 0);
    assert.ok(x.body.meta.dataFile.endsWith('.json'));
    assert.equal(e.status, 200);
    assert.ok(String(e.headers['content-disposition']).startsWith('attachment'));
    assert.ok(e.body.orders.length > 0);
  });
});

test('未匹配商品必须先人工处理，处理后回到待确认', async () => {
  await withServer({}, async p => {
    const created = await request(p, '/api/orders', 'POST', { customer: '测试食堂', items: [{ name: '未知菜', qty: 2, unit: '箱' }] });
    assert.equal(created.body.status, '异常待审核');
    const blocked = await request(p, '/api/orders/' + created.body.id + '/approve', 'POST', {});
    assert.equal(blocked.status, 409);
    const badSku = await request(p, '/api/orders/' + created.body.id + '/resolve', 'POST', { itemName: '未知菜', sku: 'NOPE' });
    assert.equal(badSku.status, 400);
    const ok = await request(p, '/api/orders/' + created.body.id + '/resolve', 'POST', { itemName: '未知菜', sku: 'RICE-25' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, '待人工确认');
    assert.equal(ok.body.items[0].sku, 'RICE-25');
  });
});

test('resolve 不能倒退已确认订单的状态', async () => {
  await withServer({}, async p => {
    const id = await flowToSpeeda(p, [{ name: '大米', qty: 2, unit: '袋' }], 100);
    const downgraded = await request(p, '/api/orders/' + id + '/resolve', 'POST', { itemName: '大米', sku: 'RICE-25' });
    assert.equal(downgraded.status, 409);
  });
});

test('speeda 的 force 旁路已移除，必须先人工确认', async () => {
  await withServer({}, async p => {
    const created = await request(p, '/api/orders', 'POST', { customer: '测试食堂', items: [{ name: '大米', qty: 2, unit: '袋' }] });
    const forced = await request(p, '/api/orders/' + created.body.id + '/speeda', 'POST', { force: true, speedaNo: 'X' });
    assert.equal(forced.status, 409);
    const approved = await request(p, '/api/orders/' + created.body.id + '/approve', 'POST', {});
    const ok = await request(p, '/api/orders/' + created.body.id + '/speeda', 'POST', { speedaNo: 'SD-1' });
    assert.equal(approved.status, 200);
    assert.equal(ok.body.status, '已登记速达单号');
  });
});

test('速达登记前不得推进配送', async () => {
  await withServer({}, async p => {
    const created = await request(p, '/api/orders', 'POST', { customer: '测试食堂', items: [{ name: '大米', qty: 2, unit: '袋' }] });
    await request(p, '/api/orders/' + created.body.id + '/approve', 'POST', {});
    const status = await request(p, '/api/delivery/status', 'POST', { orderId: created.body.id, status: '配送中' });
    assert.equal(status.status, 409);
  });
});

test('配送状态只能前进不能回退，已送达不能取消', async () => {
  await withServer({}, async p => {
    const id = await flowToSpeeda(p, [{ name: '大米', qty: 2, unit: '袋' }], 100);
    assert.equal((await request(p, '/api/delivery/status', 'POST', { orderId: id, status: '配送中' })).status, 200);
    const backward = await request(p, '/api/delivery/status', 'POST', { orderId: id, status: '待配送' });
    assert.equal(backward.status, 409);
    assert.equal((await request(p, '/api/delivery/status', 'POST', { orderId: id, status: '已送达' })).status, 200);
    const cancelAfterDelivered = await request(p, '/api/orders/' + id + '/cancel', 'POST', { reason: '测试' });
    assert.equal(cancelAfterDelivered.status, 409);
  });
});

test('拣货通过后按拣货量扣减库存', async () => {
  const file = 'data/test-pick-deduct.json';
  await withServer({ dataFile: file }, async p => {
    const before = riceStock(file);
    const id = await flowToSpeeda(p, [{ name: '大米', qty: 2, unit: '袋' }], 100);
    const pick = await request(p, '/api/orders/' + id + '/pick', 'POST', {});
    assert.equal(pick.body.pickStatus, '已生成拣货任务');
    assert.equal(riceStock(file), before - 2);
  });
});

test('库存不足拒绝拣货且不扣减库存', async () => {
  const file = 'data/test-pick-short.json';
  await withServer({ dataFile: file }, async p => {
    const before = riceStock(file);
    const id = await flowToSpeeda(p, [{ name: '大米', qty: 999, unit: '袋' }], 0);
    const pick = await request(p, '/api/orders/' + id + '/pick', 'POST', {});
    assert.equal(pick.status, 409);
    assert.ok(pick.body.shortages.length > 0);
    assert.equal(riceStock(file), before);
  });
});

test('库存调整：入库 / 出库 / 盘点', async () => {
  await withServer({}, async p => {
    const base = riceStock('data/demo.json');
    const adjust = (type, qty) => request(p, '/api/inventory/adjust', 'POST', { sku: 'RICE-25', type, qty, reason: '测试' });
    assert.equal((await adjust('in', 5)).body.stock, base + 5);
    await adjust('out', 2);
    const set = await adjust('set', 10);
    const badType = await adjust('move', 1);
    const badSku = await request(p, '/api/inventory/adjust', 'POST', { sku: 'NOPE', type: 'in', qty: 1 });
    assert.equal(set.body.stock, 10);
    assert.equal(badType.status, 400);
    assert.equal(badSku.status, 404);
  });
});

test('经营分析由订单实时汇总', async () => {
  await withServer({}, async p => {
    const before = (await request(p, '/api/overview')).body.analytics;
    await request(p, '/api/orders', 'POST', { customer: '测试食堂', items: [{ name: '大米', qty: 2, unit: '袋' }], amount: 100 });
    const after = (await request(p, '/api/overview')).body.analytics;
    assert.equal(after.todaySales - before.todaySales, 100);
    assert.equal(after.monthSales - before.monthSales, 100);
    assert.equal(Math.round(after.monthCost - before.monthCost), 256); // 2 袋 × 成本 128
  });
});

test('导入与手填行为一致：缺数量行默认数量 1', async () => {
  await withServer({}, async p => {
    const imported = await request(p, '/api/import', 'POST', { customer: '测试食堂', content: '鸡蛋\n东北大米,10,袋\n' });
    assert.equal(imported.status, 201);
    assert.equal(imported.body.items[0].qty, 1);
    assert.equal(imported.body.items[1].qty, 10);
  });
});

test('数据文件缺失时自动播种空库', async () => {
  const file = 'data/test-seed-auto.json';
  try { fs.unlinkSync(file); } catch {}
  await withServer({ dataFile: file, seed: false }, async p => {
    const x = await request(p, '/api/health');
    assert.equal(x.body.ok, true);
    assert.equal(x.body.orders, 0);
    assert.ok(fs.existsSync(file));
  });
});

test('数据文件损坏返回 500 且进程不崩溃', async () => {
  const file = 'data/test-corrupt.json';
  fs.writeFileSync(file, '{ 这不是JSON');
  await withServer({ dataFile: file, seed: false }, async p => {
    const first = await request(p, '/api/health');
    const second = await request(p, '/api/health');
    assert.equal(first.status, 500);
    assert.equal(second.status, 500); // 还能继续响应，说明进程没有退出
  });
});

test('审计日志截断到 500 条，不会无限膨胀', async () => {
  const file = 'data/test-audit-cap.json';
  const d = JSON.parse(fs.readFileSync('data/demo.json'));
  d.audit = Array.from({ length: 600 }, (_, i) => ({ id: i, time: '2026-01-01T00:00:00.000Z', action: '测试', detail: String(i) }));
  fs.writeFileSync(file, JSON.stringify(d));
  await withServer({ dataFile: file, seed: false }, async p => {
    await request(p, '/api/orders', 'POST', { customer: '测试食堂', items: [{ name: '大米', qty: 1, unit: '袋' }] });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).audit.length, 500);
  });
});

test('跨站 Origin 的 POST 被拒绝，非 JSON 内容类型返回 415', async () => {
  await withServer({}, async p => {
    const evil = await request(p, '/api/orders', 'POST', { customer: 'x', items: ['大米'] }, { Origin: 'http://evil.example' });
    const wrongType = await request(p, '/api/orders', 'POST', { customer: 'x', items: ['大米'] }, { 'Content-Type': 'text/plain' });
    assert.equal(evil.status, 403);
    assert.equal(wrongType.status, 415);
  });
});

test('订单 ID 唯一（快速连续创建不撞号）', async () => {
  await withServer({}, async p => {
    const ids = (await Promise.all([
      request(p, '/api/orders', 'POST', { customer: '测试食堂', items: ['大米'] }),
      request(p, '/api/orders', 'POST', { customer: '测试食堂', items: ['大米'] }),
      request(p, '/api/orders', 'POST', { customer: '测试食堂', items: ['大米'] }),
    ])).map(x => x.body.id);
    assert.equal(new Set(ids).size, 3);
  });
});

// ---------------------------------------------------------------------------
// v0.8.0：编辑 / 操作员 / 备份 / Excel / 访问口令
// ---------------------------------------------------------------------------
test('确认前可编辑订单并重新匹配，确认后禁止编辑', async () => {
  await withServer({}, async p => {
    const created = await request(p, '/api/orders', 'POST', { customer: '测试食堂', items: [{ name: '大米', qty: 2, unit: '袋' }], amount: 100 });
    const id = created.body.id;
    const edited1 = await request(p, '/api/orders/' + id + '/edit', 'POST', { items: [{ name: '未知菜', qty: 1, unit: '箱' }], amount: 50 });
    assert.equal(edited1.status, 200);
    assert.equal(edited1.body.status, '异常待审核');
    assert.equal(edited1.body.amount, 50);
    const edited2 = await request(p, '/api/orders/' + id + '/edit', 'POST', { items: ['大米,3,袋'], customer: '东莞某中学食堂' });
    assert.equal(edited2.status, 200);
    assert.equal(edited2.body.status, '待人工确认');
    assert.equal(edited2.body.customerMatched, true);
    await request(p, '/api/orders/' + id + '/approve', 'POST', {});
    const edited3 = await request(p, '/api/orders/' + id + '/edit', 'POST', { items: ['大米'] });
    assert.equal(edited3.status, 409);
  });
});

test('操作员标识随 X-Operator 头进入审计（URI 编码传输）', async () => {
  await withServer({}, async p => {
    await request(p, '/api/orders', 'POST', { customer: '测试食堂', items: ['大米'] }, { 'X-Operator': encodeURIComponent('张三') });
    const a = await request(p, '/api/audit');
    assert.equal(a.body.items[0].operator, '张三');
  });
});

test('每日自动备份：一天一份，滚动保留 14 份', async () => {
  const dir = 'data/bk-test';
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
    const file = path.join(dir, 'demo.json');
    fs.copyFileSync('data/demo.json', file);
    // 预置 16 份历史备份（与数据文件同名前缀 demo-），验证滚动清理
    for (let i = 1; i <= 16; i++) {
      fs.writeFileSync(path.join(dir, 'backups', 'demo-2025' + String(i).padStart(4, '0') + '01.json'), '{}');
    }
    await withServer({ dataFile: file }, async p => {
      await request(p, '/api/orders', 'POST', { customer: '测试食堂', items: ['大米'] });
      await request(p, '/api/orders', 'POST', { customer: '测试食堂', items: ['大米'] }); // 同日第二笔不再重复备份
      const bkDir = path.join(dir, 'backups');
      const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');
      const todaySnaps = fs.readdirSync(bkDir).filter(f => f === 'demo-' + today + '.json');
      assert.equal(todaySnaps.length, 1, '应有且仅有一份今日快照');
      assert.equal(fs.readdirSync(bkDir).length, 14, '备份总数滚动保留 14 份');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('支持 .xlsx 导入（零依赖解析）', async () => {
  await withServer({}, async p => {
    const { writeXlsx } = require('./lib/xlsx');
    const buf = writeXlsx([{ name: '订单', rows: [['商品', '数量', '单位'], ['大米', '5', '袋'], ['鸡蛋', '2', '盘']] }]);
    const created = await request(p, '/api/import', 'POST', { customer: '测试食堂', filename: '订单.xlsx', contentBase64: buf.toString('base64') });
    assert.equal(created.status, 201);
    assert.equal(created.body.items.length, 2);
    assert.deepEqual(created.body.items[0], { name: '大米', qty: 5, unit: '袋' });
    assert.equal(created.body.items[1].unit, '盘');
  });
});

test('订单可导出为 xlsx 并能被读回', async () => {
  await withServer({}, async p => {
    const r = await fetch('http://127.0.0.1:' + p + '/api/export/orders.xlsx');
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(r.status, 200);
    assert.ok(String(r.headers.get('content-disposition')).includes('.xlsx'));
    assert.equal(buf[0], 0x50); // 'P'
    assert.equal(buf[1], 0x4B); // 'K'（zip 魔数）
    const { readXlsx } = require('./lib/xlsx');
    const parsed = readXlsx(buf);
    assert.equal(parsed.rows[0][0], '订单号');
    assert.ok(parsed.rows.length > 1);
  });
});

test('设置 ACCESS_TOKEN 后未登录访问被拦截，登录后放行，登出即刻失效', async () => {
  await withServer({ env: { ACCESS_TOKEN: 'secret123' } }, async p => {
    assert.equal((await request(p, '/api/health')).status, 200); // 健康检查保持开放
    assert.equal((await request(p, '/api/overview')).status, 401);
    assert.equal((await request(p, '/api/orders', 'POST', { customer: 'x', items: ['大米'] })).status, 401);
    assert.equal((await request(p, '/login', 'POST', { token: 'wrong' })).status, 401);
    const good = await request(p, '/login', 'POST', { token: 'secret123' });
    const raw = (good.headers['set-cookie'] || [])[0] || '';
    assert.equal(good.status, 200);
    assert.ok(raw.includes('ops_token=') && raw.includes('HttpOnly'));
    const cookie = raw.split(';')[0];
    assert.equal((await request(p, '/api/overview', 'GET', null, { Cookie: cookie })).status, 200);
    assert.equal((await request(p, '/logout', 'GET', null, { Cookie: cookie })).status, 302);
    assert.equal((await request(p, '/api/overview', 'GET', null, { Cookie: cookie })).status, 401); // 登出后立即失效
  });
});

test('lib/xlsx 读写回环：中文与特殊字符不丢失', () => {
  const { readXlsx, writeXlsx } = require('./lib/xlsx');
  const rows = [['商品&名称', '<数量>'], ['大米', '5'], ['A"B\'C', '']];
  const parsed = readXlsx(writeXlsx([{ name: '测试<sheets>&', rows }]));
  assert.equal(parsed.sheetName, '测试<sheets>&');
  assert.deepEqual(parsed.rows[0], ['商品&名称', '<数量>']);
  assert.deepEqual(parsed.rows[1], ['大米', '5']);
  assert.equal(parsed.rows[2][0], 'A"B\'C'); // 行尾空单元格在表格语义下自然丢弃
});
