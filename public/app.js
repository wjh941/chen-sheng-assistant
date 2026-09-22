// ============================================================================
// 本地经营助手 · 前端逻辑（v0.7.0 多商家适配版）
// 所有动态内容均经 esc() 转义后渲染；事件统一走 data-* 委托，避免拼接 onclick。
// ============================================================================
'use strict';

let state = null;
let config = null;
let configMeta = null;

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
  const r = await fetch(url, opt);
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
  if (configMeta) {
    $('cfgVersion').textContent = 'v' + configMeta.version;
    $('cfgDataFile').textContent = configMeta.dataFile;
    $('cfgConfigFile').textContent = configMeta.configFile;
    $('cfgHost').textContent = configMeta.host + ':' + configMeta.port;
  }
}

// ---------- 订单渲染（纯文本插值全部转义；操作按钮走 data-action 委托） ----------
function renderOrders(id, orders) {
  const q = ($('search')?.value || '').trim().toLowerCase();
  const rows = orders.filter(o => !q || [o.id, o.customer, o.source, disp(o.status)].join(' ').toLowerCase().includes(q));
  $(id).innerHTML = rows.map(o => {
    const unknown = o.matching && o.matching.find(i => !i.matched);
    const btn = (action, label, extra) => ` <button class="link" data-action="${action}" data-id="${esc(o.id)}"${extra || ''}>${label}</button>`;
    let actions = '';
    if (o.status === '待人工确认') actions += btn('approve', '确认');
    if (o.status === '异常待审核' && unknown) actions += btn('resolve', '处理异常', ` data-item="${esc(unknown.name)}"`);
    if (o.status === '已确认待速达开单') actions += btn('speeda', '登记' + esc(disp('速达')) + '单号');
    if (o.status === '已登记速达单号' && !o.pickStatus) actions += btn('pick', '生成拣货');
    if (o.pickStatus) actions += ' <small>已生成拣货</small>';
    if (o.status === '已登记速达单号') {
      const cur = esc(o.deliveryStatus || '未安排');
      actions += ` <select class="status-select" data-role="delivery" data-id="${esc(o.id)}"><option value="">配送状态（${cur}）</option><option>待配送</option><option>配送中</option><option>已送达</option></select>`;
    }
    if (!['已送达', '已取消'].includes(o.status) && o.deliveryStatus !== '已送达') actions += btn('cancel', '取消');
    const newCustomer = o.customerMatched === false ? ' <span class="tag gray">新客户</span>' : '';
    return `<div class="order"><b>${esc(o.customer)}</b>${newCustomer}<span>${esc(o.id)}<br>${esc(o.source)} · ${(o.items || []).length}项</span><strong>${money(o.amount)}</strong><span><span class="tag">${esc(disp(o.status))}</span>${actions}</span></div>`;
  }).join('') || '<p class="muted">没有匹配的订单 / No orders found</p>';
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
      `<div class="audit"><b>${esc(a2.action)}</b><span>${esc(a2.detail)}</span><small>${new Date(a2.time).toLocaleString()}</small></div>`).join('');
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
    let content = $('items').value, filename = $('source').value;
    if (f) { content = await f.text(); filename = f.name; }
    const x = await api(f ? '/api/import' : '/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer: $('customer').value, source: $('source').value, amount: $('amount').value, items: content.split('\n').filter(Boolean), content, filename }),
    });
    closeImport();
    await load(true);
    show('orders');
    alert(`已登记 ${x.id}，等待人工确认。`);
  } catch (e) { alert(e.message); }
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

// ---------- 事件绑定（委托，替代拼接 onclick） ----------
async function onAction(b) {
  const { action, id, item, sku, name, vehicle } = b.dataset;
  try {
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
