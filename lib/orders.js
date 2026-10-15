// ============================================================================
// 订单业务层：状态机与派生逻辑（纯业务函数，不感知 HTTP）
//
// 职责：
//   1. 行解析与匹配：parseItemLine / validItems / productFor / customerFor；
//   2. 派生信息：enrich（商品客户匹配、异常列表、createdAt 回填）、
//      pickPlan（拣货计划与缺口）、analytics（经营分析实时汇总）；
//   3. 库存扣减：deductForPlan（拣货通过后按拣货量扣减，避免超卖）；
//   4. 订单状态机：orderActions（edit/resolve/cancel/approve/pick/speeda）。
//      每个动作做"校验 → 流转 → 审计"，失败时返回 { status, body } 错误描述、
//      成功返回 null（由 HTTP 层决定如何响应），数据对象原位修改。
//
// 依赖显式传入：动作通过 ctx = { audit, operator } 拿到审计函数与操作员标识；
// 数据对象 d 由调用方（路由层）从 lib/store 读取后传入，本层不直接碰文件。
// 每请求内 read-modify-save 全同步无 await（Node 单线程天然串行，无需加锁）。
// ============================================================================
'use strict';

// "商品,数量,单位" 逐行解析：兼容制表符与中英文逗号，缺数量默认 1（导入与手填行为一致）
function parseItemLine(line) {
  const c = String(line).split(/[\t,，]/).map(v => v.trim());
  return { name: c[0], qty: Number(c[1]) > 0 ? Number(c[1]) : 1, unit: c[2] || '件' };
}

function validItems(items) {
  return Array.isArray(items) && items.length > 0 && items.every(i => {
    const x = typeof i === 'string' ? parseItemLine(i) : i;
    return x && String(x.name || '').trim() && Number(x.qty) > 0;
  });
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

// 校验通过后按拣货量扣减库存，避免多单合计超卖
function deductForPlan(d, plan) {
  for (const line of plan) {
    const inv = d.inventory.find(v => v.sku === line.sku);
    if (inv) inv.stock = Math.max(0, Number(inv.stock) - line.requested);
  }
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
// 订单状态机：POST /api/orders/:id/{action} 的六个动作
// 约定：动作函数返回 null 表示流转成功（数据已原位修改、审计已写），
// 返回 { status, body } 表示校验失败，由路由层原样作为 HTTP 响应。
// ---------------------------------------------------------------------------
const orderActions = {
  // 确认前可修改：仅限"待人工确认 / 异常待审核"订单
  edit(d, o, x, { audit, operator }) {
    if (!['待人工确认', '异常待审核'].includes(o.status)) return { status: 409, body: { error: '只有未确认的订单才能修改；已确认订单请先取消后重新录入' } };
    if (x.customer !== undefined && !String(x.customer || '').trim()) return { status: 400, body: { error: '客户不能为空' } };
    if (x.amount !== undefined && (Number.isNaN(Number(x.amount)) || Number(x.amount) < 0)) return { status: 400, body: { error: '订单金额必须是非负数字' } };
    if (x.items !== undefined) {
      if (!validItems(x.items)) return { status: 400, body: { error: '商品明细无效，数量必须大于0' } };
      o.items = x.items.map(i => (typeof i === 'string' ? parseItemLine(i) : i));
    }
    if (String(x.customer || '').trim()) o.customer = x.customer.trim();
    if (x.amount !== undefined) o.amount = Number(x.amount) || 0;
    o.status = '待人工确认'; // 重新匹配商品与客户
    enrich(d, o);
    audit(d, '修改订单', o.id, operator);
    return null;
  },

  // 只允许从"异常待审核"处理，防止把已确认订单打回
  resolve(d, o, x, { audit, operator }) {
    if (o.status !== '异常待审核') return { status: 409, body: { error: '只有异常待审核订单才能处理商品异常' } };
    const item = o.items.find(i => i.name === x.itemName);
    const p = (d.products || []).find(v => v.sku === x.sku);
    if (!item || !p) return { status: 400, body: { error: '商品明细或SKU不存在' } };
    item.name = p.name; item.sku = p.sku;
    o.status = '待人工确认';
    enrich(d, o);
    audit(d, '人工处理商品异常', o.id + ' ' + p.sku, operator);
    return null;
  },

  cancel(d, o, x, { audit, operator }) {
    if (['已送达', '已取消'].includes(o.status) || o.deliveryStatus === '已送达') {
      return { status: 409, body: { error: '当前订单不能取消' } };
    }
    o.status = '已取消';
    o.cancelReason = String(x.reason || '人工取消');
    audit(d, '人工取消订单', o.id + ' ' + o.cancelReason, operator);
    return null;
  },

  approve(d, o, x, { audit, operator }) {
    if (o.exceptions && o.exceptions.length) return { status: 409, body: { error: '存在未匹配商品，请先处理异常' } };
    if (o.status !== '待人工确认') return { status: 409, body: { error: '只有待人工确认订单才能确认' } };
    o.status = '已确认待速达开单';
    o.confirmedAt = new Date().toISOString();
    audit(d, '人工确认订单', o.id, operator);
    return null;
  },

  pick(d, o, x, { audit, operator }) {
    if (o.status !== '已登记速达单号') return { status: 409, body: { error: '请先完成速达单号登记' } };
    const plan = pickPlan(d, o);
    if (plan.some(i => i.shortage > 0)) {
      return { status: 409, body: { error: '库存不足，请先人工调整或采购', shortages: plan.filter(i => i.shortage > 0) } };
    }
    deductForPlan(d, plan);
    o.pickPlan = plan;
    o.pickStatus = '已生成拣货任务';
    audit(d, '生成拣货任务（已扣减库存）', o.id, operator);
    return null;
  },

  // speeda：登记外部账本单号（已移除任何 force 旁路）
  speeda(d, o, x, { audit, operator }) {
    if (o.status !== '已确认待速达开单') return { status: 409, body: { error: '请先人工确认订单' } };
    if (!String(x.speedaNo || '').trim()) return { status: 400, body: { error: '请填写速达单号' } };
    o.speedaNo = String(x.speedaNo).trim();
    o.status = '已登记速达单号';
    audit(d, '登记速达单号', o.id + ' → ' + o.speedaNo, operator);
    return null;
  },
};

module.exports = { parseItemLine, validItems, productFor, customerFor, enrich, pickPlan, deductForPlan, analytics, orderActions };
