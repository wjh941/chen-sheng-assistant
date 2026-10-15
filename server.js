// ============================================================================
// 本地经营助手 · 本地服务（v0.7.0 多商家适配版）—— 入口薄壳
//
// 设计原则：
//   1. 零第三方依赖，Node.js >= 18 直接运行；
//   2. 数据只落本机 JSON 文件，原子写入，不连任何云端；
//   3. 对外部账本（默认速达，可配置为任何 ERP/手工账本）只做"人工登记单号"，
//      不直接连接、不修改账本数据库；
//   4. 商家品牌 / 外部账本名称等全部在 config/merchant.json 配置，
//      换一家商家 = 换一份配置 + 换一份数据文件，代码不用改。
//
// 本文件只负责"启动与组装"：读取环境变量 → 创建 store / auth → 组装路由 →
// 启动 http server 与进程级兜底。各层职责：
//   lib/store.js      数据层（商家配置 + 原子读写 + 每日备份 + 审计）
//   lib/orders.js     订单业务层（状态机 + 匹配/拣货/经营分析等纯函数）
//   lib/router.js     路由分发（按资源分组的请求处理器，route() 只保留分发）
//   lib/http-utils.js 请求层工具（send/安全头/body 解析/同源校验/操作员标识）
//   lib/auth.js       鉴权（会话签名 Cookie + 登录失败限速）
//   lib/xlsx.js       零依赖 xlsx 读写（本次未拆动）
// ============================================================================
'use strict';

const http = require('http');
const path = require('path');
const { send } = require('./lib/http-utils');
const { createStore } = require('./lib/store');
const { createAuth } = require('./lib/auth');
const { createRouter } = require('./lib/router');

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

// 鉴权实例：会话签名密钥与登录限速计数都在实例内（进程内存，重启即清零）。
// 窗口/阈值/锁定时长可用环境变量覆盖（测试用它缩短等待，默认生产值不变）。
const auth = createAuth({
  accessToken: ACCESS_TOKEN,
  rateWindowMs: Number(process.env.LOGIN_RATE_WINDOW_MS) || 60 * 1000,  // 失败计数窗口：60 秒
  rateMaxFails: Number(process.env.LOGIN_RATE_MAX_FAILS) || 5,          // 窗口内允许失败次数
  rateLockMs: Number(process.env.LOGIN_RATE_LOCK_MS) || 5 * 60 * 1000,  // 达上限后锁定：5 分钟
});

// 路由分发器：依赖显式注入；getListenPort 延迟到请求期求值（取 PORT=0 随机端口的实际值）
const route = createRouter({
  store, auth,
  appVersion: APP_VERSION, host: HOST,
  dataFile: DATA_FILE, configFile: CONFIG_FILE,
  publicDir: path.join(root, 'public'),
  getListenPort: () => (server.address() ? server.address().port : PORT),
});

const server = http.createServer((req, res) => {
  try {
    route(req, res);
  } catch (e) {
    console.error('[error]', req.method, req.url, e);
    send(res, 500, { error: '服务器内部错误：' + e.message });
  }
});

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
