#!/usr/bin/env node
// ----------------------------------------------------------------------------
// 新商家接入初始化脚本
//
// 用法（在项目目录执行）：
//   npm run init -- "商家简称" [外部账本简称]
//   例如：npm run init -- "恒达米业" "金蝶"
//
// 生成：
//   config/merchant-<简称>.json   商家品牌与账本配置（可再手工润色）
//   data/<简称>.json              全新的空数据文件
// 并打印对应的启动命令。之后正式使用前，把客户/商品/库存主数据填进数据文件即可。
// ----------------------------------------------------------------------------
'use strict';
const fs = require('fs');
const path = require('path');

const root = __dirname;
const name = String(process.argv[2] || '').trim();
const erpShort = String(process.argv[3] || '').trim() || '账本';
const pkg = require(path.join(root, '..', 'package.json'));

if (!name || /[\\/:*?"<>|\s]/.test(name)) {
  console.error('用法：npm run init -- "商家简称"（简称不要包含空格和路径符号）');
  process.exit(1);
}

const slug = name;
const configFile = path.join(root, '..', 'config', 'merchant-' + slug + '.json');
const dataFile = path.join(root, '..', 'data', slug + '.json');

if (fs.existsSync(configFile) || fs.existsSync(dataFile)) {
  console.error('已存在同名配置或数据文件，请先改名或删除：\n  ' + configFile + '\n  ' + dataFile);
  process.exit(1);
}

fs.writeFileSync(configFile, JSON.stringify({
  app: {
    name: name + '经营助手',
    short: name,
    tagline: '本地经营智能助手',
    eyebrow: 'LOCAL · OPS',
    header: '早上好，今天也高效出货。',
    company: '',
    footer: '● 局域网本地运行',
    footerSmall: '数据不会上传云端',
  },
  erp: { name: erpShort, short: erpShort },
}, null, 2) + '\n', 'utf8');

fs.writeFileSync(dataFile, JSON.stringify({
  customers: [],
  products: [],
  orders: [],
  inventory: [],
  vehicles: [],
  audit: [],
  appMeta: { version: pkg.version, createdAt: new Date().toISOString() },
}, null, 2) + '\n', 'utf8');

console.log('已创建：\n  ' + configFile + '\n  ' + dataFile);
console.log('\n启动命令（Windows PowerShell）：');
console.log('  $env:CONFIG_FILE="' + configFile.replace(/\\/g, '\\\\') + '"; $env:DATA_FILE="' + dataFile.replace(/\\/g, '\\\\') + '"; npm start');
console.log('\n跨 shell 通用写法：');
console.log('  CONFIG_FILE=' + configFile + ' DATA_FILE=' + dataFile + ' node server.js');
console.log('\n提示：首次启动后请到页面上补齐客户与商品主数据（或直接编辑数据文件）。');
