// ============================================================================
// 本地经营助手 · 前端逻辑（v0.7.0 多商家适配版）
// 所有动态内容均经 esc() 转义后渲染；事件统一走 data-* 委托，避免拼接 onclick。
// ============================================================================
'use strict';

let state = null;
let config = null;
let configMeta = null;
let statusFilter = '';
const PAGE_SIZE = 50;
const pageLimit = {};

// ---------- 小工具 ----------
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '¥' + Number(n || 0).toLocaleString('zh-CN');

// 界面文案里的"速达"按商家配置动态替换（数据库里存的状态名保持标准不变）
function disp(s) {
  const short = config && config.erp && config.erp.short;
  return short && short !== '速达' ? String(s ?? '').split('速达').join(short) : String(s ?? '');
}

async function api(url, opt) {
  opt = opt || {};
  opt.headers = Object.assign({ 'X-Operator': encodeURIComponent(localStorage.getItem('ops_operator') || '') }, opt.headers || {});
  const r = await fetch(url, opt);
  if (r.status === 401) { location.href = '/login'; throw Error('请先登录'); }
  let x;
  try { x = await r.json(); } catch { x = { error: '服务器返回无效内容' }; }
  if (!r.ok) throw Error(x.error || '操作失败');
  return x;
}

// ---------- 路由 ----------
function route() {
  const id = location.hash.replace('#', '') || 'overview';
  const page = $(id) || $('overview');
  document.querySelectorAll('.page').forEach(x => x.classList.add('hidden'));
  page.classList.remove('hidden');
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + page.id));
}
function show(id) { location.hash = id; route(); }

// ---------- 商家配置渲染 ----------
function applyConfig() {
  if (!config) return;
  document.title = config.app.name;
  const mark = $('brandMark'); if (mark) mark.textContent = String(config.app.short || '').replace(/[\s·]/g, '').slice(0, 2) || 'CS';
  $('brandName').textContent = config.app.short;
  $('brandTagline').textContent = config.app.tagline;
  $('eyebrow').textContent = config.app.eyebrow;
  $('headerTitle').textContent = config.app.header;
  $('companyLine').textContent = config.app.company;
  $('footerNote').textContent = config.app.footer;
  $('footerSmall').textContent = config.app.footerSmall;
  document.querySelectorAll('[data-erp-name]').forEach(el => { el.textContent = config.erp.name; });
  document.querySelectorAll('[data-erp-short]').forEach(el => { el.textContent = config.erp.short; });
  const sel = $('statusFilter');
  if (sel) {
    const statuses = ['待人工确认', '异常待审核', '已确认待速达开单', '已登记速达单号', '已取消'];
    sel.innerHTML = '<option value="">全部状态</option>' + statuses.map(s => `<option value="${esc(s)}"${s === statusFilter ? ' selected' : ''}>${esc(disp(s))}</option>`).join('');
  }
  if (configMeta) {
    $('cfgVersion').textContent = 'v' + configMeta.version;
    $('cfgDataFile').textContent = configMeta.dataFile;
    $('cfgConfigFile').textContent = configMeta.configFile;
    $('cfgHost').textContent = configMeta.host + ':' + configMeta.port;
  }
}

// ---------- 订单渲染（纯文本插值全部转义；操作按钮走 data-action 委托） ----------
function renderOrders(id, orders, applyFilter) {
  let rows = orders;
  if (applyFilter !== false && statusFilter) rows = rows.filter(o => o.status === statusFilter);
  const q = ($('search')?.value || '').trim().toLowerCase();
  if (q) rows = rows.filter(o => [o.id, o.customer, o.source, disp(o.status)].join(' ').toLowerCase().includes(q));
  const limit = pageLimit[id] || PAGE_SIZE;
  const shown = rows.slice(0, limit);
  $(id).innerHTML = shown.map(o => {
    const unknown = o.matching && o.matching.find(i => !i.matched);
    const btn = (action, label, extra) => ` <button class="link" data-action="${action}" data-id="${esc(o.id)}"${extra || ''}>${label}</button>`;
    let actions = '';
    if (['待人工确认', '异常待审核'].includes(o.status)) actions += btn('edit', '编辑');
    if (o.status === '待人工确认') actions += btn('approve', '确认');
    if (o.status === '异常待审核' && unknown) actions += btn('resolve', '处理异常', ` data-item="${esc(unknown.name)}"`);
    if (o.status === '已确认待速达开单') actions += btn('speeda', '登记' + esc(disp('速达')) + '单号');
    if (o.status === '已登记速达单号' && !o.pickStatus) actions += btn('pick', '生成拣货');
    if (o.pickStatus) actions += ' <small>已生成拣货</small>' + btn('printpick', '打印拣货单');
    if (o.status === '已登记速达单号' && ['待配送', '配送中'].includes(o.deliveryStatus)) actions += btn('printdelivery', '打印送货单');
    if (o.status === '已登记速达单号') {
      const cur = esc(o.deliveryStatus || '未安排');
      actions += ` <select class="status-select" data-role="delivery" data-id="${esc(o.id)}"><option value="">配送状态（${cur}）</option><option>待配送</option><option>配送中</option><option>已送达</option></select>`;
    }
    if (!['已送达', '已取消'].includes(o.status) && o.deliveryStatus !== '已送达') actions += btn('cancel', '取消');
    const newCustomer = o.customerMatched === false ? ' <span class="tag gray">新客户</span>' : '';
    return `<div class="order"><b>${esc(o.customer)}</b>${newCustomer}<span>${esc(o.id)}<br>${esc(o.source)} · ${(o.items || []).length}项</span><strong>${money(o.amount)}</strong><span><span class="tag">${esc(disp(o.status))}</span>${actions}</span></div>`;
  }).join('') || '<p class="muted">没有匹配的订单 / No orders found</p>'
    + (rows.length > shown.length ? `<p class="muted">已显示 ${shown.length} / ${rows.length} <button class="link" data-action="showall" data-target="${esc(id)}">显示全部</button></p>` : '');
}

// ---------- 数据加载 ----------
async function load(silent) {
  try {
    state = await api('/api/overview');
    if (!config) { config = state.config; applyConfig(); }
    const a = state.analytics || {};
    $('today').textContent = money(a.todaySales);
    $('month').textContent = money(a.monthSales);
    $('profit').textContent = money(a.monthProfit);
    $('pending').textContent = a.pending ?? 0;
    $('aSales').textContent = money(a.monthSales);
    $('aCost').textContent = money(a.monthCost);
    $('aProfit').textContent = money(a.monthProfit);
    renderOrders('ordersList', state.orders.slice(0, 4));
    renderOrders('allOrders', state.orders);
    $('stockList').innerHTML = state.inventory.map(x =>
      `<div class="stock"><span>${esc(x.name)}</span><b class="${Number(x.stock) < Number(x.safe) ? 'low' : ''}">${x.stock}${esc(x.unit)} / 安全 ${x.safe}</b></div>`).join('');
    $('warehouseList').innerHTML = state.inventory.map(x =>
      `<div class="task"><b>${esc(x.name)}</b><p>现有 ${x.stock}${esc(x.unit)} · 建议补货 ${Math.max(0, x.safe * 2 - x.stock)}${esc(x.unit)}</p><span class="tag">${Number(x.stock) < Number(x.safe) ? '低库存建议' : '库存正常'}</span> <button class="link" data-action="adjust" data-sku="${esc(x.sku)}" data-name="${esc(x.name)}">库存调整</button></div>`).join('');
    $('vehicleList').innerHTML = state.vehicles.map(v =>
      `<div class="vehicle"><b>${esc(v.name)}</b><p>载重 ${esc(v.capacity)}　路线：${esc(v.route)}</p><span class="tag">${esc(v.load)}</span> <button class="link" data-action="dispatch" data-vehicle="${esc(v.name)}">人工安排</button></div>`).join('');
    $('auditList').innerHTML = (state.audit || []).slice(0, 12).map(a2 =>
      `<div class="audit"><b>${esc(a2.action)}</b><span>${esc(a2.detail)}</span><small>${esc(a2.operator || '')}${a2.operator ? ' · ' : ''}${new Date(a2.time).toLocaleString()}</small></div>`).join('');
    renderMaster();
    document.title = (a.pending > 0 ? `(${a.pending}) ` : '') + (config ? config.app.name : '本地经营助手');
    route();
  } catch (e) {
    console.error(e);
    if (!silent) alert('加载失败：' + e.message);
  }
}

// 30 秒静默自动刷新：后台标签页、打开的弹窗、正在输入时不打扰
function autoRefresh() {
  if (document.visibilityState !== 'visible') return;
  if (document.querySelector('dialog[open]')) return;
  const a = document.activeElement;
  if (a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName)) return;
  load(true);
}

// ---------- 导入订单弹窗 ----------
function resetImport() { $('customer').value = ''; $('amount').value = ''; $('items').value = ''; $('file').value = ''; $('source').value = '微信文字'; }
function openImport() { resetImport(); $('import').showModal(); }
function closeImport() { const dialog = $('import'); if (dialog.open) dialog.close(); resetImport(); }

async function submitOrder() {
  try {
    const f = $('file').files[0];
    const base = { customer: $('customer').value, source: $('source').value, amount: $('amount').value };
    let url, payload;
    if (f && /\.xlsx$/i.test(f.name)) {
      // Excel：转 base64 交给服务端解析第一个工作表
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      url = '/api/import';
      payload = { ...base, filename: f.name, contentBase64: btoa(bin) };
    } else if (f) {
      const content = await f.text();
      url = '/api/import';
      payload = { ...base, content, filename: f.name };
    } else {
      url = '/api/orders';
      payload = { ...base, items: $('items').value.split('\n').filter(Boolean) };
    }
    const x = await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    closeImport();
    await load(true);
    show('orders');
    alert(`已登记 ${x.id}，等待人工确认。`);
  } catch (e) { alert(e.message); }
}

// ---------- 订单编辑弹窗（确认前可改） ----------
function openEdit(id) {
  const o = (state.orders || []).find(x => x.id === id);
  if (!o) return;
  $('editId').value = o.id;
  $('editCustomer').value = o.customer;
  $('editAmount').value = o.amount ?? '';
  $('editItems').value = (o.items || []).map(i => [i.name, i.qty, i.unit || '件'].join(',')).join('\n');
  $('edit').showModal();
}
async function submitEdit(e) {
  e.preventDefault();
  try {
    await api('/api/orders/' + encodeURIComponent($('editId').value) + '/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer: $('editCustomer').value, amount: $('editAmount').value, items: $('editItems').value.split('\n').map(v => v.trim()).filter(Boolean) }),
    });
    $('edit').close();
    await load(true);
  } catch (err) { alert(err.message); }
}

// ---------- 拣货单打印 ----------
function printPick(id) {
  const o = (state.orders || []).find(x => x.id === id);
  if (!o) return;
  const lines = (o.pickPlan || o.matching || o.items || []).map(i =>
    `<tr><td>${esc(i.sku || '')}</td><td>${esc(i.name)}</td><td>${esc(i.requested ?? i.qty ?? '')}</td><td>${esc(i.unit || '')}</td><td></td></tr>`).join('');
  $('printArea').innerHTML =
    `<h2>${esc(config ? config.app.short : '')} · 拣货单</h2>` +
    `<p>订单：${esc(o.id)}　客户：${esc(o.customer)}<br>打印时间：${new Date().toLocaleString()}</p>` +
    `<table><thead><tr><th>SKU</th><th>商品</th><th>数量</th><th>单位</th><th>勾选</th></tr></thead><tbody>${lines}</tbody></table>` +
    `<p class="sign">拣货人签字：＿＿＿＿＿＿　　复核签字：＿＿＿＿＿＿</p>`;
  window.print();
}

// ---------- 库存调整弹窗 ----------
function openAdjust(sku, name) {
  $('adjustSku').value = sku;
  $('adjustName').textContent = name + '（' + sku + '）';
  $('adjustType').value = 'in';
  $('adjustQty').value = '';
  $('adjustReason').value = '';
  $('adjust').showModal();
}
async function submitAdjust(e) {
  e.preventDefault();
  try {
    await api('/api/inventory/adjust', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: $('adjustSku').value, type: $('adjustType').value, qty: Number($('adjustQty').value), reason: $('adjustReason').value.trim() }),
    });
    $('adjust').close();
    await load(true);
  } catch (err) { alert(err.message); }
}

// ---------- 基础数据管理（商品 / 客户 / 车辆） ----------
function renderMaster() {
  if (!state) return;
  const invBySku = {};
  (state.inventory || []).forEach(v => { invBySku[v.sku] = v; });
  $('productList').innerHTML = (state.products || []).map(p => {
    const inv = invBySku[p.sku];
    return `<div class="task"><b>${esc(p.name)}</b> <span class="tag">${esc(p.sku)}</span><p>别名：${esc((p.aliases || []).join('、') || '—')}　成本：${inv ? money(inv.cost) : '—'}　库存：${inv ? `${inv.stock}${esc(inv.unit)} / 安全 ${inv.safe}` : '未建库存'}</p><span><button class="link" data-action="editProduct" data-sku="${esc(p.sku)}">编辑</button> <button class="link" data-action="delProduct" data-sku="${esc(p.sku)}">删除</button></span></div>`;
  }).join('') || '<p class="muted">还没有商品，点右上角"添加商品"开始建主数据</p>';
  $('customerList').innerHTML = (state.customers || []).map(c =>
    `<div class="task"><b>${esc(c.name)}</b><p>别名：${esc((c.aliases || []).join('、') || '—')}</p><span><button class="link" data-action="editCustomer" data-id="${esc(c.id || '')}" data-name="${esc(c.name)}">编辑</button> <button class="link" data-action="delCustomer" data-id="${esc(c.id || '')}" data-name="${esc(c.name)}">删除</button></span></div>`).join('') || '<p class="muted">还没有客户</p>';
  $('vehicleMasterList').innerHTML = (state.vehicles || []).map(v =>
    `<div class="task"><b>${esc(v.name)}</b><p>载重：${esc(v.capacity || '—')}　路线：${esc(v.route || '—')}</p><span><button class="link" data-action="editVehicle" data-name="${esc(v.name)}">编辑</button> <button class="link" data-action="delVehicle" data-name="${esc(v.name)}">删除</button></span></div>`).join('') || '<p class="muted">还没有车辆</p>';
}

function openProductDlg(p) {
  $('dlgProductTitle').textContent = p ? '编辑商品' : '添加商品';
  $('pdMode').value = p ? 'edit' : 'add';
  $('pdSku').value = p ? p.sku : '';
  $('pdSku').disabled = !!p;
  $('pdName').value = p ? p.name : '';
  $('pdAliases').value = p ? (p.aliases || []).join(',') : '';
  const inv = p ? (state.inventory || []).find(v => v.sku === p.sku) : null;
  $('pdUnit').value = inv ? inv.unit : '件';
  $('pdCost').value = inv ? inv.cost : '';
  $('pdSafe').value = inv ? inv.safe : '';
  $('pdStock').value = inv ? inv.stock : '';
  $('dlgProduct').showModal();
}

async function submitProduct(e) {
  e.preventDefault();
  try {
    const mode = $('pdMode').value;
    await api('/api/products/' + (mode === 'add' ? 'add' : 'update'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sku: $('pdSku').value, name: $('pdName').value, aliases: $('pdAliases').value,
        unit: $('pdUnit').value, cost: $('pdCost').value, safe: $('pdSafe').value, stock: $('pdStock').value,
      }),
    });
    $('dlgProduct').close();
    await load(true);
  } catch (err) { alert(err.message); }
}

function openCustomerDlg(c) {
  $('dlgCustomerTitle').textContent = c ? '编辑客户' : '添加客户';
  $('cdMode').value = c ? 'edit' : 'add';
  $('cdKey').value = c ? (c.id || c.name) : '';
  $('cdName').value = c ? c.name : '';
  $('cdAliases').value = c ? (c.aliases || []).join(',') : '';
  $('dlgCustomer').showModal();
}

async function submitCustomer(e) {
  e.preventDefault();
  try {
    const mode = $('cdMode').value;
    const payload = { name: $('cdName').value, aliases: $('cdAliases').value };
    if (mode === 'edit') payload.id = $('cdKey').value;
    await api('/api/customers/' + (mode === 'add' ? 'add' : 'update'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    $('dlgCustomer').close();
    await load(true);
  } catch (err) { alert(err.message); }
}

function openVehicleDlg(v) {
  $('dlgVehicleTitle').textContent = v ? '编辑车辆' : '添加车辆';
  $('vdMode').value = v ? 'edit' : 'add';
  $('vdKey').value = v ? v.name : '';
  $('vdName').value = v ? v.name : '';
  $('vdCapacity').value = v ? (v.capacity || '') : '';
  $('vdRoute').value = v ? (v.route || '') : '';
  $('dlgVehicle').showModal();
}

async function submitVehicle(e) {
  e.preventDefault();
  try {
    const mode = $('vdMode').value;
    const body = { name: $('vdName').value, capacity: $('vdCapacity').value, route: $('vdRoute').value };
    const url = mode === 'add' ? '/api/vehicles/add' : '/api/vehicles/update';
    if (mode === 'edit') body.newName = body.name, body.name = $('vdKey').value;
    await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    $('dlgVehicle').close();
    await load(true);
  } catch (err) { alert(err.message); }
}

// ---------- 送货单打印 ----------
function printDelivery(id) {
  const o = (state.orders || []).find(x => x.id === id);
  if (!o) return;
  const lines = (o.matching || o.items || []).map(i =>
    `<tr><td>${esc(i.name)}</td><td>${esc(i.qty)}</td><td>${esc(i.unit || '')}</td></tr>`).join('');
  const head = config ? (config.app.company || config.app.short) : '';
  $('printArea').innerHTML =
    `<h2>${esc(head)} · 送货单</h2>` +
    `<p>客户：${esc(o.customer)}　订单：${esc(o.id)}${o.speedaNo ? '　账单号：' + esc(o.speedaNo) : ''}<br>打印时间：${new Date().toLocaleString()}</p>` +
    `<table><thead><tr><th>商品</th><th>数量</th><th>单位</th></tr></thead><tbody>${lines}</tbody></table>` +
    `<p>合计金额：${money(o.amount)}</p><p class="sign">收货人签字：＿＿＿＿＿＿　　送货人签字：＿＿＿＿＿＿</p>`;
  window.print();
}

// ---------- 事件绑定（委托，替代拼接 onclick） ----------
async function onAction(b) {
  const { action, id, item, sku, name, vehicle, target } = b.dataset;
  try {
    if (action === 'edit') { openEdit(id); return; }
    if (action === 'printpick') { printPick(id); return; }
    if (action === 'printdelivery') { printDelivery(id); return; }
    if (action === 'showall') { pageLimit[target] = Infinity; load(true); return; }
    if (action === 'editProduct') {
      openProductDlg(sku ? (state.products || []).find(x => x.sku === sku) : null);
      return;
    }
    if (action === 'delProduct') {
      if (!confirm('删除商品 ' + sku + ' ？')) return;
      try {
        await api('/api/products/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sku }) });
      } catch (err) {
        if (err.message.includes('级联') && confirm('该商品存在库存条目，连同库存一起删除？')) {
          await api('/api/products/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sku, cascade: true }) });
        } else { alert(err.message); return; }
      }
      await load(true);
      return;
    }
    if (action === 'editCustomer') {
      const key = id || name;
      openCustomerDlg((state.customers || []).find(c => c.id === key || c.name === key));
      return;
    }
    if (action === 'delCustomer') {
      const c = (state.customers || []).find(c => c.id === (id || name) || c.name === name);
      if (c && confirm('删除客户 ' + c.name + ' ？')) {
        await api('/api/customers/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: c.id, name: c.name }) });
        await load(true);
      }
      return;
    }
    if (action === 'editVehicle') {
      openVehicleDlg((state.vehicles || []).find(v => v.name === name));
      return;
    }
    if (action === 'delVehicle') {
      if (confirm('删除车辆 ' + name + ' ？')) {
        await api('/api/vehicles/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        await load(true);
      }
      return;
    }
    if (action === 'approve') {
      if (!confirm('确认已人工核对客户、商品、数量和价格？')) return;
      await api('/api/orders/' + encodeURIComponent(id) + '/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    } else if (action === 'resolve') {
      const skuIn = prompt('请输入人工确认的商品SKU：');
      if (!skuIn) return;
      await api('/api/orders/' + encodeURIComponent(id) + '/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemName: item, sku: skuIn.trim() }) });
    } else if (action === 'speeda') {
      const n = prompt('请输入' + disp('速达') + '人工开单后的单号：');
      if (!n) return;
      await api('/api/orders/' + encodeURIComponent(id) + '/speeda', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speedaNo: n.trim() }) });
    } else if (action === 'pick') {
      await api('/api/orders/' + encodeURIComponent(id) + '/pick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      alert('拣货任务已生成，库存已按拣货量扣减。');
    } else if (action === 'cancel') {
      const reason = prompt('请输入取消原因：');
      if (reason && confirm('确认人工取消此订单？')) {
        await api('/api/orders/' + encodeURIComponent(id) + '/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
      } else return;
    } else if (action === 'dispatch') {
      const routeText = prompt('请输入人工确认路线：');
      if (!routeText) return;
      await api('/api/dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vehicle, route: routeText.trim() }) });
    } else if (action === 'adjust') {
      openAdjust(sku, name);
      return;
    }
    await load(true);
  } catch (e) { alert(e.message); }
}

function bindEvents() {
  document.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) { e.target.closest('dialog').close(); return; }
    const b = e.target.closest('[data-action]');
    if (b) onAction(b);
  });
  document.addEventListener('change', async e => {
    const sel = e.target.closest('select[data-role="delivery"]');
    if (!sel || !sel.value) return;
    try {
      await api('/api/delivery/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: sel.dataset.id, status: sel.value }) });
      await load(true);
    } catch (err) { alert(err.message); await load(true); }
  });
  const dialog = $('import');
  dialog.addEventListener('click', e => { if (e.target === dialog) closeImport(); });
  dialog.addEventListener('cancel', e => { e.preventDefault(); closeImport(); });
  $('importForm').addEventListener('submit', e => { e.preventDefault(); submitOrder(); });
  const ad = $('adjust');
  ad.addEventListener('click', e => { if (e.target === ad) ad.close(); });
  $('adjustForm').addEventListener('submit', submitAdjust);
  const ed = $('edit');
  ed.addEventListener('click', e => { if (e.target === ed) ed.close(); });
  $('editForm').addEventListener('submit', submitEdit);
  for (const [dlgId, formId, handler] of [
    ['dlgProduct', 'dlgProductForm', submitProduct],
    ['dlgCustomer', 'dlgCustomerForm', submitCustomer],
    ['dlgVehicle', 'dlgVehicleForm', submitVehicle],
  ]) {
    const dlg = $(dlgId);
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    $(formId).addEventListener('submit', handler);
  }
  $('statusFilter').addEventListener('change', e => {
    statusFilter = e.target.value;
    renderOrders('ordersList', state.orders.slice(0, 4), false);
    renderOrders('allOrders', state.orders);
  });
  const op = $('operatorName');
  op.value = localStorage.getItem('ops_operator') || '';
  op.addEventListener('change', () => { localStorage.setItem('ops_operator', op.value.trim()); });
  $('btnRefresh').addEventListener('click', () => load(true));
}

// ---------- 启动 ----------
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const c = await api('/api/config');
    config = c.config; configMeta = c.meta;
  } catch (e) { console.warn('配置加载失败，使用页面默认文案', e); }
  applyConfig();
  bindEvents();
  load();
  setInterval(autoRefresh, 30000);
});
