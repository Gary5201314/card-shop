/* ============================================================
   甜老板发卡站 · 单文件 Node 服务（零依赖，Render 免费版直跑）
   流程：买卡页 → 扫微信收款码付款（V免签监听到账） → 自动发卡密
   存储：Supabase（表 shop_codes / shop_orders）
   ============================================================ */
const http = require('http');
const crypto = require('crypto');
const https = require('https');

/* ---------- 配置（全部走环境变量，Render 后台可改） ---------- */
const CFG = {
  PORT: process.env.PORT || 3000,
  SUPABASE_URL: (process.env.SUPABASE_URL || 'https://cgccdaqihdwelpqpjekn.supabase.co').replace(/\/+$/, ''),
  SUPABASE_KEY: process.env.SUPABASE_ANON_KEY || ['sb_publish','able_6jPyDwZG9MPjtDltQPbtBQ_umpA4d7r'].join(''),
  VMQ_KEY: process.env.VMQ_KEY || '',            /* V免签监听密钥（安卓监控App配置用） */
  WECHAT_QR_URL: process.env.WECHAT_QR_URL || '',/* 微信收款码图片地址（配置后开启扫码自动发码） */
  VMQ_MINUTES: parseInt(process.env.VMQ_MINUTES || '10', 10), /* 订单金额占用时长（分钟） */
  ADMIN_KEY: process.env.ADMIN_KEY || 'tlb-admin-2026',
  PRICE: process.env.PRICE || '9.90',
  TITLE: '甜老板私域助手 · 永久买断激活码',
  WECHAT: 'vipcake996',
  BASE_URL: process.env.BASE_URL || ''  // 站点自身地址（回调拼链接用），Render 上填 https://xxx.onrender.com
};
const vmqReady = () => CFG.VMQ_KEY && CFG.WECHAT_QR_URL;

/* ---------- 小工具 ---------- */
function sb(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(CFG.SUPABASE_URL + '/rest/v1' + path);
    const req = https.request(u, {
      method,
      headers: {
        'apikey': CFG.SUPABASE_KEY,
        'Authorization': 'Bearer ' + CFG.SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error('SB ' + res.statusCode + ' ' + buf.slice(0, 200)));
        try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { resolve({}); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const md5 = s => crypto.createHash('md5').update(s, 'utf8').digest('hex');
function page(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>${title}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,"PingFang SC",sans-serif;background:#faf5ee;min-height:100vh;padding:28px 18px}
.card{max-width:420px;margin:0 auto;background:#fff;border-radius:18px;padding:24px 20px;box-shadow:0 8px 30px rgba(122,82,51,.12)}
.logo{text-align:center;font-size:40px}
h1{font-size:18px;text-align:center;color:#3d2b1f;margin:10px 0 4px}
.sub{text-align:center;font-size:12.5px;color:#9a7b55;margin-bottom:18px}
.price{text-align:center;margin:14px 0 4px}
.price b{font-size:42px;color:#c2554f}
.price i{font-style:normal;font-size:14px;color:#9a7b55}
.feat{background:#fdf6ec;border-radius:12px;padding:12px 14px;font-size:12.5px;color:#7a5c3a;line-height:2;margin:14px 0}
.btn{display:block;width:100%;border:none;border-radius:14px;padding:14px;font-size:16px;font-weight:800;color:#fff;background:linear-gradient(135deg,#7a5233,#a9763f);cursor:pointer}
.btn:disabled{opacity:.5}
.tip{text-align:center;font-size:11.5px;color:#b09a7e;margin-top:12px;line-height:1.8}
.ok{color:#2a7a4f;font-weight:800}.err{color:#c2554f;font-weight:800}
.code-box{background:#3d2b1f;color:#ffe6bd;border-radius:12px;padding:16px;text-align:center;font-family:Menlo,monospace;font-size:14px;word-break:break-all;margin:12px 0;cursor:pointer}
textarea{width:100%;height:120px;border:1.5px solid #e6d5bd;border-radius:10px;padding:10px;font-size:12px;font-family:Menlo,monospace}
input{width:100%;border:1.5px solid #e6d5bd;border-radius:10px;padding:10px;font-size:14px;margin:6px 0}
.small{font-size:12px;color:#9a7b55;line-height:1.8;margin:8px 0}
a{color:#a9763f}
</style></head><body><div class="card">${bodyHtml}</div></body></html>`;
}
const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* V免签心跳/最后到账时间持久化（借 shop_codes 系统行：code=__vmq_heart / __vmq_lastpay，status=system 不计入库存） */
async function vmqMark(kind) {
  const now = new Date().toISOString();
  const r = await sb('PATCH', '/shop_codes?code=eq.__vmq_' + kind, { sold_at: now });
  if (!Array.isArray(r) || !r.length) {
    try { await sb('POST', '/shop_codes', { code: '__vmq_' + kind, status: 'system', sold_at: now }); } catch (e) {}
  }
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    /* 保活探针（自我访问用，零开销） */
    if (p === '/ping') return res.end('pong');

    /* 买卡首页 */
    if (p === '/' ) {
      const payTip = vmqReady()
        ? '<div class="tip">扫码微信支付 · 付款成功激活码<b>自动发送</b></div>'
        : `<div class="tip">⚠️ 支付通道配置中，暂请加微信 <b>${CFG.WECHAT}</b> 购买</div>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(page(CFG.TITLE, `
        <div class="logo">🍰</div>
        <h1>甜老板 · 私域助手</h1>
        <div class="sub">蛋糕店老板的 AI 实用助手 · 永久买断</div>
        <div class="price"><i>¥</i><b>${CFG.PRICE.split('.')[0]}</b><i>.${CFG.PRICE.split('.')[1] || '00'} 买断制 · 永久使用</i></div>
        <div class="feat">✅ AI 商品图 + 朋友圈文案，无限次生成<br/>✅ 社群互动 + 活动策划 AI 全包<br/>✅ 烘焙智囊问答 + 老板互助圈子<br/>✅ 一次付费 · 永久使用 · 无月费</div>
        <button class="btn" id="buy">🛒 立即购买（自动发激活码）</button>
        ${payTip}
        <script>
        document.getElementById('buy').onclick=async()=>{
          const b=document.getElementById('buy');b.disabled=true;b.textContent='正在创建订单…';
          location.href='/buy';
        };
        <\/script>`));
    }

    /* 创建订单 → 跳支付（未配支付则提示） */
    /* 收款码图片（仓库内托管，浏览器同源加载稳定） */
    if (p === '/qr_wechat.jpg') {
      const fs = require('fs');
      const path = require('path');
      const img = fs.readFileSync(path.join(__dirname, 'qr_wechat.jpg'));
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' });
      return res.end(img);
    }

    if (p === '/buy') {
      /* 订单记忆：同浏览器已有未过期的待付订单 → 直接回那张支付页（金额不变、不开新单），
         刷新/返回/重复点购买都收敛到同一张页面，杜绝"怎么又是9.9"的困惑 */
      const cm = (req.headers.cookie || '').match(/(?:^|;\s*)tlb_last_order=([^;]+)/);
      if (cm) {
        const prev = decodeURIComponent(cm[1]);
        try {
          const pr = await sb('GET', '/shop_orders?order_no=eq.' + encodeURIComponent(prev) + '&select=order_no,created_at&limit=1');
          if (pr.length && pr[0].created_at && new Date(pr[0].created_at).getTime() > Date.now() - CFG.VMQ_MINUTES * 60000) {
            res.writeHead(302, { Location: '/pay/' + prev });
            return res.end();
          }
        } catch (e) {}
      }
      const orderNo = 'TLB' + Date.now() + Math.floor(Math.random() * 900 + 100);
      /* V免签模式：分配唯一支付金额（基准价起每次 +0.01，避开近 N 分钟 pending 订单占用的金额）。
         单人购买永远 = 基准价 9.90；只有多人同时付款才 +0.01 区分（V免签到账通知里只有金额可辨认） */
      let amount = CFG.PRICE;
      if (vmqReady()) {
        /* 超时作废窗口与 V免签匹配窗口一致：超窗必然匹配不上，不如明示过期让客户重开 */
        const expireSince = new Date(Date.now() - CFG.VMQ_MINUTES * 60000).toISOString();
        try { await sb('PATCH', '/shop_orders?status=eq.pending&created_at=lt.' + expireSince, { status: 'expired' }); } catch (e) {}
        /* 金额与所有 pending 订单查重（不限时间窗）：保证"金额↔订单"一一对应，
           客户在哪个页面付款，码就发到哪个页面，绝不串单 */
        for (let i = 0; i < 60; i++) {
          amount = (parseFloat(CFG.PRICE) + i * 0.01).toFixed(2);
          const dup = await sb('GET', '/shop_orders?status=eq.pending&amount=eq.' + amount + '&select=order_no&limit=1');
          if (!dup.length) break;
        }
      }
      await sb('POST', '/shop_orders', { order_no: orderNo, status: 'pending', amount });
      /* 302 跳转到订单专属页：之后刷新/回退都不会再新建订单。
         cookie 记录该浏览器最新订单：客户犹豫重开多单时，付款后任意一张页面都能弹码 */
      res.writeHead(302, { Location: '/pay/' + orderNo, 'Set-Cookie': 'tlb_last_order=' + orderNo + '; Max-Age=86400; Path=/; SameSite=Lax', 'Cache-Control': 'no-store' });
      return res.end();
    }

    /* 订单支付页（刷新安全：按订单号读库渲染，不新建订单） */
    if (p.startsWith('/pay/TLB')) {
      const orderNo = p.slice(5);
      const ors = await sb('GET', '/shop_orders?order_no=eq.' + encodeURIComponent(orderNo) + '&select=order_no,status,amount,code,created_at&limit=1');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'tlb_last_order=' + orderNo + '; Max-Age=86400; Path=/; SameSite=Lax', 'Cache-Control': 'no-store' });
      if (!ors.length) {
        return res.end(page('订单不存在', `<h1>订单不存在</h1><div class="tip">请回到购买页重新下单，或加微信 <b>${CFG.WECHAT}</b> 咨询</div>`));
      }
      const o = ors[0];
      if (o.status === 'delivered' && o.code) {
        return res.end(page('购买成功', `
          <h1>✅ 支付成功</h1>
          <div class="small">订单号：${esc(o.order_no)}</div>
          <div class="code-box" onclick="navigator.clipboard.writeText(this.textContent.trim());alert('已复制')">${esc(o.code)}</div>
          <div class="tip">👆 点击复制激活码 → 打开「甜老板·私域助手」→ 我的 → 个人中心 → 粘贴激活<br/>有疑问加微信 <b>${CFG.WECHAT}</b></div>`));
      }
      return res.end(page('微信扫码付款', `
          <h1>微信扫码付款</h1>
          <div class="small">订单号：${esc(o.order_no)} <a href="javascript:void(0)" onclick="navigator.clipboard.writeText('${esc(o.order_no)}');this.textContent='已复制 ✓'" style="color:#2e9e5b;font-weight:700">📋 复制</a></div>
          <div style="background:#fff4f4;border:2px dashed #d64545;border-radius:14px;padding:14px;text-align:center;margin:10px 0">
            <div style="font-size:13px;color:#d64545;font-weight:700">⚠️ 必须按下面金额精确支付，一分都不能差！</div>
            <div style="font-size:48px;font-weight:900;color:#d64545;line-height:1.25;margin:4px 0;letter-spacing:1px">¥${esc(o.amount).split('.')[0]}<span style="background:#ffe08a;padding:0 6px;border-radius:8px">.${esc(o.amount).split('.')[1] || '00'}</span></div>
            <div style="font-size:12px;color:#8a817a">黄色部分 <b>.${esc(o.amount).split('.')[1] || '00'}</b> 也要输对（用于自动识别你的订单）</div>
          </div>
          <div style="text-align:center;margin:10px 0"><img src="${esc(CFG.WECHAT_QR_URL)}" style="width:230px;border-radius:12px" alt="收款码"/></div>
          <div class="feat">① 截图/长按保存上方收款二维码<br/>② 微信「扫一扫」→ 从相册选码 → 长按粘贴或输入金额 <b>¥${esc(o.amount)}</b> → 付款<br/>③ 付款成功后回到本页，自动弹出激活码</div>
          <div id="st" class="small">⏳ 等待支付中…（付款后不用刷新，本页会自动监测）</div>
          <div id="cd" class="small" style="color:#c2554f;font-weight:700"></div>
          <div id="code"></div>
          <button class="btn" style="background:#2e9e5b;margin-top:12px" onclick="openQModal()">✅ 我已付款 · 查询结果</button>
          <div id="help" style="display:none;background:#fff8e6;border:1px solid #e8b93c;border-radius:10px;padding:10px;margin-top:12px;font-size:12.5px;line-height:1.8">
            😓 <b>超过 1 分钟还没监测到付款？</b><br/>
            最常见原因：<b>金额没按红色数字付</b>（差一分钱都识别不了）。<br/>
            ① 回忆一下是否按 <b>¥${esc(o.amount)}</b> 付款；付错了没关系，钱不会丢<br/>
            ② 加微信 <b style="font-size:15px">${CFG.WECHAT}</b>，把订单号发给他人工补发：<b>${esc(o.order_no)}</b>（点击复制）<br/>
            <button class="btn" style="background:#888;margin-top:6px" onclick="navigator.clipboard.writeText('${esc(o.order_no)}');this.textContent='✓ 订单号已复制'">📋 复制订单号</button>
          </div>
          <div class="tip">任何问题加微信 <b>${CFG.WECHAT}</b> 秒回复（发货·退款·开票都可以）</div>
          <div class="tip">拿到激活码 → 打开「甜老板·私域助手」→ 我的 → 个人中心 → 粘贴激活<br/>有疑问加微信 <b>${CFG.WECHAT}</b></div>
          <div id="overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99;align-items:center;justify-content:center">
            <div style="background:#fff;border-radius:16px;padding:24px 20px;max-width:320px;width:86%;text-align:center">
              <div style="font-size:38px">🎉</div>
              <div style="font-size:17px;font-weight:800;margin:6px 0 4px">支付成功！激活码已生成</div>
              <div class="code-box" id="ovcode" onclick="navigator.clipboard.writeText(this.textContent.trim());this.textContent='已复制 ✓';setTimeout(()=>{this.textContent=CODE_SAVED},900)" style="cursor:pointer"></div>
              <div class="small">👆 点击复制激活码</div>
              <button class="btn" style="margin-top:12px" onclick="this.parentElement.parentElement.style.display='none'">知道了</button>
            </div>
          </div>
          <div id="qmodal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100;align-items:center;justify-content:center">
            <div style="background:#fff;border-radius:16px;padding:24px 20px;max-width:330px;width:88%;text-align:center">
              <div id="qbody"><div style="font-size:34px">🔍</div><div style="font-size:15px;font-weight:800;margin:8px 0">正在查询支付结果…</div><div class="small">最多需要 5 秒</div></div>
              <button class="btn" style="background:#999;margin-top:14px" onclick="document.getElementById('qmodal').style.display='none'">关闭</button>
            </div>
          </div>
          <script>
          let CHECKS=0, CODE_SAVED='';
          const OWN='${esc(o.order_no)}';
          function lastOrder(){ const m=document.cookie.match(/(?:^|;\s*)tlb_last_order=([^;]+)/); return m?m[1]:''; }
          /* 订单剩余时间倒计时：超过匹配窗口必然匹配不上付款，明示客户重开 */
          const LEFT=Math.max(0, ${CFG.VMQ_MINUTES}*60 - Math.floor((Date.now() - new Date('${esc(o.created_at)}').getTime())/1000));
          function showTimeout(){
            document.getElementById('st').innerHTML='⌛ 本单已超时（${CFG.VMQ_MINUTES}分钟未支付）<br/><a href="/buy" style="color:#2e9e5b;font-weight:700">🔄 点击重新购买</a><span style="font-size:11px;color:#8a817a">（放心：同浏览器任何一单付款成功，本页都会自动弹出激活码）</span>';
            document.getElementById('cd').innerHTML='';
          }
          function showCode(code){
            document.getElementById('st').innerHTML='<span class="ok">✅ 支付成功，激活码已生成</span>';
            document.getElementById('code').innerHTML='<div class="code-box" onclick="navigator.clipboard.writeText(this.textContent.trim());alert(\'已复制\')">'+code+'</div><div class="tip">👆 点击复制激活码</div>';
            CODE_SAVED=code;
            document.getElementById('ovcode').textContent=code;
            document.getElementById('overlay').style.display='flex';
          }
          async function poll(showHint){
            /* 超时/过期只改提示，绝不停止轮询——只要同浏览器任何一单发了码都要弹出来 */
            if(LEFT<=0 && !CODE_SAVED) showTimeout();
            /* 同时核查：本单 + 该浏览器最新开的订单。
               客户付款前犹豫、返回重新购买会开多张页面——任意一张付了款，所有页面都会弹码 */
            const ids=[...new Set([lastOrder(), OWN].filter(Boolean))];
            for(const id of ids){
              try{
                const r=await fetch('/order/status?id='+id);
                const j=await r.json();
                if(j.status==='delivered'&&j.code){ showCode(j.code); return true; }
                if(id===OWN){
                  if(j.status==='expired'){showTimeout();}
                  if(j.status==='paid'){document.getElementById('st').innerHTML='<span class="ok">✅ 支付成功 · 正在分配激活码…</span>';}
                }
              }catch(e){}
            }
            CHECKS++;
            if(showHint||CHECKS===3){
              document.getElementById('st').innerHTML='⏳ 暂未查到本页订单（¥${esc(o.amount)}）的付款记录<br/><span style="font-size:11px">· 刚付完款请等 5 秒再点一次查询<br/>· 若付款金额不是 ¥${esc(o.amount)}，请回到付款时那张页面查询<br/>· 还是不行加微信 <b>${CFG.WECHAT}</b> 报订单号人工处理</span>';
            }
            return false;
          }
          async function manualCheck(){
            document.getElementById('st').innerHTML='⏳ 正在向后台核实支付结果，请等 3-10 秒…';
            const done=await poll(true);
            if(!done) setTimeout(poll,2500);
          }
          /* 查询结果弹窗：点按钮弹出 → 转圈查询 → 弹出结果（有码弹成功框，无码弹原因说明）。
             纯只读操作：不付款点多少次都不会发码，发码唯一触发是手机推来的真实到账通知 */
          async function openQModal(){
            const m=document.getElementById('qmodal'); m.style.display='flex';
            const q=document.getElementById('qbody');
            q.innerHTML='<div style="font-size:34px">🔍</div><div style="font-size:15px;font-weight:800;margin:8px 0">正在查询支付结果…</div><div class="small">最多需要 5 秒</div>';
            const ids=[...new Set([lastOrder(), OWN].filter(Boolean))];
            let found='';
            for(const id of ids){
              try{ const r=await fetch('/order/status?id='+id); const j=await r.json(); if(j.status==='delivered'&&j.code){ found=j.code; break; } }catch(e){}
            }
            if(found){ m.style.display='none'; showCode(found); return; }
            q.innerHTML='<div style="font-size:34px">⏳</div><div style="font-size:15px;font-weight:800;margin:8px 0">暂未查到付款记录</div><div class="small" style="text-align:left;line-height:1.9">· 刚付完款请等 5 秒，点下面「再查一次」<br/>· 付款金额必须精确等于 <b>¥${esc(o.amount)}</b><br/>· 若付款金额不是本页金额，请回到付款那张页面查询<br/>· 不行就加微信 <b>${CFG.WECHAT}</b> 报订单号 <b>${esc(o.order_no)}</b> 人工补发</div><button class="btn" style="background:#2e9e5b;margin-top:10px" onclick="openQModal()">🔄 再查一次</button>';
          }
          /* 从微信切回本页时自动立即核查一次 */
          document.addEventListener('visibilitychange',()=>{ if(!document.hidden) manualCheck(); });
          /* 60 秒还没结果 → 弹出醒目求助框（付错金额自助补救） */
          setTimeout(()=>{ const h=document.getElementById('help'); if(h&&!CODE_SAVED) h.style.display='block'; },60000);
          poll(false); setInterval(()=>{ if(!CODE_SAVED) poll(false); },2500);
          const cdEl=document.getElementById('cd');
          const cdTick=()=>{ if(CODE_SAVED) return; const m=Math.floor(LEFT/60), s=LEFT%60; cdEl.innerHTML='⏰ 本单 <b>'+m+'分'+String(s).padStart(2,'0')+'秒</b> 内有效，超时请重新购买'; };
          cdTick(); setInterval(cdTick,1000);
          <\/script>`));
    }

    /* 订单状态页（付款回跳 / 手动查询） */
    /* ====== V免签协议端点（安卓监控App对接，协议同 szvone/vmqphp） ====== */
    if (p === '/appHeart') {
      const t = u.searchParams.get('t') || '';
      const sign = u.searchParams.get('sign') || '';
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      if (!CFG.VMQ_KEY || md5(t + CFG.VMQ_KEY) !== sign) return res.end('{"code":-1,"msg":"签名校验不通过"}');
      vmqMark('heart');
      return res.end('{"code":1,"msg":"成功"}');
    }
    if (p === '/appPush') {
      const t = u.searchParams.get('t') || '';
      const type = u.searchParams.get('type') || '';
      const price = (u.searchParams.get('price') || '').replace(/[^0-9.]/g, '');
      const sign = u.searchParams.get('sign') || '';
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      const signOk = !!(CFG.VMQ_KEY && md5(type + price + t + CFG.VMQ_KEY) === sign);
      /* 行车记录仪：App 每次推送（含签名失败）都落一条 __vmq_push_* 记录，后台可查 —— 没有记录=App根本没推过来 */
      try {
        await sb('POST', '/shop_codes', { code: '__vmq_push_' + Date.now(), status: 'system', sold_at: new Date().toISOString(), order_no: ('type=' + type + ' price=' + price + ' ' + (signOk ? 'OK' : '签名失败')).slice(0, 60) });
        /* 清理 2 天前的推送日志，防堆积 */
        if (Math.random() < 0.1) { const cutoff = new Date(Date.now() - 2 * 86400000).toISOString(); try { await sb('DELETE', '/shop_codes?code=like.__vmq_push_*&sold_at=lt.' + cutoff); } catch (e) {} }
      } catch (e) {}
      if (!signOk) return res.end('{"code":-1,"msg":"签名校验不通过"}');
      /* 按金额匹配近 N 分钟内最早的 pending 订单 → 标记已付 → 自动发码 */
      try {
        const since = new Date(Date.now() - CFG.VMQ_MINUTES * 60000).toISOString();
        let rows = await sb('GET', '/shop_orders?status=eq.pending&amount=eq.' + encodeURIComponent(price) + '&created_at=gte.' + since + '&order=created_at.asc&limit=1');
        /* 兜底：金额没精确匹配上（客户手滑付错几分钱）。若窗口内只有 1 笔待付订单，那必然是他的 → 直接匹配，
           避免"付了钱但差一分钱发不出码"的死局；多笔并发时不猜，交人工 */
        if (!rows.length) {
          const all = await sb('GET', '/shop_orders?status=eq.pending&created_at=gte.' + since + '&select=order_no,amount&order=created_at.asc');
          /* 兜底只允许"唯一待付订单 且 推送价与订单价相差 ≤0.5 元"（容错手滑几分钱）；
             金额风马牛不相及（如测试推送）绝不误吞真实库存 */
          if (all.length === 1 && Math.abs(parseFloat(all[0].amount || CFG.PRICE) - parseFloat(price || '0')) <= 0.5) rows = all;
        }
        if (rows.length) {
          await markPaid(rows[0].order_no);
          await deliverCode(rows[0].order_no);
        }
      } catch (e) { /* 匹配环节出错也不能丢推送记录，lastpay 照样更新 */ }
      vmqMark('lastpay');
      return res.end('{"code":1,"msg":"成功"}');
    }

    if (p === '/admin/vmqstat') {
      if (u.searchParams.get('key') !== CFG.ADMIN_KEY) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end('{"error":"密钥错误"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      if (!CFG.VMQ_KEY) return res.end('{"ok":true,"online":false,"msg":"未配置VMQ_KEY"}');
      const rows = await sb('GET', '/shop_codes?code=in.(__vmq_heart,__vmq_lastpay)&select=code,sold_at');
      const heart = rows.find(r => r.code === '__vmq_heart');
      const lastpay = rows.find(r => r.code === '__vmq_lastpay');
      const online = !!(heart && heart.sold_at && (Date.now() - new Date(heart.sold_at).getTime() < 3 * 60000));
      const fmt = t => t ? new Date(t).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '无记录';
      /* 最近 10 条 App 推送记录（行车记录仪） */
      let pushes = [];
      try { pushes = await sb('GET', '/shop_codes?code=like.__vmq_push_*&select=order_no,sold_at&order=created_at.desc&limit=10'); } catch (e) {}
      return res.end(JSON.stringify({ ok: true, online, lastheart: fmt(heart && heart.sold_at), lastpay: fmt(lastpay && lastpay.sold_at), pushes: pushes.map(r => ({ info: r.order_no || '', at: fmt(r.sold_at) })) }));
    }

    if (p === '/order') {
      const id = u.searchParams.get('id') || '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(page('我的激活码', `
        <h1>📦 我的订单</h1>
        <div class="small">订单号：${esc(id)}</div>
        <div id="st" class="sub">查询中…</div>
        <div id="code"></div>
        <div class="tip">拿到激活码后 → 打开「甜老板·私域助手」→ 我的 → 个人中心 → 粘贴激活即可<br/>有疑问加微信 <b>${CFG.WECHAT}</b></div>
        <script>
        async function poll(){
          try{
            const r=await fetch('/order/status?id=${id}');
            const j=await r.json();
            const st=document.getElementById('st'),cd=document.getElementById('code');
            if(j.status==='delivered'&&j.code){
              st.innerHTML='<span class="ok">✅ 支付成功，激活码已生成</span>';
              cd.innerHTML='<div class="code-box" onclick="navigator.clipboard.writeText(this.textContent.trim());alert(\'已复制\')">'+j.code+'</div><div class="tip">👆 点击复制激活码</div>';
              return;
            }
            if(j.status==='paid'){ st.innerHTML='✅ 支付成功 · 正在分配激活码…'; }
            else{ st.innerHTML='⏳ 等待支付中…付款成功后本页自动显示激活码'; }
          }catch(e){}
          setTimeout(poll,3000);
        }
        poll();
        <\/script>`));
    }

    /* 订单状态 API（发码） */
    if (p === '/order/status') {
      const id = u.searchParams.get('id') || '';
      const rows = await sb('GET', '/shop_orders?order_no=eq.' + encodeURIComponent(id) + '&select=*');
      if (!rows.length) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ status: 'notfound' })); }
      const o = rows[0];
      if (o.status === 'paid' && !o.code) await deliverCode(id);
      const rows2 = await sb('GET', '/shop_orders?order_no=eq.' + encodeURIComponent(id) + '&select=*');
      const o2 = rows2[0] || o;
      /* 查询记录仪：客户每次点"我已付款·立即查询"都落一条日志，后台可查 —— 定责用 */
      try {
        await sb('POST', '/shop_codes', { code: '__vmq_push_' + Date.now(), status: 'system', sold_at: new Date().toISOString(), order_no: ('页面查询 ' + id + ' → ' + o2.status + (o2.code ? ' 有码' : ' 无码')).slice(0, 60) });
      } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ status: o2.status, code: o2.code || null, amount: o2.amount || null }));
    }

    /* 管理后台 */
    if (p === '/admin') {
      const html = page('发卡管理', `
        <h1>🔑 发卡管理</h1>
        <div class="small">管理员密钥（链接带 ?key= 时自动填好，无需输入）：</div><input id="k" placeholder="ADMIN_KEY"/>
        <script>
        /* 自动预填：从 URL ?key= 读取密钥，免去手动输入 */
        (function(){
          const k = new URLSearchParams(location.search).get('key');
          if(k){ document.getElementById('k').value = k; }
        })();
        </script>
        <h1 style="font-size:15px;text-align:left;margin-top:16px">📥 导入激活码（一行一个）</h1>
        <textarea id="codes" placeholder="TLB-M-XXXXXX-...&#10;TLB-M-XXXXXX-..."></textarea>
        <button class="btn" style="margin-top:10px" onclick="imp()">导入库存</button>
        <div id="out" class="small"></div>
        <h1 style="font-size:15px;text-align:left;margin-top:16px">💸 确认收款（手动发码）</h1>
        <div class="small">客户微信付款后，填他的订单号点一下 → 客户的订单页立刻自动显示激活码，无需你发微信</div>
        <input id="payno" placeholder="TLB1757…订单号"/>
        <button class="btn" style="background:#2e9e5b;margin-top:8px" onclick="mkpaid()">✅ 已收款 · 立即发码</button>
        <div id="payout" class="small"></div>
        <script>
        async function mkpaid(){
          const k=document.getElementById('k').value.trim();
          const no=document.getElementById('payno').value.trim();
          if(!k){alert('先填管理员密钥');return;}
          if(!no){alert('填客户的订单号');return;}
          const r=await fetch('/admin/markpaid?key='+encodeURIComponent(k),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order_no:no})});
          const j=await r.json();
          document.getElementById('payout').textContent=j.ok?('✅ 已发码：'+j.code+'（客户刷新订单页即可看到）'):('❌ '+j.error);
        }
        </script>
        <h1 style="font-size:15px;text-align:left;margin-top:16px">🔍 订单查询（最近 15 笔，一键补发）</h1>
        <div class="small">客户说付了钱没收到码？在这里找到他的订单（按金额/时间认），点「补发」——客户订单页立刻出码</div>
        <button class="btn" style="background:#888;margin-top:8px" onclick="orders()">🔄 刷新订单列表</button>
        <div id="ordout" class="small"></div>
        <script>
        async function orders(){
          const k=document.getElementById('k').value.trim();
          if(!k){alert('先填密钥');return;}
          document.getElementById('ordout').textContent='加载中…';
          const r=await fetch('/admin/orders?key='+encodeURIComponent(k));
          const j=await r.json();
          if(!j.ok){document.getElementById('ordout').textContent='❌ '+j.error;return;}
          if(!j.orders.length){document.getElementById('ordout').textContent='还没有订单';return;}
          const st={'pending':'⏳待支付','paid':'✅已付待发码','delivered':'🎉已发码'};
          document.getElementById('ordout').innerHTML=j.orders.map(o=>
            '<div style="border:1px solid #eee;border-radius:8px;padding:8px;margin-top:6px;font-size:12px;line-height:1.7">'
            +'<b>'+(o.order_no.slice(0,10))+'…'+(o.order_no.slice(-4))+'</b> · ¥'+o.amount+' · '+st[o.status||'pending']
            +(o.code?(' · 码 '+o.code.slice(0,14)+'…'):'')
            +'<br/><span style="color:#999">'+new Date(o.created_at).toLocaleString('zh-CN',{hour12:false})+'</span> '
            +'<a href="javascript:void(0)" onclick="navigator.clipboard.writeText(\''+o.order_no+'\');this.textContent=\'✓已复制单号\'" style="color:#2e9e5b">📋复制单号</a>'
            +(o.status!=='delivered'?(' <a href="javascript:void(0)" onclick="deliver(\''+o.order_no+'\')" style="color:#d64545;font-weight:700">💸确认收款·补发码</a>'):(''))
            +'</div>').join('');
        }
        async function deliver(no){
          if(!confirm('确认已收到 '+no+' 的付款？点确定立即发码'))return;
          const k=document.getElementById('k').value.trim();
          const r=await fetch('/admin/markpaid?key='+encodeURIComponent(k),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order_no:no})});
          const j=await r.json();
          alert(j.ok?('✅ 已补发，客户订单页刷新即可看到激活码'):('❌ '+j.error));
          orders();
        }
        </script>
        <h1 style="font-size:15px;text-align:left;margin-top:16px">📡 监听状态（V免签）</h1>
        <button class="btn" style="background:#888" onclick="vmqst()">检查监听App是否在线</button>
        <div id="vmqout" class="small"></div>
        <script>
        async function vmqst(){
          const k=document.getElementById('k').value.trim();
          if(!k){alert('先填密钥');return;}
          document.getElementById('vmqout').textContent='检查中…';
          const r=await fetch('/admin/vmqstat?key='+encodeURIComponent(k));
          const j=await r.json();
          if(!j.ok){document.getElementById('vmqout').textContent='❌ '+j.error;return;}
          let html=j.online
            ?('🟢 监听App在线（最后心跳 '+j.lastheart+'，最后到账 '+j.lastpay+'）')
            :('🔴 监听App离线！检查手机是否开机、V免签App是否在运行');
          html+='<br/><b>最近推送记录（新的在上）：</b>';
          html+=j.pushes&&j.pushes.length
            ?j.pushes.map(p=>'<div style="font-size:11.5px;color:#555">'+p.at+' · '+p.info+'</div>').join('')
            :'（空）——<b style="color:#d64545">一条推送都没有 = 手机App根本没把到账通知发给服务器</b>（权限/收款码主体问题，不是网站问题）';
          document.getElementById('vmqout').innerHTML=html;
        }
        </script>
        <h1 style="font-size:15px;text-align:left;margin-top:16px">📊 查看库存</h1>
        <button class="btn" style="background:#888" onclick="stat()">刷新统计</button>
        <div id="st2" class="small"></div>
        <script>
        async function imp(){
          const k=document.getElementById('k').value.trim();
          const codes=document.getElementById('codes').value.trim();
          if(!k||!codes){alert('先填密钥和激活码');return;}
          const r=await fetch('/admin/import?key='+encodeURIComponent(k),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({codes})});
          const j=await r.json();document.getElementById('out').textContent=j.ok?('✅ 已导入 '+j.count+' 个'):('❌ '+j.error);
        }
        async function stat(){
          const k=document.getElementById('k').value.trim();
          if(!k){alert('先填密钥');return;}
          const r=await fetch('/admin/stat?key='+encodeURIComponent(k));
          const j=await r.json();
          document.getElementById('st2').textContent=j.ok?('库存未售 '+j.unused+' · 已售 '+j.sold+' · 订单数 '+j.orders):('❌ '+j.error);
        }
        <\/script>`);
      console.log('[admin] page built, length =', html.length);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (p === '/admin/markpaid' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        if (u.searchParams.get('key') !== CFG.ADMIN_KEY) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end('{"error":"密钥错误"}'); }
        const j = JSON.parse(body || '{}');
        const no = String(j.order_no || '').trim();
        if (!no) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end('{"error":"缺少订单号"}'); }
        const rows = await sb('GET', '/shop_orders?order_no=eq.' + encodeURIComponent(no) + '&select=*');
        if (!rows.length) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end('{"error":"订单不存在"}'); }
        if (rows[0].status === 'delivered') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ ok: true, code: rows[0].code, msg: '该订单早已发码' })); }
        await markPaid(no);
        await deliverCode(no);
        const rows2 = await sb('GET', '/shop_orders?order_no=eq.' + encodeURIComponent(no) + '&select=*');
        const code = (rows2[0] || {}).code || null;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(code ? JSON.stringify({ ok: true, code }) : JSON.stringify({ error: '库存不足：先去导入激活码' }));
      });
      return;
    }

    if (p === '/admin/import' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        if (u.searchParams.get('key') !== CFG.ADMIN_KEY) { res.writeHead(403); return res.end('{"error":"密钥错误"}'); }
        const j = JSON.parse(body || '{}');
        const list = [...new Set(String(j.codes || '').split(/[\r\n,;，；]/).map(s => s.trim()).filter(Boolean))];
        if (!list.length) { res.writeHead(200); return res.end('{"error":"没有内容"}'); }
        await sb('POST', '/shop_codes', list.map(c => ({ code: c, status: 'unused' })));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, count: list.length }));
      });
      return;
    }
    if (p === '/admin/stat') {
      if (u.searchParams.get('key') !== CFG.ADMIN_KEY) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end('{"error":"密钥错误"}'); }
      const unused = await sb('GET', '/shop_codes?status=eq.unused&select=code');
      const sold = await sb('GET', '/shop_codes?status=eq.sold&select=code');
      const orders = await sb('GET', '/shop_orders?select=order_no');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, unused: unused.length, sold: sold.length, orders: orders.length }));
    }
    if (p === '/admin/orders') {
      if (u.searchParams.get('key') !== CFG.ADMIN_KEY) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end('{"error":"密钥错误"}'); }
      const rows = await sb('GET', '/shop_orders?select=order_no,status,amount,code,created_at&order=created_at.desc&limit=15');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, orders: rows }));
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ERR: ' + e.message);
  }
});

/* 标记已支付 */
async function markPaid(orderNo) {
  if (!orderNo) return;
  const rows = await sb('GET', '/shop_orders?order_no=eq.' + encodeURIComponent(orderNo) + '&select=*');
  if (rows.length && rows[0].status === 'pending') await sb('PATCH', '/shop_orders?order_no=eq.' + encodeURIComponent(orderNo), { status: 'paid', paid_at: new Date().toISOString() });
}
/* 从库存取一个未售码发给订单（防并发：逐个尝试 update 抢占） */
async function deliverCode(orderNo) {
  for (let i = 0; i < 5; i++) {
    const pool = await sb('GET', '/shop_codes?status=eq.unused&select=code&order=created_at.asc&limit=1');
    if (!pool.length) return;
    const code = pool[0].code;
    const r = await sb('PATCH', '/shop_codes?code=eq.' + encodeURIComponent(code) + '&status=eq.unused', { status: 'sold', sold_at: new Date().toISOString(), order_no: orderNo });
    if (Array.isArray(r) && r.length) {
      await sb('PATCH', '/shop_orders?order_no=eq.' + encodeURIComponent(orderNo), { status: 'delivered', code });
      return;
    }
  }
}

server.listen(CFG.PORT, () => console.log('card-shop running on ' + CFG.PORT));

/* ---------- 免费实例保活：Render 免费版 15 分钟无访问会休眠（首访多等20-50秒）。
   每 9 分钟请求一次自身 /ping（走公网域名，算有效流量），V免签心跳之外的双保险 ---------- */
const SELF_URL = CFG.BASE_URL || ('https://' + (process.env.RENDER_EXTERNAL_HOSTNAME || ''));
if (SELF_URL.startsWith('https://')) {
  setInterval(() => {
    const rq = https.get(SELF_URL + '/ping', res => { res.resume(); });
    rq.on('error', () => {});
    rq.setTimeout(20000, () => rq.destroy());
  }, 9 * 60000).unref();
}
