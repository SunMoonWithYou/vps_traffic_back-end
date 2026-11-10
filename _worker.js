/**
 * Cloudflare Worker - 流量监控面板
 * 环境变量: UPLOAD_KEY
 * KV 绑定: TRAFFIC_KV
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS
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
      // 上报接口
      if (request.method === 'POST' && url.pathname === '/api/upload') {
        return await handleUpload(request, env);
      }

      // Manifest
      if (url.pathname === '/manifest.json') {
        return jsonResponse({
          name: "流量监控面板",
          short_name: "流量监控",
          start_url: "/",
          display: "standalone",
          background_color: "#f8fafc",
          theme_color: "#3b82f6",
          icons: [
            { src: "https://raw.githubusercontent.com/SunMoonWithYou/vps_traffic_back-end/main/vps-traffic-logo-192.png", sizes: "192x192", type: "image/png" },
            { src: "https://raw.githubusercontent.com/SunMoonWithYou/vps_traffic_back-end/main/vps-traffic-logo-512.png", sizes: "512x512", type: "image/png" }
          ]
        });
      }

      // 数据接口
      if (url.pathname === '/api/data') {
        return jsonResponse(await getReports(env));
      }

      // 启动页
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return htmlResponse(splashHTML());
      }

      // 数据页
      if (url.pathname === '/home') {
        return htmlResponse(mainHTML());
      }

      return new Response('Not Found', { status: 404 });
    } catch (e) {
      return new Response('Error: ' + e.message, { status: 500 });
    }
  }
};

async function handleUpload(request, env) {
  const key = request.headers.get('X-Upload-Key');
  if (!env.UPLOAD_KEY || key !== env.UPLOAD_KEY) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const data = await request.json();
  if (!data.host) return jsonResponse({ error: 'Missing host' }, 400);

  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const bj = now.toISOString().replace('T', ' ').slice(0, 19);
  const today = bj.slice(0, 10);
  const kvKey = 'report:' + data.host;

  let existing = null;
  try {
    const raw = await env.TRAFFIC_KV.get(kvKey);
    if (raw) existing = JSON.parse(raw);
  } catch (e) {}

  let hourlyList = (existing && existing.hourly) || [];
  let dailyMap = (existing && existing.daily) || {};

  if (data.hourly && Array.isArray(data.hourly)) {
    for (const h of data.hourly) {
      if (!h.hour) continue;
      const hKey = today + ' ' + h.hour;
      const existIdx = hourlyList.findIndex(x => x.key === hKey);
      const entry = { key: hKey, date: today, hour: h.hour, total_mb: h.total_mb || 0 };
      if (existIdx >= 0) hourlyList[existIdx] = entry;
      else hourlyList.push(entry);
      const dayHours = hourlyList.filter(x => x.date === today);
      dailyMap[today] = dayHours.reduce((sum, x) => sum + (x.total_mb || 0), 0);
    }
    const cutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    hourlyList = hourlyList.filter(x => x.date >= cutoff);
    for (const d of Object.keys(dailyMap)) {
      if (d < cutoff) delete dailyMap[d];
    }
  }

  const report = {
    host: data.host, ip: data.ip, mode: data.mode, type: data.type,
    rx: data.rx, tx: data.tx, yest_gb: data.yest_gb, today_gb: data.today_gb,
    used_gb: data.used_gb, max_gb: data.max_gb, pct: data.pct,
    period_start: data.period_start, period_end: data.period_end,
    reset_day: data.reset_day, time: data.time || bj, updated_bj: bj,
    hourly: hourlyList, daily: dailyMap
  };

  await env.TRAFFIC_KV.put(kvKey, JSON.stringify(report));
  return jsonResponse({ ok: true });
}

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

function splashHTML() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>流量监控</title><link rel="icon" href="https://raw.githubusercontent.com/SunMoonWithYou/vps_traffic_back-end/main/vps-traffic-logo-icon.ico"><style>body{margin:0;background:#f8fafc;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:system-ui,sans-serif}.logo{width:96px;height:96px;border-radius:20px;margin-bottom:16px}.title{font-size:1.3rem;font-weight:600;color:#1e293b}.sub{margin-top:12px;font-size:13px;color:#94a3b8}</style></head><body><img class="logo" src="https://raw.githubusercontent.com/SunMoonWithYou/vps_traffic_back-end/main/vps-traffic-logo-192.png" alt="logo"><div class="title">流量监控面板</div><div class="sub">加载中...</div><script>setTimeout(function(){location.href="/home"},600)</script></body></html>';
}

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
<meta name="theme-color" content="#3b82f6">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"><\/script>
<style>
:root{--bg:#f8fafc;--card:#fff;--border:#e2e8f0;--text:#0f172a;--muted:#64748b;--accent:#3b82f6;--accent-light:#eff6ff}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:linear-gradient(180deg,#f1f5f9 0%,#f8fafc 100%);color:var(--text);margin:0;padding:24px;min-height:100vh}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;flex-wrap:wrap;gap:16px}
h1{margin:0;font-size:1.5rem;font-weight:700;background:linear-gradient(135deg,#1e40af,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.tabs{display:flex;gap:2px;background:#fff;padding:4px;border-radius:14px;border:1px solid var(--border);box-shadow:0 1px 3px rgba(0,0,0,.05)}
.tab{padding:8px 16px;border-radius:10px;cursor:pointer;font-size:13px;color:var(--muted);font-weight:500;transition:all .2s}
.tab:hover{background:var(--accent-light);color:var(--accent)}
.tab.active{background:var(--accent);color:#fff;box-shadow:0 2px 4px rgba(59,130,246,.3)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px}
.stat{background:var(--card);border-radius:16px;padding:20px;border:1px solid var(--border);box-shadow:0 1px 3px rgba(0,0,0,.04);transition:transform .2s,box-shadow .2s}
.stat:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,.08)}
.stat .label{font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.stat .value{font-size:1.8rem;font-weight:700;margin-top:8px;color:var(--text)}
.stat .value small{font-size:.9rem;font-weight:500;color:var(--muted)}
.stat .sub{font-size:12px;color:var(--muted);margin-top:6px}
.stat .detail{font-size:12px;color:#64748b;margin-top:12px;padding-top:12px;border-top:1px solid #f1f5f9;display:flex;gap:12px}
.chart-box{background:var(--card);border-radius:16px;padding:24px 24px 60px;border:1px solid var(--border);margin-bottom:24px;height:420px;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.chart-box canvas{width:100%!important;height:100%!important}
.servers{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.server{background:var(--card);border-radius:16px;padding:18px 20px;border:1px solid var(--border);cursor:pointer;transition:all .2s;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.server:hover{border-color:#93c5fd;transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,.08)}
.server.active{border-color:var(--accent);box-shadow:0 0 0 3px rgba(59,130,246,.15),0 4px 12px rgba(0,0,0,.06)}
.server h3{margin:0 0 10px;font-size:1.05rem;font-weight:600;color:var(--text)}
.server .ip{font-size:12px;color:var(--muted);font-family:ui-monospace,monospace}
.server .usage{font-size:15px;font-weight:600;margin:8px 0;color:var(--text)}
.progress{height:10px;background:#e2e8f0;border-radius:5px;margin:12px 0;overflow:hidden}
.progress>div{height:100%;border-radius:5px;transition:width .4s ease}
.server .meta{font-size:12px;color:var(--muted);display:flex;justify-content:space-between}
#customBox{display:none;margin-bottom:20px;padding:14px 18px;background:#fff;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.04)}
@media(max-width:640px){
  body{padding:16px}
  h1{font-size:1.25rem}
  .header{flex-direction:column;align-items:flex-start;gap:14px}
  .tabs{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;padding:3px}
  .tab{padding:7px 12px;font-size:12px}
  .chart-box{height:320px;padding:16px 16px 70px}
  .servers{grid-template-columns:1fr;gap:12px}
  .stat{padding:16px}
  .stat .value{font-size:1.4rem}
  .server{padding:16px}
}
</style>
</head>
<body>
<div class="header">
  <h1>流量监控面板</h1>
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
  <span style="font-size:13px;color:#64748b">从</span>
  <input type="date" id="startDate" style="padding:5px;border:1px solid #e2e8f0;border-radius:6px">
  <span style="color:#94a3b8">至</span>
  <input type="date" id="endDate" style="padding:5px;border:1px solid #e2e8f0;border-radius:6px">
  <button id="applyCustom" style="background:#3b82f6;color:#fff;border:none;padding:5px 12px;border-radius:6px;cursor:pointer">应用</button>
</div>
<div class="stats" id="stats"></div>
<div class="chart-box">
  <div id="desc" style="font-size:13px;color:#94a3b8;margin-bottom:8px"></div>
  <canvas id="chart"></canvas>
</div>
<div class="servers" id="servers"></div>
<script>
var reports=[], range='today', chart=null, selectedHosts=[];

fetch('/api/data').then(function(r){return r.json()}).then(function(d){
  reports=d||[];
  render();
}).catch(function(){
  document.getElementById('servers').innerHTML='<div style="padding:20px;color:#94a3b8">加载失败</div>';
});

function maskIP(ip){
  if(!ip||ip==='-')return '-';
  var p=String(ip).split('.');
  return p.length===4?p[0]+'.'+p[1]+'.*.*':ip;
}
function gb(v){
  if(v==null||v==='-'||v==='')return '-';
  var n=parseFloat(v);
  return isNaN(n)?v:n.toFixed(2);
}
function render(){
  var html='';
  for(var i=0;i<reports.length;i++){
    var s=reports[i], p=parseInt(s.pct)||0;
    var active=selectedHosts.indexOf(s.host)>=0?' active':'';
    var color = p>=90?'#ef4444':p>=70?'#f97316':p>=50?'#eab308':'#22c55e';
    html+='<div class="server'+active+'" data-host="'+encodeURIComponent(s.host||'')+'"><h3>'+(s.host||'未知')+'</h3><div class="ip">'+maskIP(s.ip)+'</div><div class="usage">'+gb(s.used_gb)+' / '+gb(s.max_gb)+' GB</div><div class="progress"><div style="width:'+Math.min(p,100)+'%;background:'+color+'"></div></div><div class="meta"><span style="color:'+color+';font-weight:600">'+p+'%</span><span>重置'+(s.reset_day||'-')+'号</span></div></div>';
  }
  document.getElementById('servers').innerHTML=html;
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
function showStats(){
  var list=selectedHosts.length?reports.filter(function(r){return selectedHosts.indexOf(r.host)>=0}):reports;
  var used=0,max=0,today=0,rx=0,tx=0;
  for(var i=0;i<list.length;i++){
    var r=list[i];
    used+=parseFloat(r.used_gb)||0;
    max+=parseFloat(r.max_gb)||0;
    today+=parseFloat(r.today_gb)||0;
    rx+=parseFloat(String(r.rx||'0').replace(/[^0-9.]/g,''))||0;
    tx+=parseFloat(String(r.tx||'0').replace(/[^0-9.]/g,''))||0;
  }
  var pct=max>0?Math.round(used/max*100):0;
  var title=selectedHosts.length===0?'全部':(selectedHosts.length===1?selectedHosts[0]:selectedHosts.length+'台');
  document.getElementById('stats').innerHTML='<div class="stat"><div class="label">当前</div><div class="value" style="font-size:1rem">'+title+'</div></div><div class="stat"><div class="label">今日</div><div class="value">'+today.toFixed(2)+'<small>GB</small></div><div class="detail">↑'+tx.toFixed(1)+' ↓'+rx.toFixed(1)+'</div></div><div class="stat"><div class="label">累计</div><div class="value">'+used.toFixed(1)+'<small>GB</small></div><div class="sub">限额'+max.toFixed(0)+'</div></div><div class="stat"><div class="label">进度</div><div class="value" style="color:'+(pct>=80?'#ef4444':'#22c55e')+'">'+pct+'%</div></div>';
}
function drawChart(){
  var colors=['#22c55e','#3b82f6','#f97316','#a855f7','#ef4444','#06b6d4'];
  var datasets=[], labels=[];
  var now=new Date(Date.now()+8*3600*1000);
  var today=now.toISOString().slice(0,10);
  var yesterday=new Date(now.getTime()-86400000).toISOString().slice(0,10);
  var nowH=now.getUTCHours();
  var labelBuilt=false;

  for(var i=0;i<reports.length;i++){
    var r=reports[i];
    if(selectedHosts.length&&selectedHosts.indexOf(r.host)<0)continue;
    var hourly=r.hourly||[], values=[];
    if(range==='today'||range==='yesterday'){
      var td=range==='today'?today:yesterday;
      var map={};
      for(var j=0;j<hourly.length;j++){
        var h=hourly[j];
        if(h.date===td&&h.hour){
          var n=parseInt(h.hour.split(':')[0],10);
          var k=(n<10?'0':'')+n+':00';
          map[k]=(h.total_mb||0)/1024;
        }
      }
      var maxH=range==='today'?nowH:23;
      if(!labelBuilt){for(var x=0;x<=maxH;x++)labels.push((x<10?'0':'')+x+':00');labelBuilt=true;}
      for(var x=0;x<=maxH;x++){var hh=(x<10?'0':'')+x+':00';values.push(map[hh]!=null?+map[hh].toFixed(3):0);}
    }else{
      var daily=r.daily||{};
      if(!Object.keys(daily).length){
        for(var j=0;j<hourly.length;j++){var h=hourly[j];if(h.date)daily[h.date]=(daily[h.date]||0)+(h.total_mb||0);}
      }
      var dgb={};
      for(var d in daily)dgb[d]=daily[d]/1024;
      if(range==='custom'){
        var s=document.getElementById('startDate').value, e=document.getElementById('endDate').value;
        var f={};for(var d in dgb){if((!s||d>=s)&&(!e||d<=e))f[d]=dgb[d];}dgb=f;
      }
      var dates=Object.keys(dgb).sort();
      if(range==='7d')dates=dates.slice(-7);
      if(range==='30d')dates=dates.slice(-30);
      if(!labelBuilt){labels=dates.length?dates:['暂无'];labelBuilt=true;}
      for(var k=0;k<dates.length;k++)values.push(+(dgb[dates[k]]||0).toFixed(2));
      if(!dates.length)values=[0];
    }
    var name=r.host||('服务器'+(i+1));
    if(window.innerWidth<640&&name.length>10)name=name.slice(0,8)+'..';
    datasets.push({label:name,data:values,borderColor:colors[i%colors.length],backgroundColor:colors[i%colors.length]+'22',fill:true,tension:0.3,pointRadius:2});
  }
  var titles={today:'今天',yesterday:'昨天','7d':'近7天','30d':'近30天',all:'全部',custom:'自定义'};
  document.getElementById('desc').textContent=(titles[range]||'')+' · '+(selectedHosts.length?selectedHosts.length+'台':'全部');
  if(chart)chart.destroy();
  var ctx=document.getElementById('chart');
  if(!ctx)return;
  chart=new Chart(ctx,{type:'line',data:{labels:labels,datasets:datasets},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},plugins:{legend:{display:true,position:'bottom',labels:{color:'#64748b',boxWidth:8,padding:6,font:{size:window.innerWidth<640?8:11}}}},tooltip:{mode:'index',intersect:false},scales:{y:{beginAtZero:true,ticks:{color:'#64748b'},grid:{color:'#e2e8f0'}},x:{ticks:{color:'#64748b',maxRotation:0,autoSkip:true,maxTicksLimit:window.innerWidth<640?6:12},grid:{color:'#e2e8f0'}}}}});
}
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
setTimeout(function(){location.reload()},300000);
<\/script>
</body>
</html>`;
}
