/**
 * Cloudflare Worker - VPS 流量监控面板
 * 
 * 环境变量:
 *   UPLOAD_KEY - 上报密钥（请求头 X-Upload-Key）
 * 
 * KV 绑定:
 *   TRAFFIC_KV - 存储各服务器的流量报告
 * 
 * 接口说明:
 *   GET  /             - 启动页（自动跳转 /home）
 *   GET  /home         - 主面板页面
 *   GET  /api/data     - 获取所有服务器数据（带缓存）
 *   POST /api/upload   - 上报数据（需密钥）
 *   GET  /manifest.json- PWA 清单
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 处理 CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Upload-Key',
        }
      });
    }

    try {
      // ========== 上报接口 ==========
      if (request.method === 'POST' && url.pathname === '/api/upload') {
        return await handleUpload(request, env);
      }

      // ========== PWA Manifest ==========
      if (url.pathname === '/manifest.json') {
        return jsonResponse({
          name: "流量监控面板",
          short_name: "流量监控",
          start_url: "/",
          display: "standalone",
          background_color: "#fafafa",
          theme_color: "#0066ff",
          icons: [
            { src: "https://raw.githubusercontent.com/SunMoonWithYou/vps_traffic_back-end/main/vps-traffic-logo-192.png", sizes: "192x192", type: "image/png" },
            { src: "https://raw.githubusercontent.com/SunMoonWithYou/vps_traffic_back-end/main/vps-traffic-logo-512.png", sizes: "512x512", type: "image/png" }
          ]
        });
      }

      // ========== 数据接口（带缓存）==========
      if (url.pathname === '/api/data') {
        const cache = caches.default;
        const cacheKey = new Request(url.origin + '/api/data-cache');

        // 尝试读取缓存
        const cached = await cache.match(cacheKey);
        if (cached) return cached;

        // 缓存未命中，从 KV 读取
        const data = await getReports(env);
        const resp = jsonResponse(data);

        // 写入缓存（30 分钟）
        const toCache = resp.clone();
        toCache.headers.set('Cache-Control', 'public, max-age=1800');
        ctx.waitUntil(cache.put(cacheKey, toCache));

        return resp;
      }

      // ========== 启动页 ==========
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return htmlResponse(splashHTML());
      }

      // ========== 主面板 ==========
      if (url.pathname === '/home') {
        return htmlResponse(mainHTML());
      }

      return new Response('Not Found', { status: 404 });
    } catch (e) {
      return new Response('Error: ' + e.message, { status: 500 });
    }
  }
};

/**
 * 处理数据上报
 * - 验证密钥
 * - 合并小时数据（去重）
 * - 更新日汇总
 * - 清理过期数据
 * - 清空缓存
 */
async function handleUpload(request, env) {
  const key = request.headers.get('X-Upload-Key');
  if (!env.UPLOAD_KEY || key !== env.UPLOAD_KEY) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const data = await request.json();
  if (!data.host) return jsonResponse({ error: 'Missing host' }, 400);

  // 北京时间
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const bj = now.toISOString().replace('T', ' ').slice(0, 19);
  const today = bj.slice(0, 10);
  const kvKey = 'report:' + data.host;

  // 读取现有数据
  let existing = null;
  try {
    const raw = await env.TRAFFIC_KV.get(kvKey);
    if (raw) existing = JSON.parse(raw);
  } catch (e) {}

  let hourlyList = (existing && existing.hourly) || [];
  let dailyMap = (existing && existing.daily) || {};

  // 处理小时数据
  if (data.hourly && Array.isArray(data.hourly)) {
    const touchedDates = new Set();

    for (const h of data.hourly) {
      if (!h.hour) continue;

      const date = h.date || today;
      const hour = h.hour;
      const hKey = h.key || (date + ' ' + hour);

      const entry = {
        key: hKey,
        date: date,
        hour: hour,
        total_mb: Number(h.total_mb) || 0
      };
      if (h.rx_mb != null) entry.rx_mb = Number(h.rx_mb);
      if (h.tx_mb != null) entry.tx_mb = Number(h.tx_mb);

      // 去重：相同 key 则覆盖
      const existIdx = hourlyList.findIndex(x => x.key === hKey);
      if (existIdx >= 0) hourlyList[existIdx] = entry;
      else hourlyList.push(entry);

      touchedDates.add(date);
    }

    // 按时间排序
    hourlyList.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    // 清理过期小时数据（保留 14 天）
    const cutoffHourly = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    hourlyList = hourlyList.filter(x => x.date >= cutoffHourly);

    // 重算本次涉及日期的日汇总
    for (const d of touchedDates) {
      const dayHours = hourlyList.filter(x => x.date === d);
      dailyMap[d] = dayHours.reduce((sum, x) => sum + (Number(x.total_mb) || 0), 0);
    }

    // 清理过期日数据（保留 365 天）
    const cutoffDaily = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    for (const d of Object.keys(dailyMap)) {
      if (d < cutoffDaily) delete dailyMap[d];
    }
  }

  // 组装完整报告
  const report = {
    host: data.host,
    ip: data.ip,
    mode: data.mode,
    type: data.type,
    rx: data.rx,
    tx: data.tx,
    yest_gb: data.yest_gb,
    today_gb: data.today_gb,
    used_gb: data.used_gb,
    max_gb: data.max_gb,
    pct: data.pct,
    period_start: data.period_start,
    period_end: data.period_end,
    reset_day: data.reset_day,
    time: data.time || bj,
    updated_bj: bj,
    hourly: hourlyList,
    daily: dailyMap
  };

  await env.TRAFFIC_KV.put(kvKey, JSON.stringify(report));

  // 上报成功后立即清空缓存
  try {
    const cache = caches.default;
    await cache.delete(new Request(new URL(request.url).origin + '/api/data-cache'));
  } catch (e) {}

  return jsonResponse({ ok: true });
}

/**
 * 从 KV 读取所有服务器报告
 */
async function getReports(env) {
  const list = await env.TRAFFIC_KV.list({ prefix: 'report:' });
  const promises = list.keys.map(item =>
    env.TRAFFIC_KV.get(item.name).then(raw => {
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (e) { return null; }
    })
  );
  const results = await Promise.all(promises);
  const reports = results.filter(r => r);
  reports.sort((a, b) => (a.host || '').localeCompare(b.host || ''));
  return reports;
}

// ========== 工具函数 ==========

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

/** 启动页 HTML */
function splashHTML() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>流量监控</title><link rel="icon" href="https://raw.githubusercontent.com/SunMoonWithYou/vps_traffic_back-end/main/vps-traffic-logo-icon.ico"><style>body{margin:0;background:#fafafa;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:system-ui,sans-serif}.logo{width:96px;height:96px;border-radius:20px;margin-bottom:16px}.title{font-size:1.3rem;font-weight:600;color:#111}.sub{margin-top:12px;font-size:13px;color:#888}</style></head><body><img class="logo" src="https://raw.githubusercontent.com/SunMoonWithYou/vps_traffic_back-end/main/vps-traffic-logo-192.png" alt="logo"><div class="title">流量监控面板</div><div class="sub">加载中...</div><script>setTimeout(function(){location.href="/home"},600)</script></body></html>';
}

/** 主面板 HTML（含完整前端逻辑） */
function mainHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>流量监控</title>
<link rel="icon" href="https://raw.githubusercontent.com/SunMoonWithYou/vps_traffic_back-end/main/vps-traffic-logo-icon.ico">
<link rel="apple-touch-icon" href="https://raw.githubusercontent.com/SunMoonWithYou/vps_traffic_back-end/main/vps-traffic-logo-192.png">
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#0066ff">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"><\/script>
<style>
:root{--bg:#f5f7fa;--card:#fff;--border:#e8eaed;--text:#111;--muted:#6b7280;--accent:#0066ff}
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);margin:0;padding:24px;min-height:100vh}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px;flex-wrap:wrap;gap:16px}
.brand{display:flex;align-items:center;gap:12px}
.brand img{width:40px;height:40px;border-radius:10px}
.brand h1{margin:0;font-size:1.35rem;font-weight:650;letter-spacing:-0.3px;background:linear-gradient(135deg,#0066ff,#4f46e5);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.tabs{display:flex;gap:0;background:#fff;padding:3px;border-radius:12px;border:1px solid var(--border);box-shadow:0 1px 2px rgba(0,0,0,.04)}
.tab{padding:8px 16px;border-radius:9px;cursor:pointer;font-size:13px;color:#666;font-weight:500;transition:all .15s}
.tab:hover{color:#111}
.tab.active{background:#f0f4ff;color:#0066ff;font-weight:600}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:22px}
.stat{background:#fff;border-radius:14px;padding:18px 20px;border:1px solid var(--border);box-shadow:0 1px 3px rgba(0,0,0,.04)}
.stat .label{font-size:12px;color:var(--muted);font-weight:500}
.stat .value{font-size:1.65rem;font-weight:650;margin-top:6px;color:#111}
.stat .value small{font-size:.85rem;font-weight:400;color:var(--muted)}
.stat .sub{font-size:12px;color:var(--muted);margin-top:4px}
.chart-box{background:#fff;border-radius:14px;padding:20px 20px 56px;border:1px solid var(--border);margin-bottom:22px;height:420px;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.chart-box canvas{width:100%!important;height:100%!important}
.servers{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:14px}
.server{background:#fff;border-radius:14px;padding:16px 18px;border:1px solid var(--border);cursor:pointer;transition:all .15s;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.server:hover{border-color:#c7d2fe;box-shadow:0 4px 12px rgba(0,102,255,.08)}
.server.active{border-color:#0066ff;box-shadow:0 0 0 3px rgba(0,102,255,.12)}
.server h3{margin:0 0 4px;font-size:1rem;font-weight:600}
.server .sub{font-size:12px;color:#888;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center}
.server .sub .today{color:#0066ff;font-weight:500}
.server .ip{font-size:11px;color:#aaa;font-family:ui-monospace,monospace;margin-top:2px}
.server .usage{font-size:14px;font-weight:500;margin:8px 0}
.progress{height:6px;background:#f0f0f0;border-radius:3px;margin:10px 0;overflow:hidden}
.progress>div{height:100%;border-radius:3px}
.server .meta{font-size:12px;color:#888;display:flex;justify-content:space-between}
#customBox{display:none;margin-bottom:16px;padding:12px 16px;background:#fff;border:1px solid var(--border);border-radius:12px}
@media(max-width:640px){
  body{padding:16px}
  .brand h1{font-size:1.2rem}
  .header{flex-direction:column;align-items:flex-start;gap:12px}
  .tabs{width:100%;overflow-x:auto}
  .tab{padding:6px 12px;font-size:12px}
  .chart-box{height:320px;padding:14px 14px 60px}
  .servers{grid-template-columns:1fr}
  .stat{padding:14px}
  .stat .value{font-size:1.3rem}
}
</style>
</head>
<body>
<div class="header">
  <div class="brand">
    <img src="https://raw.githubusercontent.com/SunMoonWithYou/vps_traffic_back-end/main/vps-traffic-logo-192.png" alt="logo">
    <h1>流量监控面板</h1>
  </div>
  <div class="tabs" id="tabs">
    <div class="tab active" data-r="today">今天</div>
    <div class="tab" data-r="yesterday">昨天</div>
    <div class="tab" data-r="7d">近7天</div>
    <div class="tab" data-r="30d">近30天</div>
    <div class="tab" data-r="all">全部</div>
    <div class="tab" data-r="custom">自定义</div>
  </div>
</div>
<div id="customBox">
  <span style="font-size:13px;color:#888">从</span>
  <input type="date" id="startDate" style="padding:5px;border:1px solid #eee;border-radius:6px">
  <span style="color:#ccc">至</span>
  <input type="date" id="endDate" style="padding:5px;border:1px solid #eee;border-radius:6px">
  <button id="applyCustom" style="background:#0066ff;color:#fff;border:none;padding:5px 12px;border-radius:6px;cursor:pointer">应用</button>
</div>
<div class="stats" id="stats"></div>
<div class="chart-box">
  <div id="desc" style="font-size:13px;color:#888;margin-bottom:8px"></div>
  <canvas id="chart"></canvas>
</div>
<div class="servers" id="servers"></div>
<script>
// ========== 全局状态 ==========
var reports=[], range='today', chart=null, selectedHosts=[];

// 初始加载数据
fetch('/api/data?t='+Date.now()).then(function(r){return r.json()}).then(function(d){
  reports=d||[];
  render();
}).catch(function(){
  document.getElementById('servers').innerHTML='<div style="padding:20px;color:#888">加载失败</div>';
});

// IP 脱敏
function maskIP(ip){
  if(!ip||ip==='-')return '-';
  var p=String(ip).split('.');
  return p.length===4?p[0]+'.'+p[1]+'.*.*':ip;
}

// 格式化 GB
function gb(v){
  if(v==null||v==='-'||v==='')return '-';
  var n=parseFloat(v);
  return isNaN(n)?'-':n.toFixed(2);
}

// 提取时间（HH:mm）
function formatTime(bj){
  if(!bj) return '';
  var m = bj.match(/(\\d{2}:\\d{2})/);
  return m ? m[1] : '';
}

// 计算今日流量（GB）
function getTodayGB(r){
  var now=new Date(Date.now()+8*3600*1000);
  var todayStr=now.toISOString().slice(0,10);
  if(r.daily && r.daily[todayStr]) return (r.daily[todayStr]/1024).toFixed(2);
  var total=0;
  if(r.hourly){
    for(var i=0;i<r.hourly.length;i++){
      if(r.hourly[i].date===todayStr) total += (r.hourly[i].total_mb||0);
    }
  }
  return (total/1024).toFixed(2);
}

// 渲染整个页面
function render(){
  var html='';
  for(var i=0;i<reports.length;i++){
    var s=reports[i], p=parseInt(s.pct)||0;
    var active=selectedHosts.indexOf(s.host)>=0?' active':'';
    var color=p>=90?'#ef4444':p>=70?'#f97316':p>=50?'#eab308':'#22c55e';
    var today = getTodayGB(s);
    var time = formatTime(s.updated_bj || s.time);

    html+='<div class="server'+active+'" data-host="'+encodeURIComponent(s.host||'')+'">'+
      '<h3>'+(s.host||'未知')+'</h3>'+
      '<div class="sub">'+
        '<span class="today">今日 '+today+' GB</span>'+
        (time ? '<span>'+time+'</span>' : '')+
      '</div>'+
      '<div class="ip">'+maskIP(s.ip)+'</div>'+
      '<div class="usage">'+gb(s.used_gb)+' / '+gb(s.max_gb)+' GB</div>'+
      '<div class="progress"><div style="width:'+Math.min(p,100)+'%;background:'+color+'"></div></div>'+
      '<div class="meta"><span style="color:'+color+';font-weight:600">'+p+'%</span><span>重置'+(s.reset_day||'-')+'号</span></div>'+
    '</div>';
  }
  document.getElementById('servers').innerHTML=html;
  
  // 绑定服务器卡片点击（多选）
  var cards=document.querySelectorAll('.server');
  for(var i=0;i<cards.length;i++){
    cards[i].onclick=function(){
      var h=decodeURIComponent(this.getAttribute('data-host'));
      var idx=selectedHosts.indexOf(h);
      if(idx>=0)selectedHosts.splice(idx,1);else selectedHosts.push(h);
      render();
    };
  }
  showStats();
  drawChart();
}

// 显示顶部统计卡片
function showStats(){
  var list=selectedHosts.length?reports.filter(function(r){return selectedHosts.indexOf(r.host)>=0}):reports;
  var used=0,max=0,todayTotal=0;
  var now=new Date(Date.now()+8*3600*1000);
  var todayStr=now.toISOString().slice(0,10);
  
  for(var i=0;i<list.length;i++){
    var r=list[i];
    used+=parseFloat(r.used_gb)||0;
    max+=parseFloat(r.max_gb)||0;
    if(r.daily&&r.daily[todayStr]){
      todayTotal+=r.daily[todayStr]/1024;
    }else if(r.hourly){
      for(var j=0;j<r.hourly.length;j++){
        if(r.hourly[j].date===todayStr)todayTotal+=(r.hourly[j].total_mb||0)/1024;
      }
    }
  }
  var pct=max>0?Math.round(used/max*100):0;
  var title=selectedHosts.length===0?'全部':(selectedHosts.length===1?selectedHosts[0]:selectedHosts.length+'台');
  document.getElementById('stats').innerHTML='<div class="stat"><div class="label">当前</div><div class="value" style="font-size:1rem">'+title+'</div></div><div class="stat"><div class="label">今日</div><div class="value">'+todayTotal.toFixed(2)+'<small> GB</small></div></div><div class="stat"><div class="label">累计</div><div class="value">'+used.toFixed(2)+'<small> GB</small></div><div class="sub">限额 '+max.toFixed(0)+'</div></div><div class="stat"><div class="label">进度</div><div class="value" style="color:'+(pct>=80?'#ef4444':'#22c55e')+'">'+pct+'%</div></div>';
}

// 绘制图表（支持动态单位 tooltip）
function drawChart(){
  var colors=['#22c55e','#3b82f6','#f97316','#a855f7','#ef4444','#06b6d4'];
  var datasets=[];
  var now=new Date(Date.now()+8*3600*1000);
  var today=now.toISOString().slice(0,10);
  var yesterday=new Date(now.getTime()-86400000).toISOString().slice(0,10);
  var nowH=now.getUTCHours();

  var selected = selectedHosts.length
    ? reports.filter(function(r){return selectedHosts.indexOf(r.host)>=0})
    : reports;

  var labels = [];
  var isHourly = (range==='today'||range==='yesterday');
  var rawValues = []; // 用于判断整体单位（轴用）

  if(isHourly){
    var maxH = range==='today' ? nowH : 23;
    for(var x=0;x<=maxH;x++) labels.push((x<10?'0':'')+x+':00');
  } else {
    var allDates = new Set();
    selected.forEach(function(r){
      var daily = r.daily || {};
      if(!Object.keys(daily).length && r.hourly){
        r.hourly.forEach(function(h){ if(h.date) daily[h.date]=(daily[h.date]||0)+(h.total_mb||0); });
      }
      Object.keys(daily).forEach(function(d){ allDates.add(d); });
    });
    var dates = Array.from(allDates).sort();
    if(range==='custom'){
      var s=document.getElementById('startDate').value, e=document.getElementById('endDate').value;
      dates = dates.filter(function(d){ return (!s||d>=s)&&(!e||d<=e); });
    }
    if(range==='7d') dates = dates.slice(-7);
    if(range==='30d') dates = dates.slice(-30);
    labels = dates.length ? dates : ['暂无'];
  }

  // 收集原始值（单位 GB）
  selected.forEach(function(r){
    var hourly = r.hourly || [];
    if(isHourly){
      var td = range==='today' ? today : yesterday;
      var map = {};
      hourly.forEach(function(h){
        if(h.date===td && h.hour){
          var n = parseInt(h.hour.split(':')[0],10);
          var k = (n<10?'0':'')+n+':00';
          map[k] = (h.total_mb||0)/1024;
        }
      });
      labels.forEach(function(hh){ rawValues.push(map[hh] || 0); });
    } else {
      var daily = r.daily || {};
      if(!Object.keys(daily).length){
        hourly.forEach(function(h){ if(h.date) daily[h.date]=(daily[h.date]||0)+(h.total_mb||0); });
      }
      var dgb = {};
      for(var d in daily) dgb[d] = daily[d]/1024;
      labels.forEach(function(d){ rawValues.push(dgb[d] || 0); });
    }
  });

  // 轴的单位（根据最大值决定）
  var maxVal = Math.max.apply(null, rawValues.concat([0]));
  var unit = 'GB';
  var scale = 1;
  if (maxVal < 1) {
    unit = 'MB';
    scale = 1024;
  } else if (maxVal >= 1000) {
    unit = 'TB';
    scale = 1/1024;
  }

  // 构建 datasets
  selected.forEach(function(r, idx){
    var values = [];
    var hourly = r.hourly || [];

    if(isHourly){
      var td = range==='today' ? today : yesterday;
      var map = {};
      hourly.forEach(function(h){
        if(h.date===td && h.hour){
          var n = parseInt(h.hour.split(':')[0],10);
          var k = (n<10?'0':'')+n+':00';
          map[k] = (h.total_mb||0)/1024;
        }
      });
      labels.forEach(function(hh){
        values.push(+((map[hh] || 0) * scale).toFixed(2));
      });
    } else {
      var daily = r.daily || {};
      if(!Object.keys(daily).length){
        hourly.forEach(function(h){ if(h.date) daily[h.date]=(daily[h.date]||0)+(h.total_mb||0); });
      }
      var dgb = {};
      for(var d in daily) dgb[d] = daily[d]/1024;
      labels.forEach(function(d){
        values.push(+((dgb[d] || 0) * scale).toFixed(2));
      });
    }

    var name = r.host || ('服务器'+(idx+1));
    if(window.innerWidth<640 && name.length>10) name = name.slice(0,8)+'..';

    datasets.push({
      label: name,
      data: values,
      borderColor: colors[idx%colors.length],
      backgroundColor: colors[idx%colors.length]+'22',
      fill: true,
      tension: 0.3,
      pointRadius: 2
    });
  });

  var titles={today:'今天',yesterday:'昨天','7d':'近7天','30d':'近30天',all:'全部',custom:'自定义'};
  document.getElementById('desc').textContent=(titles[range]||'')+' · '+(selectedHosts.length?selectedHosts.length+'台':'全部')+' · 单位：'+unit;

  var ctx = document.getElementById('chart');
  if(!ctx) return;

  var chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: true, position: 'bottom', labels: { color: '#888', boxWidth: 8, padding: 6, font: { size: window.innerWidth<640?8:11 } } },
      tooltip: {
        mode: 'index',
        intersect: false,
        callbacks: {
          // 每个点单独判断单位
          label: function(ctx){
            var valGB = ctx.parsed.y / scale; // 还原成 GB
            var display, unitStr;
            if (valGB < 1) {
              display = (valGB * 1024).toFixed(1);
              unitStr = 'MB';
            } else if (valGB >= 1000) {
              display = (valGB / 1024).toFixed(2);
              unitStr = 'TB';
            } else {
              display = valGB.toFixed(2);
              unitStr = 'GB';
            }
            return ctx.dataset.label + ': ' + display + ' ' + unitStr;
          }
        }
      }
    },
    scales: {
      y: {
        beginAtZero: true,
        ticks: { color: '#888' },
        grid: { color: '#f0f0f0' },
        title: { display: true, text: unit, color: '#888', font: { size: 12 } }
      },
      x: { ticks: { color: '#888', maxRotation: 0, autoSkip: true, maxTicksLimit: window.innerWidth<640?6:12 }, grid: { color: '#f0f0f0' } }
    }
  };

  if(chart){
    chart.data.labels = labels;
    chart.data.datasets = datasets;
    chart.options = chartOptions;
    chart.update();
  } else {
    chart = new Chart(ctx, {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: chartOptions
    });
  }
}

// 选项卡切换
document.getElementById('tabs').onclick=function(e){
  var t=e.target.closest('.tab');if(!t)return;
  var tabs=document.querySelectorAll('.tab');
  for(var i=0;i<tabs.length;i++)tabs[i].classList.remove('active');
  t.classList.add('active');
  range=t.getAttribute('data-r');
  document.getElementById('customBox').style.display=range==='custom'?'block':'none';
  render();
};
document.getElementById('applyCustom').onclick=function(){render()};

// 每 60 秒自动刷新
setInterval(function(){
  fetch('/api/data?t='+Date.now()).then(function(r){return r.json()}).then(function(d){
    reports=d||[];
    render();
  });
}, 60000);

// 页面重新可见时刷新
document.addEventListener('visibilitychange', function(){
  if(document.visibilityState==='visible'){
    fetch('/api/data?t='+Date.now()).then(function(r){return r.json()}).then(function(d){
      reports=d||[];
      render();
    });
  }
});
<\/script>
</body>
</html>`;
}
