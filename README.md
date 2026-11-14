# VPS 流量监控面板

基于 Cloudflare Workers + KV 的轻量级 VPS 流量监控面板。  
支持多台服务器上报、实时图表、剩余流量排序、PWA 安装，数据自动脱敏。


## 功能特性

- 多服务器流量集中展示
- 按剩余流量自动排序（最紧张的排在最前）
- 今天 / 昨天小时级曲线，近 7/30 天、全部、自定义日期日级曲线
- 窄屏优化的图表刻度（强制显示首尾时间）
- 服务器卡片多选过滤图表
- IP 服务端自动脱敏
- 面板访问令牌保护（可选）
- 上报密钥鉴权
- 边缘缓存 + 主动清理
- PWA 支持，可添加到主屏幕
- 小时数据只保留 3 天，日汇总保留 365 天，体积可控

## 快速部署

### 1. 创建 Worker

在 Cloudflare Dashboard 创建一个新的 Worker。

### 2. 绑定 KV

创建一个 KV Namespace，并绑定到变量名：

```
TRAFFIC_KV
```

### 3. 设置环境变量

| 变量名        | 必填 | 说明                                                 |
| ------------- | ---- | ---------------------------------------------------- |
| `UPLOAD_KEY`  | 是   | 上报密钥，请求头 `X-Upload-Key`                      |
| `PANEL_TOKEN` | 否   | 面板访问令牌。设置后访问 `/` 和 `/api/data` 需要鉴权 |
| `CORS_ORIGIN` | 否   | 跨域来源，多个用逗号分隔                             |

### 4. 粘贴代码

将 `worker.js` 内容完整粘贴到 Worker 编辑器，保存并部署。

### 5. 访问面板

```
https://your-worker.workers.dev/
```

如果设置了 `PANEL_TOKEN`，首次访问请使用：

```
https://your-worker.workers.dev/?token=你的PANEL_TOKEN
```

访问后会自动写入 Cookie，后续直接打开即可。

## 上报数据

向 `/api/upload` 发送 `POST` 请求，请求头需携带：

```
X-Upload-Key: 你的UPLOAD_KEY
Content-Type: application/json
```

### 请求体示例

```json
{
  "device_id": "unique-device-id-123",
  "host": "香港-01",
  "type": "VPS",
  "mode": "按月",
  "used_gb": 123.45,
  "max_gb": 500,
  "pct": 24,
  "reset_day": 1,
  "hourly": [
    {
      "date": "2026-11-13",
      "hour": "15:00",
      "total_mb": 2048.5,
      "rx_mb": 1800,
      "tx_mb": 248.5
    }
  ]
}
```

### 字段说明

| 字段        | 说明                                  |
| ----------- | ------------------------------------- |
| `device_id` | 设备唯一标识（推荐），无效时回退到 IP |
| `host`      | 显示名称                              |
| `used_gb`   | 当前周期已用流量（GB）                |
| `max_gb`    | 流量上限（GB），0 表示无限            |
| `pct`       | 使用百分比                            |
| `reset_day` | 重置日（1-31）                        |
| `hourly`    | 小时级数据数组                        |

> 服务端会优先使用 Cloudflare 注入的真实来源 IP（`CF-Connecting-IP`），请求体中的 `ip` 字段可被忽略。

## 接口列表

| 方法 | 路径             | 说明                   |
| ---- | ---------------- | ---------------------- |
| GET  | `/`              | 主面板                 |
| GET  | `/home`          | 主面板（兼容）         |
| GET  | `/api/data`      | 获取数据（需面板鉴权） |
| POST | `/api/upload`    | 上报数据（需上传密钥） |
| GET  | `/healthz`       | 健康检查               |
| GET  | `/manifest.json` | PWA 清单               |

## 数据存储结构

```
report:dev:<device_id>   # 有效设备 ID 时使用
report:ip:<ip>           # 无有效设备 ID 时回退
```

统一使用 `report:` 前缀，一次 `list` 即可获取全部报告。

## 安全设计

- 上报密钥使用定长比较，防止时序攻击
- 面板支持 URL Token / Cookie / Basic Auth
- IP 在服务端脱敏后再下发
- 所有用户可控字段做 HTML 转义，防止 XSS
- 请求体大小、小时条目数量均有限制

## 本地开发 / 测试

导出的纯函数可直接用于单元测试：

```js
import { maskIp, normalizeHour, aggregateDaily } from './worker.js';
```

## 许可

MIT

## 致谢

- [Chart.js](https://www.chartjs.org/)
- Cloudflare Workers + KV
