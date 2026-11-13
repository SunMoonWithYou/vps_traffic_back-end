/**
 * ============================================================================
 * VPS 流量监控面板 · Cloudflare Worker
 * ============================================================================
 *
 * 环境变量
 *   UPLOAD_KEY    必填。上报密钥，请求头 X-Upload-Key
 *   PANEL_TOKEN   选填。面板访问令牌。配置后 /home 与 /api/data 需要鉴权，
 *                 浏览器首次通过 /home?token=xxx 访问，随后写入 Cookie
 *   CORS_ORIGIN   选填。跨域来源白名单，多个用逗号分隔。留空则不下发 CORS 头
 *
 * KV 绑定
 *   TRAFFIC_KV    存储各服务器的流量报告
 *
 * 接口
 *   GET  /              主面板
 *   GET  /home          主面板（兼容旧链接）
 *   GET  /manifest.json PWA 清单
 *   GET  /healthz       健康检查
 *   GET  /api/data      获取数据（边缘缓存 60s）
 *   POST /api/upload    上报数据（按 device_id 去重，回退到真实 IP）
 *
 * 存储布局
 *   report:dev:<device_id>   设备有效时的主键
 *   report:ip:<ip>           无有效 device_id 时的回退主键
 *   两种前缀统一用 report: 前缀一次 list 取回，避免两次分页查询
 */

// ══════════════════════════════════════════════════════════════════════════
// 配置
// ══════════════════════════════════════════════════════════════════════════

const CONFIG = Object.freeze({
  /** 小时数据保留天数。前端只用今天+昨天两天，3 天留一天缓冲即可。
   *  这是 value 体积的主要来源：14 天比 3 天多占约 20 KB，且每次上报都要整体重写一遍。
   *  确有按小时回溯更久的需求时再调大，代价是写放大线性增长。 */
  HOURLY_RETENTION_DAYS: 3,
  /** 日汇总保留天数 */
  DAILY_RETENTION_DAYS: 365,
  /** /api/data 边缘缓存秒数。过长会导致面板数据陈旧，60s 是体验与成本的平衡点 */
  DATA_CACHE_TTL: 60,
  /** 单次上报允许的小时条目上限，防止恶意构造超大数组打满 CPU */
  MAX_HOURLY_ENTRIES: 400,
  /** 请求体大小上限（字节） */
  MAX_BODY_BYTES: 512 * 1024,
  /** 并发读取 KV 的批大小，需低于 Workers 免费版 50 次 subrequest 上限 */
  KV_CONCURRENCY: 16,
  /** 最多返回的报告数量，超出部分丢弃 */
  MAX_REPORTS: 500,
  /** 下发给前端的小时数据天数（daily 已含完整历史，无需全量传 hourly） */
  CLIENT_HOURLY_DAYS: 2,
  /** 面板 Cookie 有效期（秒） */
  PANEL_COOKIE_MAX_AGE: 60 * 60 * 24 * 30,
});

/** 北京时间偏移，Worker 运行在 UTC，所有「日期」语义一律走这里 */
const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;
const KV_PREFIX = 'report:';
const DATA_CACHE_PATH = '/__cache/api-data';
const PANEL_COOKIE = 'panel_token';

// ══════════════════════════════════════════════════════════════════════════
// 时间工具
// ══════════════════════════════════════════════════════════════════════════

/** 北京时间日期字符串 YYYY-MM-DD，offsetDays 为相对今天的天数（负数表示过去） */
function bjDate(offsetDays = 0) {
  return new Date(Date.now() + BJ_OFFSET_MS + offsetDays * 86400000)
    .toISOString()
    .slice(0, 10);
}

/** 北京时间日期时间字符串 YYYY-MM-DD HH:mm:ss */
function bjDateTime() {
  return new Date(Date.now() + BJ_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

/** 北京时间当前小时 0-23 */
function bjHour() {
  return new Date(Date.now() + BJ_OFFSET_MS).getUTCHours();
}

/** 保留 N 天（含今天）对应的裁剪下界，避免 date >= bjDate(-N) 多留一天 */
function retentionCutoff(days) {
  return bjDate(-(Math.max(1, days) - 1));
}

/** 归一化日期为 YYYY-MM-DD，非法返回 null */
function normalizeDate(value) {
  if (value == null) return null;
  const s = String(value).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** 归一化小时为 HH:00，接受 5 / '5' / '05' / '05:00' / '5:00'，非法返回 null */
function normalizeHour(value) {
  if (value == null) return null;
  const m = String(value).trim().match(/^(\d{1,2})(?::\d{1,2})?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 0 || n > 23) return null;
  return String(n).padStart(2, '0') + ':00';
}

// ══════════════════════════════════════════════════════════════════════════
// 校验与格式化
// ══════════════════════════════════════════════════════════════════════════

/** 安全转数值：拒绝 NaN / Infinity / 负数，并夹到上限 */
function toNumber(value, max = 1e12) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), max);
}

/** 保留两位小数，抑制浮点累加误差 */
function round2(n) {
  return Math.round(n * 100) / 100;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const INVALID_DEVICE_IDS = new Set(['unknown', 'null', 'undefined', 'none', 'nil', 'n/a', 'na', '-', '0']);

/** device_id 是否可用于做存储主键 */
function isValidDeviceId(id) {
  if (id == null) return false;
  const s = String(id).trim();
  if (s.length < 4 || s.length > 128) return false;
  return !INVALID_DEVICE_IDS.has(s.toLowerCase());
}

/**
 * IP 脱敏。必须在服务端执行——前端打码等于没打码，任何人 curl 一下
 * /api/data 就能拿到全部服务器真实 IP。
 */
function maskIp(ip) {
  const s = String(ip ?? '').trim();
  if (!s || s === '-') return '-';
  if (s.includes(':')) {
    // IPv6：截取前两段。必须先 slice 再过滤空串，否则 fe80::1 会被拼成 fe80:1
    const head = s.split(':').slice(0, 2).filter(Boolean);
    return head.length ? head.join(':') + '::*' : '*';
  }
  const parts = s.split('.');
  return parts.length === 4 ? parts[0] + '.' + parts[1] + '.*.*' : '*';
}

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML 转义，阻断上报端 host 字段造成的存储型 XSS */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
}

// ══════════════════════════════════════════════════════════════════════════
// HTTP 基础设施
// ══════════════════════════════════════════════════════════════════════════

class HttpError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.headers = headers || {};
  }
}

function baseHeaders(extra) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  };
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: baseHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    }),
  });
}

function methodNotAllowed(allowed) {
  return jsonResponse({ error: 'Method Not Allowed' }, 405, { Allow: allowed });
}

function corsHeaders(env) {
  const origin = (env && env.CORS_ORIGIN ? String(env.CORS_ORIGIN) : '').trim();
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Upload-Key, X-Panel-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** FNV-1a，用于生成 ETag */
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

// ══════════════════════════════════════════════════════════════════════════
// 鉴权
// ══════════════════════════════════════════════════════════════════════════

/** 定长比较，避免通过响应时间差逐字节猜测密钥 */
async function secureCompare(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (!left || !right) return false;
  const encoder = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

async function assertUploadKey(request, env) {
  const expected = env.UPLOAD_KEY;
  if (!expected) throw new HttpError(500, 'UPLOAD_KEY is not configured');
  const provided = request.headers.get('X-Upload-Key');
  if (!(await secureCompare(provided, expected))) {
    throw new HttpError(401, 'Unauthorized');
  }
}

function readCookie(request, name) {
  const raw = request.headers.get('Cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return part.slice(idx + 1).trim();
      }
    }
  }
  return null;
}

function parseBasicPassword(request) {
  const header = request.headers.get('Authorization');
  if (!header || !/^basic\s+/i.test(header)) return null;
  try {
    const decoded = atob(header.replace(/^basic\s+/i, '').trim());
    const idx = decoded.indexOf(':');
    return idx >= 0 ? decoded.slice(idx + 1) : decoded;
  } catch {
    return null;
  }
}

/**
 * 面板鉴权。未配置 PANEL_TOKEN 时直接放行，保持向后兼容。
 * 返回非空 Response 表示需要立即返回（例如带 token 参数时的重定向）。
 */
async function assertPanelAccess(request, env, url) {
  const token = env.PANEL_TOKEN ? String(env.PANEL_TOKEN) : '';
  if (!token) return null;

  const candidates = [
    url.searchParams.get('token'),
    request.headers.get('X-Panel-Token'),
    readCookie(request, PANEL_COOKIE),
    parseBasicPassword(request),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await secureCompare(candidate, token)) {
      // 通过 URL 参数首次访问时，写入 Cookie 并从地址栏抹掉 token
      if (url.searchParams.has('token')) {
        const clean = new URL(url.toString());
        clean.searchParams.delete('token');
        return new Response(null, {
          status: 302,
          headers: baseHeaders({
            Location: clean.pathname + clean.search,
            'Set-Cookie':
              PANEL_COOKIE +
              '=' +
              encodeURIComponent(token) +
              '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' +
              CONFIG.PANEL_COOKIE_MAX_AGE,
            'Cache-Control': 'no-store',
          }),
        });
      }
      return null;
    }
  }

  throw new HttpError(401, '需要访问令牌：请在地址后附加 ?token=你的 PANEL_TOKEN', {
    'WWW-Authenticate': 'Basic realm="Traffic Panel", charset="UTF-8"',
  });
}

// ══════════════════════════════════════════════════════════════════════════
// 存储层
// ══════════════════════════════════════════════════════════════════════════

async function readJson(kv, key) {
  try {
    const raw = await kv.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 分页列举全部报告 key。原实现只取首页，超过 1000 台会静默漏机器 */
async function listReportKeys(kv) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: KV_PREFIX, limit: 1000, cursor });
    for (const item of page.keys || []) keys.push(item.name);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return keys;
}

/** 有并发上限的 map，避免一次性打出上百个 KV 请求撞上 subrequest 限制 */
async function mapLimit(items, limit, fn) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await fn(items[index], index);
      } catch {
        results[index] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** 合并小时数据。用 Map 索引，避免原先 O(n²) 的 findIndex */
function mergeHourly(existing, incoming, today) {
  const map = new Map();
  for (const item of existing) {
    if (isPlainObject(item) && item.key) map.set(item.key, item);
  }
  for (const raw of incoming) {
    if (!isPlainObject(raw) || raw.hour == null) continue;
    const date = normalizeDate(raw.date) || today;
    const hour = normalizeHour(raw.hour);
    if (!hour) continue;

    const entry = {
      key: date + ' ' + hour,
      date,
      hour,
      total_mb: round2(toNumber(raw.total_mb)),
    };
    if (raw.rx_mb != null) entry.rx_mb = round2(toNumber(raw.rx_mb));
    if (raw.tx_mb != null) entry.tx_mb = round2(toNumber(raw.tx_mb));
    map.set(entry.key, entry);
  }
  return Array.from(map.values());
}

/** 按日期裁剪并排序小时数据 */
function pruneHourly(list, cutoffDate) {
  return list
    .filter((item) => item && item.date && item.date >= cutoffDate)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * 由小时数据重建日汇总。
 * 覆盖小时数据涉及的全部日期（而非只看本次上报的日期），可自动修复历史错误，
 * 同时保留超出小时窗口的旧日数据。
 */
function aggregateDaily(hourly, previousDaily, cutoffDate) {
  const daily = isPlainObject(previousDaily) ? { ...previousDaily } : {};
  const sums = new Map();
  for (const item of hourly) {
    sums.set(item.date, (sums.get(item.date) || 0) + (item.total_mb || 0));
  }
  for (const [date, total] of sums) daily[date] = round2(total);
  for (const date of Object.keys(daily)) {
    if (!normalizeDate(date) || date < cutoffDate) delete daily[date];
  }
  return daily;
}

// ══════════════════════════════════════════════════════════════════════════
// 读数据
// ══════════════════════════════════════════════════════════════════════════

/**
 * 对外视图：脱敏 IP、裁剪 hourly、只保留前端需要的字段。
 * hourly 从 14 天（336 条/台）降到 2 天（48 条/台），payload 体积下降约 85%。
 */
function toPublicView(kvKey, report) {
  const keepDates = new Set();
  for (let i = 0; i < CONFIG.CLIENT_HOURLY_DAYS; i++) keepDates.add(bjDate(-i));

  const hourly = Array.isArray(report.hourly) ? report.hourly : [];
  const id = kvKey.startsWith(KV_PREFIX) ? kvKey.slice(KV_PREFIX.length) : kvKey;

  return {
    id,
    host: String(report.host || '未知').slice(0, 64),
    ip: maskIp(report.ip),
    type: report.type ? String(report.type).slice(0, 32) : '',
    mode: report.mode ? String(report.mode).slice(0, 32) : '',
    used_gb: round2(toNumber(report.used_gb)),
    max_gb: round2(toNumber(report.max_gb)),
    pct: Math.round(toNumber(report.pct, 10000)),
    reset_day: report.reset_day == null ? null : Math.trunc(toNumber(report.reset_day, 31)) || null,
    updated_bj: String(report.updated_bj || report.time || '').slice(0, 19),
    daily: isPlainObject(report.daily) ? report.daily : {},
    hourly: hourly.filter((item) => item && keepDates.has(item.date)),
  };
}

async function getReports(env) {
  const kv = env.TRAFFIC_KV;
  if (!kv) throw new HttpError(500, 'TRAFFIC_KV is not configured');

  const keys = await listReportKeys(kv);
  if (!keys.length) return [];

  const loaded = await mapLimit(keys, CONFIG.KV_CONCURRENCY, async (key) => {
    const report = await readJson(kv, key);
    return report ? toPublicView(key, report) : null;
  });

  return loaded
    .filter(Boolean)
    .sort(byRemainingQuota)
    .slice(0, CONFIG.MAX_REPORTS);
}

/** 剩余可用流量：无限额（max_gb 为 0）视为 Infinity，排最后 */
function remainingQuota(report) {
  const max = toNumber(report.max_gb);
  return max > 0 ? max - toNumber(report.used_gb) : Infinity;
}

/** 按剩余流量升序——余量最紧张的机器排在卡片列表最前面 */
function byRemainingQuota(a, b) {
  const ra = remainingQuota(a);
  const rb = remainingQuota(b);
  if (ra === rb) return String(a.host).localeCompare(String(b.host), 'zh-CN');
  if (!Number.isFinite(ra)) return 1;
  if (!Number.isFinite(rb)) return -1;
  return ra - rb;
}

// ══════════════════════════════════════════════════════════════════════════
// 写数据
// ══════════════════════════════════════════════════════════════════════════

async function readJsonBody(request, maxBytes) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, 'Payload too large');
  }
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Payload too large');
  if (!text.trim()) throw new HttpError(400, 'Empty body');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
  if (!isPlainObject(parsed)) throw new HttpError(400, 'Body must be a JSON object');
  return parsed;
}

const NUMERIC_FIELDS = ['rx', 'tx', 'yest_gb', 'today_gb', 'used_gb', 'max_gb', 'pct'];
const TEXT_FIELDS = ['type', 'mode', 'period_start', 'period_end'];

/** 按白名单合并上报字段，未出现的字段保留上次的值 */
function mergeReportFields(previous, body) {
  const report = isPlainObject(previous) ? { ...previous } : {};

  for (const field of NUMERIC_FIELDS) {
    if (body[field] != null) report[field] = round2(toNumber(body[field], 1e6));
  }
  for (const field of TEXT_FIELDS) {
    if (body[field] != null) report[field] = String(body[field]).slice(0, 64);
  }
  if (body.reset_day != null) {
    const day = Math.trunc(toNumber(body.reset_day, 31));
    report.reset_day = day >= 1 && day <= 31 ? day : null;
  }
  return report;
}

async function handleUpload(request, env) {
  await assertUploadKey(request, env);
  const body = await readJsonBody(request, CONFIG.MAX_BODY_BYTES);

  // 优先用 CF 注入的真实来源 IP，请求体里的 ip 字段可被伪造
  const edgeIp = String(request.headers.get('CF-Connecting-IP') || '').trim();
  const bodyIp = String(body.ip || '').trim();
  const ip = edgeIp || bodyIp || '';

  const deviceId = isValidDeviceId(body.device_id) ? String(body.device_id).trim() : null;
  const kvKey = deviceId
    ? KV_PREFIX + 'dev:' + deviceId
    : ip
      ? KV_PREFIX + 'ip:' + ip
      : null;
  if (!kvKey) throw new HttpError(400, 'Missing device_id and ip');

  const kv = env.TRAFFIC_KV;
  const existing = await readJson(kv, kvKey);
  const nowBj = bjDateTime();
  const today = nowBj.slice(0, 10);

  let hourly = Array.isArray(existing && existing.hourly) ? existing.hourly : [];
  let daily = isPlainObject(existing && existing.daily) ? existing.daily : {};

  if (Array.isArray(body.hourly) && body.hourly.length) {
    const merged = mergeHourly(hourly, body.hourly.slice(0, CONFIG.MAX_HOURLY_ENTRIES), today);
    // 必须先聚合、后裁剪。顺序反了的话，机器离线数天后补传多天数据时，
    // 超出小时窗口的日期会被裁掉，永远进不了日汇总，历史数据静默丢失。
    daily = aggregateDaily(merged, daily, retentionCutoff(CONFIG.DAILY_RETENTION_DAYS));
    hourly = pruneHourly(merged, retentionCutoff(CONFIG.HOURLY_RETENTION_DAYS));
  }

  const report = mergeReportFields(existing, body);
  report.device_id = deviceId || (existing && existing.device_id) || null;
  report.host = String(body.host || (existing && existing.host) || ip || '未知').slice(0, 64);
  report.ip = ip;
  report.time = String(body.time || nowBj).slice(0, 32);
  report.updated_bj = nowBj;
  report.hourly = hourly;
  report.daily = daily;

  try {
    await kv.put(kvKey, JSON.stringify(report));
  } catch (err) {
    // KV 对同一 key 限制 1 次/秒写入，上报过于密集时会命中，给客户端明确的重试信号
    const message = String((err && err.message) || '');
    if (/429|rate limit|too many|quota/i.test(message)) {
      throw new HttpError(429, 'Too many writes for this key, retry later', { 'Retry-After': '2' });
    }
    throw err;
  }

  await purgeDataCache(request);
  return jsonResponse({ ok: true, key: kvKey, updated_bj: nowBj });
}

// ══════════════════════════════════════════════════════════════════════════
// 缓存
// ══════════════════════════════════════════════════════════════════════════

function dataCacheKey(request) {
  return new Request(new URL(DATA_CACHE_PATH, request.url).toString(), { method: 'GET' });
}

async function purgeDataCache(request) {
  // 只清理当前数据中心的副本，其他 colo 依赖 TTL 自然过期
  try {
    await caches.default.delete(dataCacheKey(request));
  } catch {
    /* 缓存不可用时忽略 */
  }
}

/** 取缓存命中结果，并把 Cache-Control 改回 no-store 交给客户端 */
async function serveCachedData(cached) {
  const body = await cached.text();
  return new Response(body, {
    status: 200,
    headers: baseHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Cache': 'HIT',
    }),
  });
}

async function serveData(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = dataCacheKey(request);

  let cached = null;
  try {
    cached = await cache.match(cacheKey);
  } catch {
    cached = null;
  }
  if (cached) return serveCachedData(cached);

  const reports = await getReports(env);
  const payload = JSON.stringify({ generated_at: bjDateTime(), reports });

  const toCache = new Response(payload, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=' + CONFIG.DATA_CACHE_TTL,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, toCache).catch(() => {}));

  return new Response(payload, {
    status: 200,
    headers: baseHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Cache': 'MISS',
    }),
  });
}

// ══════════════════════════════════════════════════════════════════════════
// 路由
// ══════════════════════════════════════════════════════════════════════════

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: baseHeaders(corsHeaders(env)) });
  }

  if (pathname === '/api/upload') {
    if (method !== 'POST') return methodNotAllowed('POST, OPTIONS');
    const res = await handleUpload(request, env);
    for (const [k, v] of Object.entries(corsHeaders(env))) res.headers.set(k, v);
    return res;
  }

  if (pathname === '/healthz') {
    return jsonResponse({ ok: true, time: bjDateTime() });
  }

  if (pathname === '/manifest.json') {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed('GET, HEAD');
    return serveManifest();
  }

  if (pathname === '/api/data') {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed('GET, HEAD, OPTIONS');
    const redirect = await assertPanelAccess(request, env, url);
    if (redirect) return redirect;
    const res = await serveData(request, env, ctx);
    for (const [k, v] of Object.entries(corsHeaders(env))) res.headers.set(k, v);
    return res;
  }

  if (pathname === '/' || pathname === '/home' || pathname === '/index.html') {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed('GET, HEAD');
    const redirect = await assertPanelAccess(request, env, url);
    if (redirect) return redirect;
    return serveMain(request);
  }

  return htmlResponse(renderNotFound(), 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        // 5xx 属于服务端内部问题，只落日志，不把配置细节回显给客户端
        if (err.status >= 500) {
          console.error('[worker] server error:', err.message);
          return jsonResponse({ error: 'Internal Server Error' }, err.status);
        }
        return jsonResponse({ error: err.message }, err.status, err.headers);
      }
      // 内部错误只进日志，不回显给客户端，避免泄露绑定名、堆栈等信息
      console.error('[worker] unhandled error:', (err && err.stack) || err);
      return jsonResponse({ error: 'Internal Server Error' }, 500);
    }
  },
};

// ══════════════════════════════════════════════════════════════════════════
// 页面
// ══════════════════════════════════════════════════════════════════════════

const NOT_FOUND_HTML =
  '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"><title>404</title>' +
  '<style>body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;' +
  'justify-content:center;font-family:system-ui,sans-serif;background:#f5f7fa;color:#111}' +
  'h1{font-size:3rem;margin:0;color:#0066ff}p{color:#888}a{color:#0066ff;text-decoration:none}</style>' +
  '</head><body><h1>404</h1><p>页面不存在</p><p><a href="/">&larr; 返回面板</a></p></body></html>';

function renderNotFound() {
  return NOT_FOUND_HTML;
}

const MANIFEST = {
  name: '流量监控面板',
  short_name: '流量监控',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#fafafa',
  theme_color: '#0066ff',
  lang: 'zh-CN',
  icons: [
    {
      src: 'https://raw.githubusercontent.com/SunMoonWithYou/vps_traffic_back-end/main/vps-traffic-logo-192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any',
    },
    {
      src: 'https://raw.githubusercontent.com/SunMoonWithYou/vps_traffic_back-end/main/vps-traffic-logo-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any',
    },
  ],
};

const MANIFEST_JSON = JSON.stringify(MANIFEST);
const MANIFEST_ETAG = '"' + fnv1a(MANIFEST_JSON) + '"';

function serveManifest() {
  return new Response(MANIFEST_JSON, {
    headers: baseHeaders({
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
      ETag: MANIFEST_ETAG,
    }),
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: baseHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    }),
  });
}

// ── 主面板 HTML（模块级常量，只在 Worker 冷启动时求值一次）────────────────
const MAIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>流量监控面板</title>
<meta name="theme-color" content="#0066ff">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="https://raw.githubusercontent.com/SunMoonWithYou/vps_traffic_back-end/main/vps-traffic-logo-192.png">
<link rel="icon" href="https://raw.githubusercontent.com/SunMoonWithYou/vps_traffic_back-end/main/vps-traffic-logo-icon.ico">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"><\/script>
<script>
  // Chart.js 加载失败时自动切换备用 CDN
  if (!window.Chart) {
    document.write('<script src="https://unpkg.com/chart.js@4.4.1/dist/chart.umd.min.js"><\\/script>');
  }
<\/script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2.2.0/dist/chartjs-plugin-zoom.min.js"><\/script>
<script>
  // 确保 zoom 插件注册（UMD 构建）
  if (window.Chart && window.ChartZoom) {
    Chart.register(ChartZoom);
  }
</script>
<style>
:root{--bg:#f5f7fa;--card:#fff;--border:#e8eaed;--text:#111;--muted:#6b7280;--accent:#0066ff}
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);margin:0;padding:24px;min-height:100vh;-webkit-font-smoothing:antialiased}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px;flex-wrap:wrap;gap:16px}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.brand img{width:40px;height:40px;border-radius:10px;flex:none}
.brand h1{margin:0;font-size:1.35rem;font-weight:650;letter-spacing:-.3px;background:linear-gradient(135deg,#0066ff,#4f46e5);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.tabs{display:flex;gap:0;background:#fff;padding:3px;border-radius:12px;border:1px solid var(--border);box-shadow:0 1px 2px rgba(0,0,0,.04)}
.tab{padding:8px 16px;border-radius:9px;cursor:pointer;font-size:13px;color:#666;font-weight:500;transition:background .15s,color .15s;white-space:nowrap;user-select:none}
.tab:hover{color:#111}
.tab.active{background:#f0f4ff;color:#0066ff;font-weight:600}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:22px}
.stat{background:#fff;border-radius:14px;padding:18px 20px;border:1px solid var(--border);box-shadow:0 1px 3px rgba(0,0,0,.04);min-width:0}
.stat .label{font-size:12px;color:var(--muted);font-weight:500}
.stat .value{font-size:1.65rem;font-weight:650;margin-top:6px;color:#111;word-break:break-all}
.stat .value small{font-size:.85rem;font-weight:400;color:var(--muted)}
.stat .sub{font-size:12px;color:var(--muted);margin-top:4px}
.chart-box{background:#fff;border-radius:14px;padding:16px 20px 14px;border:1px solid var(--border);margin-bottom:22px;height:420px;box-shadow:0 1px 3px rgba(0,0,0,.04);display:flex;flex-direction:column}
.chart-wrap{flex:1;min-height:120px;position:relative}
.chart-wrap canvas{width:100%!important;height:100%!important}
#legend{display:flex;flex-wrap:wrap;gap:4px 12px;justify-content:center;padding-top:10px;font-size:12px;color:#666}
.legend-item{display:flex;align-items:center;gap:5px;cursor:pointer;user-select:none;max-width:100%}
.legend-item .swatch{width:10px;height:10px;border-radius:2px;flex:none}
.legend-item .legend-name{white-space:normal;word-break:break-word;overflow-wrap:anywhere}
.legend-item.off{opacity:.35}
.legend-item.off .legend-name{text-decoration:line-through}
.servers{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:14px}
.server{background:#fff;border-radius:14px;padding:16px 18px;border:1px solid var(--border);cursor:pointer;transition:border-color .15s,box-shadow .15s;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.server:hover{border-color:#c7d2fe;box-shadow:0 4px 12px rgba(0,102,255,.08)}
.server.active{border-color:#0066ff;box-shadow:0 0 0 3px rgba(0,102,255,.12)}
.server h3{margin:0 0 4px;font-size:1rem;font-weight:600;white-space:normal;word-break:break-word;overflow-wrap:anywhere}
.server .sub{font-size:12px;color:#888;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.server .sub .today{color:#0066ff;font-weight:500}
.server .ip{font-size:11px;color:#aaa;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:2px}
.server .usage{font-size:14px;font-weight:500;margin:8px 0}
.progress{height:6px;background:#f0f0f0;border-radius:3px;margin:10px 0;overflow:hidden}
.progress>div{height:100%;border-radius:3px;transition:width .3s}
.server .meta{font-size:12px;color:#888;display:flex;justify-content:space-between}
#customBox{display:none;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:16px;padding:12px 16px;background:#fff;border:1px solid var(--border);border-radius:12px;font-size:13px;color:#888}
#customBox input{padding:5px 8px;border:1px solid #eee;border-radius:6px;font-size:13px;color:#111}
#customBox button{background:#0066ff;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px}
#customBox button:hover{background:#0052cc}
.empty{padding:48px 20px;text-align:center;color:#888;font-size:14px;grid-column:1/-1}
.skeleton{background:linear-gradient(90deg,#f0f0f0 25%,#f8f8f8 37%,#f0f0f0 63%);background-size:400% 100%;animation:sk 1.4s ease infinite;border-radius:14px;height:132px}
@keyframes sk{0%{background-position:100% 50%}100%{background-position:0 50%}}
@media(max-width:640px){
  body{padding:16px}
  .brand h1{font-size:1.2rem}
  .brand img{width:34px;height:34px}
  .header{flex-direction:column;align-items:stretch;gap:12px}
  .tabs{width:100%;overflow-x:auto;scrollbar-width:none}
  .tabs::-webkit-scrollbar{display:none}
  .tab{padding:6px 12px;font-size:12px}
  .chart-box{height:340px;padding:12px 14px}
  .servers{
    display:flex;
    overflow-x:auto;
    gap:14px;
    padding-bottom:8px;
    scrollbar-width:thin;
    -webkit-overflow-scrolling:touch;
  }
  .servers::-webkit-scrollbar{height:4px}
  .servers::-webkit-scrollbar-thumb{background:#ddd;border-radius:2px}
  .server{
    flex:0 0 280px;
    min-width:280px;
  }
  .empty{grid-column:auto;width:100%;flex:1 0 100%}
  .stat{padding:14px}
  .stat .value{font-size:1.3rem}
}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="header">
  <div class="brand">
    <img src="https://raw.githubusercontent.com/SunMoonWithYou/vps_traffic_back-end/main/vps-traffic-logo-192.png" alt="" onerror="this.style.display='none'">
    <h1>流量监控面板</h1>
  </div>
  <div class="tabs" id="tabs">
    <div class="tab active" data-range="today">今天</div>
    <div class="tab" data-range="yesterday">昨天</div>
    <div class="tab" data-range="7d">近7天</div>
    <div class="tab" data-range="30d">近30天</div>
    <div class="tab" data-range="all">全部</div>
    <div class="tab" data-range="custom">自定义</div>
  </div>
</div>
<div id="customBox">
  <span>从</span>
  <input type="date" id="startDate">
  <span>至</span>
  <input type="date" id="endDate">
  <button id="applyCustom" type="button">应用</button>
  <span id="dateHint" style="color:#ef4444;font-size:12px"></span>
</div>
<div class="stats" id="stats"></div>
<div class="chart-box">
  <div id="desc" style="font-size:13px;color:#888;margin-bottom:8px"></div>
  <div class="chart-wrap"><canvas id="chart"></canvas></div>
  <div id="legend"></div>
</div>
<div class="servers" id="servers">
  <div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>
</div>
<script>
(function () {
  'use strict';

  var BJ_OFFSET = 8 * 3600 * 1000;
  var POLL_INTERVAL = 60000;
  var SERIES_COLORS = ['#22c55e', '#3b82f6', '#f97316', '#a855f7', '#ef4444', '#06b6d4', '#eab308', '#ec4899'];
  var RANGE_TITLES = { today: '今天', yesterday: '昨天', '7d': '近7天', '30d': '近30天', all: '全部', custom: '自定义' };

  var state = {
    reports: [],
    range: 'today',
    selected: new Set(),
    chart: null,
    generatedAt: '',
    loading: false
  };

  var el = {
    tabs: document.getElementById('tabs'),
    customBox: document.getElementById('customBox'),
    startDate: document.getElementById('startDate'),
    endDate: document.getElementById('endDate'),
    dateHint: document.getElementById('dateHint'),
    stats: document.getElementById('stats'),
    desc: document.getElementById('desc'),
    servers: document.getElementById('servers'),
    legend: document.getElementById('legend'),
    canvas: document.getElementById('chart')
  };

  // ── 工具函数 ───────────────────────────────────────────────────────────
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function bjNow() { return new Date(Date.now() + BJ_OFFSET); }

  function bjDateStr(offsetDays) {
    return new Date(Date.now() + BJ_OFFSET + (offsetDays || 0) * 86400000).toISOString().slice(0, 10);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function num(value) {
    var n = parseFloat(value);
    return isFinite(n) ? n : 0;
  }

  function fixed2(value) {
    var n = parseFloat(value);
    return isFinite(n) ? n.toFixed(2) : '-';
  }

  function formatHourLabel(bjString) {
    var m = String(bjString || '').match(/(\\d{2}):(\\d{2})/);
    return m ? m[1] + ':' + m[2] : '';
  }

  // YYYY-MM-DD 加减整数天（UTC 语义，与日期字符串一致）
  function addDays(dateStr, n) {
    var t = new Date(dateStr + 'T00:00:00Z').getTime() + n * 86400000;
    return isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
  }

  // ── 数据计算 ───────────────────────────────────────────────────────────
  // 剩余可用流量：无限额视为 Infinity 排最后；与后端 byRemainingQuota 保持一致
  function remainingGB(report) {
    var max = num(report.max_gb);
    return max > 0 ? max - num(report.used_gb) : Infinity;
  }

  function byRemaining(a, b) {
    var ra = remainingGB(a);
    var rb = remainingGB(b);
    if (ra === rb) return String(a.host).localeCompare(String(b.host), 'zh-CN');
    if (!isFinite(ra)) return 1;
    if (!isFinite(rb)) return -1;
    return ra - rb;
  }

  // 今日/昨日流量统一入口，避免卡片、统计、图表三处各算一套
  function dayTotalGB(report, date) {
    var daily = report.daily || {};
    if (daily[date] != null) return num(daily[date]) / 1024;
    var hourly = report.hourly || [];
    var sum = 0;
    for (var i = 0; i < hourly.length; i++) {
      if (hourly[i].date === date) sum += num(hourly[i].total_mb);
    }
    return sum / 1024;
  }

  function hourlyIndex(report, date) {
    var map = Object.create(null);
    var hourly = report.hourly || [];
    for (var i = 0; i < hourly.length; i++) {
      var h = hourly[i];
      if (h.date !== date || !h.hour) continue;
      map[String(h.hour).slice(0, 2)] = num(h.total_mb) / 1024;
    }
    return map;
  }

  function visibleReports() {
    if (!state.selected.size) return state.reports;
    return state.reports.filter(function (r) { return state.selected.has(r.id); });
  }

  function pruneSelection() {
    var alive = new Set(state.reports.map(function (r) { return r.id; }));
    state.selected.forEach(function (id) {
      if (!alive.has(id)) state.selected.delete(id);
    });
  }

  // ── 渲染 ───────────────────────────────────────────────────────────────
  function renderServers() {
    if (!state.reports.length) {
      el.servers.innerHTML = '<div class="empty">还没有收到上报数据<br>检查 VPS 上的上报脚本是否正常运行</div>';
      return;
    }

    var todayStr = bjDateStr(0);
    var parts = [];

    state.reports.forEach(function (r) {
      var pct = parseInt(r.pct, 10) || 0;
      var active = state.selected.has(r.id) ? ' active' : '';
      var color = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f97316' : pct >= 50 ? '#eab308' : '#22c55e';
      var today = dayTotalGB(r, todayStr).toFixed(2);
      var time = formatHourLabel(r.updated_bj);

      parts.push(
        '<div class="server' + active + '" data-id="' + escapeHtml(r.id) + '">' +
          '<h3 title="' + escapeHtml(r.host) + '">' + escapeHtml(r.host) + '</h3>' +
          '<div class="sub">' +
            '<span class="today">今日 ' + today + ' GB</span>' +
            (time ? '<span>' + escapeHtml(time) + '</span>' : '') +
          '</div>' +
          '<div class="ip">' + escapeHtml(r.ip) + '</div>' +
          '<div class="usage">' + fixed2(r.used_gb) + ' / ' + fixed2(r.max_gb) + ' GB</div>' +
          '<div class="progress"><div style="width:' + Math.min(pct, 100) + '%;background:' + color + '"></div></div>' +
          '<div class="meta">' +
            '<span style="color:' + color + ';font-weight:600">' + pct + '%</span>' +
            '<span>重置' + escapeHtml(r.reset_day == null ? '-' : r.reset_day) + '号</span>' +
          '</div>' +
        '</div>'
      );
    });

    el.servers.innerHTML = parts.join('');
  }

  function renderStats() {
    var list = visibleReports();
    var todayStr = bjDateStr(0);
    var used = 0;
    var max = 0;
    var todayTotal = 0;

    for (var i = 0; i < list.length; i++) {
      used += num(list[i].used_gb);
      max += num(list[i].max_gb);
      todayTotal += dayTotalGB(list[i], todayStr);
    }

    var pct = max > 0 ? Math.round(used / max * 100) : 0;
    var title = state.selected.size === 0
      ? '全部'
      : (state.selected.size === 1 ? (list[0] ? list[0].host : '1台') : state.selected.size + '台');
    var pctColor = pct >= 80 ? '#ef4444' : '#22c55e';

    el.stats.innerHTML =
      '<div class="stat"><div class="label">当前</div>' +
        '<div class="value" style="font-size:1rem">' + escapeHtml(title) + '</div></div>' +
      '<div class="stat"><div class="label">今日</div>' +
        '<div class="value">' + todayTotal.toFixed(2) + '<small> GB</small></div></div>' +
      '<div class="stat"><div class="label">累计</div>' +
        '<div class="value">' + used.toFixed(2) + '<small> GB</small></div>' +
        '<div class="sub">限额 ' + max.toFixed(0) + ' GB</div></div>' +
      '<div class="stat"><div class="label">进度</div>' +
        '<div class="value" style="color:' + pctColor + '">' + pct + '%</div></div>';
  }

  // ── 图表 ───────────────────────────────────────────────────────────────
  function buildLabels(isHourly) {
    if (isHourly) {
      // 当前小时还没结束，上报脚本必然还没提交这一小时的数据，直接不画；
      // 已经结束的小时一律画出来，没上报的按 0 补齐。
      // 昨天 24 小时全部已结束，固定画满 00:00~23:00。
      var maxH = state.range === 'today' ? bjNow().getUTCHours() - 1 : 23;
      var labels = [];
      for (var h = 0; h <= maxH; h++) labels.push(pad2(h) + ':00');
      return { labels: labels, hourlyMap: null };
    }

    var dateSet = Object.create(null);
    visibleReports().forEach(function (r) {
      var daily = r.daily || {};
      Object.keys(daily).forEach(function (d) { dateSet[d] = true; });
    });

    var dates = Object.keys(dateSet).sort();

    if (state.range === 'custom') {
      var start = el.startDate.value;
      var end = el.endDate.value;
      dates = dates.filter(function (d) {
        return (!start || d >= start) && (!end || d <= end);
      });
    } else if (state.range === '7d') {
      dates = dates.slice(-7);
    } else if (state.range === '30d') {
      dates = dates.slice(-30);
    }

    return { labels: dates.length ? dates : ['暂无'], hourlyMap: null };
  }

  function pickUnit(maxGB) {
    if (maxGB >= 1024) return { unit: 'TB', scale: 1 / 1024 };
    if (maxGB > 0 && maxGB < 1) return { unit: 'MB', scale: 1024 };
    return { unit: 'GB', scale: 1 };
  }

  function formatFromGB(gb) {
    if (gb >= 1024) return (gb / 1024).toFixed(2) + ' TB';
    if (gb > 0 && gb < 1) return (gb * 1024).toFixed(1) + ' MB';
    return gb.toFixed(2) + ' GB';
  }

  function drawChart() {
    if (typeof Chart === 'undefined') {
      el.desc.textContent = '图表库加载失败，请检查网络';
      return;
    }

    var range = state.range;
    var isHourly = range === 'today' || range === 'yesterday';
    var selected = visibleReports();
    var targetDate = range === 'today' ? bjDateStr(0) : bjDateStr(-1);

    // 只遍历一次：既产出 values，又顺带求出全局最大值
    var built = buildLabels(isHourly);
    var labels = built.labels;
    var maxGB = 0;
    var rows = [];

    selected.forEach(function (r, idx) {
      var values;
      if (isHourly) {
        var map = hourlyIndex(r, targetDate);
        values = labels.map(function (label) {
          return map[label.slice(0, 2)] || 0;
        });
      } else {
        var daily = r.daily || {};
        values = labels.map(function (label) {
          return num(daily[label]) / 1024;
        });
      }
      for (var i = 0; i < values.length; i++) {
        if (values[i] > maxGB) maxGB = values[i];
      }
      rows.push({ report: r, index: idx, values: values });
    });

    var unitInfo = pickUnit(maxGB);
    var scale = unitInfo.scale;

    var narrow = window.innerWidth < 640;
    var datasets = rows.map(function (row) {
      // label 始终用全名，tooltip 才能看到完整主机名；
      // 图例空间不够，由下方 generateLabels 按显示宽度单独截断
      var name = row.report.host || ('服务器' + (row.index + 1));
      var color = SERIES_COLORS[row.index % SERIES_COLORS.length];
      return {
        label: name,
        data: row.values.map(function (v) { return +(v * scale).toFixed(2); }),
        borderColor: color,
        backgroundColor: color + '22',
        fill: true,
        tension: 0.3,
        pointRadius: narrow ? 0 : 2,
        pointHoverRadius: 4,
        borderWidth: 2
      };
    });

    var scopeLabel = state.selected.size ? state.selected.size + '台' : '全部';
    var lastLabel = isHourly && labels.length ? labels[labels.length - 1] : '';
    el.desc.textContent =
      (RANGE_TITLES[range] || '') + ' · ' + scopeLabel + ' · 单位：' + unitInfo.unit +
      (state.generatedAt ? ' · 更新于 ' + state.generatedAt.slice(11) : '') +
      (isHourly && !labels.length ? ' · 当天暂无完整小时数据' : '') +
      (lastLabel ? ' · 截至 ' + lastLabel : '');

    var options = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        // 画布内图例单行绘制、不会换行，机器一多就被裁掉；
        // 改用图表下方的 HTML 图例（#legend），可自动换行、可点击隐藏系列
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label: function (ctx) {
              // parsed.y 是缩放后的值，先还原成 GB 再格式化
              return ctx.dataset.label + ': ' + formatFromGB(ctx.parsed.y / scale);
            }
          }
        },
        zoom: {
          pan: {
            enabled: true,
            mode: 'x'
          },
          zoom: {
            pinch: { enabled: true },
            mode: 'x'
          },
          limits: {
            x: { min: 'original', max: 'original' }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { color: '#888', maxTicksLimit: 6 },
          grid: { color: '#f0f0f0' },
          title: { display: true, text: unitInfo.unit, color: '#888', font: { size: 12 } }
        },
        x: {
          // 窄屏原本只显示到 16:00，末尾几点没有时间刻度、且末点紧贴右边缘像被裁掉：
          // 加密刻度 + 两端留白，并在描述里注明数据截止时间
          offset: narrow,
          ticks: { color: '#888', maxRotation: 0, autoSkip: true, maxTicksLimit: narrow ? 8 : 12 },
          grid: { color: '#f0f0f0' }
        }
      }
    };

    if (state.chart) {
      state.chart.data.labels = labels;
      state.chart.data.datasets = datasets;
      state.chart.options = options;
      state.chart.update('none');
    } else {
      state.chart = new Chart(el.canvas, {
        type: 'line',
        data: { labels: labels, datasets: datasets },
        options: options
      });
    }

    renderLegend(datasets);
  }

  // ── HTML 图例 ───────────────────────────────────────────────────────────
  // flex-wrap 自动换行，放多少台都显示得全；点击可显示/隐藏对应系列
  function renderLegend(datasets) {
    if (!datasets.length) {
      el.legend.innerHTML = '';
      return;
    }
    var parts = [];
    datasets.forEach(function (ds, i) {
      var hidden = state.chart && !state.chart.isDatasetVisible(i);
      parts.push(
        '<div class="legend-item' + (hidden ? ' off' : '') + '" data-idx="' + i + '" title="' + escapeHtml(ds.label) + '">' +
          '<span class="swatch" style="background:' + ds.borderColor + '"></span>' +
          '<span class="legend-name">' + escapeHtml(ds.label) + '</span>' +
        '</div>'
      );
    });
    el.legend.innerHTML = parts.join('');
  }

  function bindLegendToggle() {
    el.legend.addEventListener('click', function (e) {
      var item = e.target.closest('.legend-item');
      if (!item || !state.chart) return;
      var idx = +item.getAttribute('data-idx');
      var willShow = state.chart.isDatasetVisible(idx);
      state.chart.setDatasetVisibility(idx, !willShow);
      state.chart.update('none');
      item.classList.toggle('off', willShow);
    });
  }

  function render() {
    pruneSelection();
    renderServers();
    renderStats();
    drawChart();
  }

  // ── 数据加载 ───────────────────────────────────────────────────────────
  function load() {
    if (state.loading) return Promise.resolve();
    state.loading = true;

    return fetch('/api/data', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        state.reports = Array.isArray(data.reports) ? data.reports : [];
        // 本地再排一次：即使命中旧缓存（按旧规则排序）也能按剩余流量显示
        state.reports.sort(byRemaining);
        state.generatedAt = data.generated_at || '';
        render();
      })
      .catch(function () {
        if (!state.reports.length) {
          el.servers.innerHTML = '<div class="empty">加载失败，请检查网络后刷新</div>';
        }
      })
      .finally(function () {
        state.loading = false;
      });
  }

  // ── 交互 ───────────────────────────────────────────────────────────────
  // 事件委托：只在容器上绑一次，避免每次 render 重建按钮并重复绑定
  el.servers.addEventListener('click', function (e) {
    var card = e.target.closest('.server');
    if (!card) return;
    var id = card.getAttribute('data-id');
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    render();
  });

  el.tabs.addEventListener('click', function (e) {
    var tab = e.target.closest('.tab');
    if (!tab) return;
    var tabs = el.tabs.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('active');
    tab.classList.add('active');

    state.range = tab.getAttribute('data-range');
    var isCustom = state.range === 'custom';
    el.customBox.style.display = isCustom ? 'flex' : 'none';

    if (isCustom && !el.startDate.value) {
      el.startDate.value = bjDateStr(-6);
      el.endDate.value = bjDateStr(0);
    }
    if (isCustom) syncDateConstraints();
    render();
  });

  // ── 自定义日期区间 ──────────────────────────────────────────────────────
  // 规则：起止不能同一天，end 必须晚于 start；start 最晚选昨天，end 最晚今天
  function syncDateConstraints() {
    var start = el.startDate.value;
    el.dateHint.textContent = '';
    if (!start) {
      el.endDate.min = '';
      return;
    }
    var minEnd = addDays(start, 1);
    el.endDate.min = minEnd;
    // 键盘输入等方式绕过 min 限制时自动纠正
    if (el.endDate.value && el.endDate.value <= start) {
      el.endDate.value = minEnd;
    }
  }

  el.startDate.max = bjDateStr(-1);
  el.endDate.max = bjDateStr(0);

  el.startDate.addEventListener('change', syncDateConstraints);

  // 改结束日期时若与开始日期冲突，把开始日期调到结束前一天
  el.endDate.addEventListener('change', function () {
    var end = el.endDate.value;
    var start = el.startDate.value;
    if (end && start && end <= start) {
      el.startDate.value = addDays(end, -1);
    }
    syncDateConstraints();
  });

  document.getElementById('applyCustom').addEventListener('click', function () {
    var start = el.startDate.value;
    var end = el.endDate.value;
    if (!start || !end) {
      el.dateHint.textContent = '请先选择起止日期';
      return;
    }
    if (end <= start) {
      el.dateHint.textContent = '结束日期必须晚于开始日期';
      return;
    }
    el.dateHint.textContent = '';
    render();
  });

  // 窗口尺寸变化时重算标签截断和刻度密度（原实现只在首次渲染时判断一次）
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (state.reports.length) drawChart();
    }, 200);
  });

  // 轮询：页面不可见时暂停，回到前台立即刷新
  var pollTimer = null;

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(load, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      load();
      startPolling();
    } else {
      stopPolling();
    }
  });

  bindLegendToggle();
  load().then(startPolling);
})();
<\/script>
</body>
</html>`;

const MAIN_HTML_ETAG = '"' + fnv1a(MAIN_HTML) + '"';

function serveMain(request) {
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch && ifNoneMatch === MAIN_HTML_ETAG) {
    return new Response(null, {
      status: 304,
      headers: baseHeaders({ ETag: MAIN_HTML_ETAG, 'Cache-Control': 'no-cache' }),
    });
  }
  return new Response(MAIN_HTML, {
    headers: baseHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      // HTML 内容随代码版本变化，用 ETag 协商，避免每次都全量重传
      'Cache-Control': 'no-cache',
      ETag: MAIN_HTML_ETAG,
      'X-Frame-Options': 'DENY',
    }),
  });
}

// 导出纯函数供单元测试使用（不影响 Worker 运行时）
export {
  bjDate,
  bjDateTime,
  normalizeDate,
  normalizeHour,
  toNumber,
  round2,
  isValidDeviceId,
  maskIp,
  escapeHtml,
  mergeHourly,
  pruneHourly,
  aggregateDaily,
  toPublicView,
  fnv1a,
};
