# 晨升·盈泰本地经营智能助手 / Chen-Sheng & Ying-Tai Local Business Assistant

> 面向东莞市晨升膳食管理有限公司与高埗盈泰副食贸易的本地经营工作台。  
> A local operations workspace for Dongguan Chensheng Catering Management Co., Ltd. and Gaobu Yingtai Food Trading.

## 项目定位 / Project scope

本项目服务于零售、批发、学校食堂和工厂食堂场景，帮助夫妻店减少微信订单、Excel订单、库存和配送方面的重复人工工作。  
This project supports retail, wholesale, school canteens and factory canteens, reducing repetitive work around WeChat orders, spreadsheets, inventory and delivery.

**核心原则 / Core principles**

- 本地部署，企业数据不上传外部云端。 / On-premises deployment; business data is not uploaded to external cloud services.
- 速达 5000.Online-Pro 4.00 继续作为正式业务账本。 / Sudat 5000.Online-Pro 4.00 remains the official accounting ledger.
- 第一阶段不连接、不读取、不修改速达数据库。 / Phase 1 does not connect to, read or modify the Sudat database.
- AI/系统只做整理建议；客户、商品、数量、价格、路线等重要变更必须人工确认。 / The assistant only prepares suggestions; important changes require human confirmation.

## ## v0.3 升级 / v0.3 upgrade

- 本地客户与商品主数据及别名匹配。 / Local customer and product master data with aliases.
- 未匹配商品自动进入异常待审核，异常订单不能直接确认。 / Unmatched products become review exceptions and block approval.
- 速达单号登记后才能生成拣货任务。 / Picking tasks require a recorded Sudat number.
- 配送状态接口支持未安排、待配送、配送中、已送达。 / Delivery status API supports planned, pending, in transit and delivered.
- 增加 `/api/catalog`、`/api/delivery/status` 接口。 / Added catalog and delivery-status APIs.

## 当前能力 / Current capabilities

- 经营总览：销售额、成本、毛利、待处理事项。 / Dashboard: sales, cost, profit and pending work.
- 订单登记：微信文字、微信截图、商品图片来源登记。 / Order registration from WeChat text, screenshots and product images.
- CSV/Excel导出文本导入：按“商品,数量,单位”解析并进入审核队列。 / CSV or spreadsheet-export text import using `product,quantity,unit`.
- 订单审核：人工确认前不能登记速达单号。 / Order approval; a Sudat number cannot be registered before approval.
- 库存预警与补货建议。 / Low-stock alerts and replenishment suggestions.
- 仓库拣货建议。 / Warehouse picking suggestions.
- 两辆车配送路线人工安排。 / Manual dispatch planning for the two vehicles.
- 速达人工开单后的单号登记。 / Recording the Sudat document number after manual entry.
- 操作审计记录。 / Local operation audit trail.

## 安装与运行 / Install and run

要求 Node.js 18 或更高版本。项目无第三方运行依赖。  
Requires Node.js 18 or newer. There are no runtime third-party dependencies.

```powershell
cd D:\local-ai\chen-sheng-assistant
npm start
```

打开 / Open: `http://localhost:3088`

局域网访问 / LAN access:

```text
http://<本机局域网IP>:3088
http://<LAN-IP-of-host>:3088
```

服务默认监听 `0.0.0.0`。如局域网无法访问，请在主机防火墙放行 TCP 3088。  
The server listens on `0.0.0.0`; allow TCP port 3088 in the host firewall if needed.

## 数据与安全 / Data and safety

演示/本地数据保存在 `data/demo.json`，不调用外部网络服务。生产使用前应备份该文件，并规划迁移到本地 SQLite。  
Demo/local data is stored in `data/demo.json` and no external network service is called. Back up this file before production use; migrate to local SQLite as a future hardening step.

推荐业务流程 / Recommended workflow:

1. 导入微信内容或Excel/CSV导出文本。 / Import WeChat content or spreadsheet-export text.
2. 检查客户、商品、数量、单位和金额。 / Check customer, product, quantity, unit and amount.
3. 点击人工确认。 / Click human approval.
4. 在速达局域网客户端人工开单。 / Manually create the order in the Sudat LAN client.
5. 将速达单号登记回本助手。 / Record the Sudat document number in this assistant.

本项目不是速达官方插件，也不会绕过速达权限或直接操作生产数据库。  
This project is not an official Sudat plugin and does not bypass Sudat permissions or directly manipulate the production database.

## API / 接口

- `GET /api/overview` — 获取总览、订单、库存、车辆和审计记录 / dashboard data
- `GET /api/health` — 本地健康检查 / local health check
- `POST /api/orders` — 创建待人工确认订单 / create pending order
- `POST /api/import` — 导入CSV/制表符文本 / import CSV or tab-delimited text
- `POST /api/orders/:id/approve` — 人工确认订单 / approve order
- `POST /api/orders/:id/speeda` — 登记速达单号 / record Sudat number
- `POST /api/dispatch` — 人工安排车辆路线 / manually assign vehicle route
- `GET /api/catalog` — 客户和商品主数据 / customer and product catalog
- `POST /api/orders/:id/pick` — 生成拣货任务 / create picking task
- `POST /api/delivery/status` — 更新配送状态 / update delivery status

## 测试 / Tests

```powershell
npm test
node --check server.js
node --check public/app.js
```

## GitHub / 代码仓库

[https://github.com/wjh941/chen-sheng-assistant](https://github.com/wjh941/chen-sheng-assistant)

## 后续路线 / Roadmap

本地 SQLite、客户和商品主数据匹配、真正的 `.xlsx` 解析、本地 OCR、审核差异对比、拣货单打印、配送状态追踪、角色权限和更完整审计日志。  
Local SQLite, customer/product master-data matching, native `.xlsx` parsing, on-device OCR, approval diffing, picking-list printing, delivery tracking, role permissions and a stronger audit log.
