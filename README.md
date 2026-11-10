# VPS 流量监控面板

Cloudflare Worker 后端，接收多服务器流量上报并展示。

## 功能

- 接收服务器流量上报
- 多服务器数据聚合
- 实时图表（小时/天/自定义范围）
- 用量进度可视化
- PWA 支持

## 部署

### 1. 创建 KV

Cloudflare 控制台 → Workers & Pages → KV → 创建命名空间，名称随意。

### 2. 创建 Worker

1. 新建 Worker
2. 绑定 KV：变量名 `TRAFFIC_KV`，选择刚创建的命名空间
3. 设置环境变量：
   - `UPLOAD_KEY`：自定义密钥（服务器上报时需携带）
4. 粘贴 `worker.js` 代码，部署

### 3. 接口

| 路径             | 方法 | 说明             |
| ---------------- | ---- | ---------------- |
| `/`              | GET  | 启动页，自动跳转 |
| `/home`          | GET  | 数据面板         |
| `/api/data`      | GET  | 获取数据（JSON） |
| `/api/upload`    | POST | 上报接口         |
| `/manifest.json` | GET  | PWA 清单         |

### 4. 上报示例

```bash
curl -X POST https://你的worker.workers.dev/api/upload \
  -H "Content-Type: application/json" \
  -H "X-Upload-Key: 你的密钥" \
  -d '{
    "host": "服务器名",
    "ip": "1.2.3.4",
    "used_gb": "100",
    "max_gb": "1000",
    "pct": "10",
    "today_gb": "5",
    "hourly": [{"hour": "12:00", "total_mb": 512}]
  }'
```

## 面板功能

- **今天/昨天**：小时流量图
- **近7天/近30天/全部**：日流量图
- **自定义**：选择日期范围
- 点击服务器卡片可筛选显示
- 用量颜色：绿(<50%) / 黄(50-70%) / 橙(70-90%) / 红(≥90%)

## 免费额度

Cloudflare KV 免费版：

- 读取：100,000 次/天
- 写入：1,000 次/天

10 台服务器每小时上报约 240 次写入/天，足够使用。
