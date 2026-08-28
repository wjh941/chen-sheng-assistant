# 晨升·盈泰本地经营智能助手（第一阶段）

适配东莞市晨升膳食管理有限公司、高埗盈泰副食贸易的独立本地项目。当前为零依赖可运行 MVP，覆盖经营总览、订单队列、订单人工审核、Excel/CSV文字导入、库存预警、拣货建议、双车调度、经营分析、操作审计和速达单号登记。

## 运行

要求 Node.js 18+：

```powershell
cd D:\local-ai\chen-sheng-assistant
npm start
```

浏览器访问 `http://localhost:3088`。局域网其他电脑访问本机局域网 IP：`http://本机IP:3088`（防火墙放行 3088 端口后）。服务监听 `0.0.0.0`，数据仅写入本地 `data/demo.json`，没有外部云端调用。

## 第一阶段安全边界

- 速达 5000.Online-Pro 4.00 继续作为正式业务账本。
- 不连接、不读取、不修改速达数据库，不做未经验证的导入。
- 助手流程：微信文字/截图、Excel、图片订单整理 → 客户/商品/数量/价格人工确认 → 操作员在速达局域网客户端人工开单 → 回填速达单号（后续迭代）。
- 所有重要数据修改应由人工确认；当前新增订单明确标记“待人工确认”。

## 当前接口

- `GET /api/overview`：总览、订单、库存、车辆、审计记录
- `POST /api/orders`：登记订单（customer、source、amount、items）
- `POST /api/import`：导入CSV/制表符文本（customer、content、filename），进入人工确认
- `POST /api/orders/:id/approve`：人工确认订单
- `POST /api/orders/:id/speeda`：登记人工速达开单后的单号
- `POST /api/dispatch`：人工确认车辆路线
- `GET /api/health`：本地健康检查

## 后续实施建议

接入真实业务前，增加本地 SQLite、微信导出文件解析、Excel 解析、OCR（本机部署）、客户/商品主数据及审计日志；所有解析结果进入审核队列，确认后再由人工操作速达。建议先在副本数据和测试电脑验证，不接触速达生产库。
