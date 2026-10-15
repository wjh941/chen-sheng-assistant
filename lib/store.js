// ============================================================================
// 数据层：商家配置 + 本地 JSON 数据的读写、备份与审计
//
// 职责：
//   1. 商家配置：DEFAULT_CONFIG 默认值 + config/merchant.json 覆盖（允许只写
//      部分字段），基于文件 mtime 的进程内缓存；
//   2. 数据文件：临时文件 + 原子替换写入；基于 mtime 的内存缓存；文件缺失自动
//      播种空库；文件损坏时抛错（由 HTTP 层兜底转 500，进程不退出）；
//   3. 每日滚动备份：每天第一次写入前快照到 backups/，保留最近 14 份；
//   4. 审计追加与截断（500 条上限）；
//   5. ID 生成器（订单号与审计条目共用毫秒内序号，防同毫秒撞号）。
//
// 依赖显式传入：createStore({ dataFile, configFile, appVersion })，不搞全局单例；
// 每请求内 read-modify-save 全同步无 await（Node 单线程天然串行，无需加锁）。
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

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

function createStore({ dataFile, configFile, appVersion }) {
  // ---- 配置层：基于 mtime 的进程内缓存 -------------------------------------
  let configCache = null, configMtime = 0;
  function readConfig() {
    try {
      const stat = fs.statSync(configFile);
      if (configCache && stat.mtimeMs === configMtime) return configCache;
      const merged = deepMerge(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(configFile, 'utf8')));
      configCache = merged; configMtime = stat.mtimeMs;
      return merged;
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[config] 配置文件读取失败，使用默认配置：' + e.message);
      return deepMerge(DEFAULT_CONFIG, {});
    }
  }

  // ---- 数据层：基于 mtime 的进程内缓存 + 原子写 -----------------------------
  function emptyData() {
    return {
      customers: [], products: [], orders: [], inventory: [], vehicles: [], audit: [],
      appMeta: { version: appVersion, createdAt: new Date().toISOString() },
    };
  }

  let cache = null, cacheMtime = 0;
  function read() {
    let stat;
    try {
      stat = fs.statSync(dataFile);
    } catch (e) {
      if (e.code === 'ENOENT') { save(emptyData()); return structuredClone(cache); }
      throw e;
    }
    if (cache && stat.mtimeMs === cacheMtime) return structuredClone(cache);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    } catch (e) {
      throw new Error('数据文件不是有效的 JSON（' + dataFile + '），请先备份并修复该文件');
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
    if (lastBackupDay === today || !fs.existsSync(dataFile)) return;
    try {
      const dir = path.join(path.dirname(dataFile), 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const base = path.basename(dataFile).replace(/\.json$/i, '');
      fs.copyFileSync(dataFile, path.join(dir, base + '-' + today.replaceAll('-', '') + '.json'));
      const files = fs.readdirSync(dir).filter(f => f.startsWith(base + '-') && f.endsWith('.json')).sort().reverse();
      for (const f of files.slice(14)) fs.unlinkSync(path.join(dir, f));
      lastBackupDay = today;
    } catch (e) {
      console.warn('[backup] 每日备份失败（不影响主流程）：' + e.message);
    }
  }

  function save(d) {
    backupDaily();
    d.appMeta = Object.assign({}, d.appMeta, { version: appVersion });
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n');
    fs.renameSync(tmp, dataFile);
    cache = structuredClone(d);
    cacheMtime = fs.statSync(dataFile).mtimeMs;
  }

  // ---- ID 生成与审计 -------------------------------------------------------
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

  return { readConfig, read, save, newId, audit };
}

module.exports = { createStore };
