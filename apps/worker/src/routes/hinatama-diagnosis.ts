import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { account, api, challenge, deliver, diagnosisPaused, friend, hash, log, messages, now, random, verifiedSignature, type Bindings, type Session } from '../services/hinatama-diagnosis.js';
export type DiagnosisEnv = {Bindings: Bindings};
const app = new Hono<DiagnosisEnv>();
const root='/hinatama/diagnosis';
const cookieName='hinatama_diagnosis';
const receiptCookie=(id:string)=>`${cookieName}_${id.slice(0,16)}`;
const receiptPath=(id:string)=>`${root}/status?attempt=${id}`;
const validId=/^[a-f0-9]{64}$/;
const codes=/^[A-D][1-3]$/;
const rates=new Map<string,{count:number;until:number}>();
app.use(`${root}/*`,async(c,next)=>{
  c.header('Cache-Control','no-store'); c.header('Referrer-Policy','no-referrer'); c.header('X-Content-Type-Options','nosniff');
  c.header('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  const key=await hash(c.req.header('CF-Connecting-IP')||'local');
  const r=rates.get(key); if(r && r.until>now() && r.count>=120) return c.text('しばらくしてからお試しください。',429);
  if (!r || r.until<=now()) rates.set(key,{count:1,until:now()+60}); else r.count++;
  if(rates.size>10000) for(const [k,v] of rates) if(v.until<=now()) rates.delete(k);
  return next();
});
app.get('/health', async c => {
  const a = await account(c.env);
  if (!a) return c.json({ ready: false }, 503);
  const content = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM hinatama_diagnosis_content WHERE line_account_id=?').bind(a.id).first<{n:number}>();
  const paused=await diagnosisPaused(c.env.DB,a.id);
  return c.json({ ready: content?.n === 16&&!paused, contentCount: content?.n ?? 0,paused }, content?.n === 16&&!paused ? 200 : 503);
});
app.get(`${root}/start`,async c=>{
  const a=await account(c.env); if(!a) return c.text('ただいま準備中です。',503);
  if(await diagnosisPaused(c.env.DB,a.id)) return c.text('結果の自動送信はただいま休止中です。LINEでスタッフにご相談ください。',503);
  const code=c.req.query('code')||''; if(!codes.test(code)) return c.text('診断ページからお進みください。',400);
  const content=await c.env.DB.prepare('SELECT messages_json FROM hinatama_diagnosis_content WHERE line_account_id=? AND code=?').bind(a.id,code).first<{messages_json:string}>();
  if(!content) return c.text('ただいま準備中です。',503);
  messages(content.messages_json,c.env.HINATAMA_IMAGE_ORIGIN);
  const state=random(), cookie=random(), verifier=random(), nonce=random(),sid=await hash(state);
  // Remove only expired transient state from this new account, never old-account/customer logs.
  await c.env.DB.prepare('DELETE FROM hinatama_diagnosis_sessions WHERE line_account_id=? AND expires_at<?').bind(a.id,now()-86400).run();
  const created=await c.env.DB.prepare('INSERT INTO hinatama_diagnosis_sessions(id,line_account_id,cookie_hash,code,nonce,verifier,messages_json,expires_at,retry_key,created_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM hinatama_diagnosis_control WHERE line_account_id=? AND is_paused=1)').bind(sid,a.id,await hash(cookie),code,nonce,verifier,content.messages_json,now()+600,crypto.randomUUID(),now(),a.id).run();
  if(!created.meta.changes) return c.text('結果の自動送信はただいま休止中です。LINEでスタッフにご相談ください。',503);
  // Separate browser receipts survive a second visit/back navigation. A single
  // latest-attempt cookie used to make an earlier successful screen show cancelled.
  setCookie(c,receiptCookie(sid),cookie,{path:root,httpOnly:true,secure:true,sameSite:'Lax',maxAge:600});
  const u=new URL('https://access.line.me/oauth2/v2.1/authorize');
  const params={response_type:'code',client_id:c.env.HINATAMA_LOGIN_CHANNEL_ID,redirect_uri:`${c.env.HINATAMA_WORKER_URL}${root}/callback`,state,scope:'profile openid',nonce,bot_prompt:'aggressive',code_challenge:await challenge(verifier),code_challenge_method:'S256',ui_locales:'ja'};
  for(const [k,v] of Object.entries(params)) u.searchParams.set(k,v);
  return c.redirect(u.href,302);
});
app.get(`${root}/callback`,async c=>{
  const a=await account(c.env); if(!a) return c.text('ただいま準備中です。',503);
  if(await diagnosisPaused(c.env.DB,a.id)) return c.text('結果の自動送信はただいま休止中です。LINEでスタッフにご相談ください。',503);
  const state=c.req.query('state')||'';
  if(!validId.test(state)) return c.text('診断ページからもう一度お試しください。',400);
  const sid=await hash(state);
  // Allow only an exact legacy-cookie/session match for attempts already in flight
  // when this release is deployed. Never pick another diagnosis as a fallback.
  const cookie=getCookie(c,receiptCookie(sid))||getCookie(c,cookieName)||'';
  if(!validId.test(cookie)) return c.text('診断ページからもう一度お試しください。',400);
  const ch=await hash(cookie);
  const s=await c.env.DB.prepare('SELECT * FROM hinatama_diagnosis_sessions WHERE id=? AND line_account_id=? AND cookie_hash=?').bind(sid,a.id,ch).first<Session>();
  if(!s||s.expires_at<=now()||s.claimed) return c.text('診断ページからもう一度お試しください。',400);
  const claim=await c.env.DB.prepare('UPDATE hinatama_diagnosis_sessions SET claimed=1 WHERE id=? AND line_account_id=? AND claimed=0').bind(sid,a.id).run();
  if(!claim.meta.changes) return c.text('診断ページからもう一度お試しください。',400);
  if(c.req.query('error')) { await c.env.DB.prepare("UPDATE hinatama_diagnosis_sessions SET status='cancelled',nonce=NULL,verifier=NULL,last_error='authorization_denied' WHERE id=? AND line_account_id=?").bind(sid,a.id).run(); return c.redirect(receiptPath(sid),303); }
  try {
    const code=c.req.query('code'); if(!code || code.length>2048) throw new Error('oauth_error');
    const tokenRes=await api('https://api.line.me/oauth2/v2.1/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:`${c.env.HINATAMA_WORKER_URL}${root}/callback`,client_id:c.env.HINATAMA_LOGIN_CHANNEL_ID,client_secret:c.env.HINATAMA_LOGIN_SECRET,code_verifier:s.verifier})});
    if(!tokenRes.ok) throw new Error('oauth_error');
    const token=await tokenRes.json() as {access_token:string;id_token:string};
    if(!token.id_token||!token.access_token) throw new Error('oauth_error');
    const verifyRes=await api('https://api.line.me/oauth2/v2.1/verify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id_token:token.id_token,client_id:c.env.HINATAMA_LOGIN_CHANNEL_ID,nonce:s.nonce})});
    if(!verifyRes.ok) throw new Error('identity_error');
    const identity=await verifyRes.json() as {iss:string;aud:string;sub:string;exp:number;nonce:string;name?:string};
    if(identity.iss!=='https://access.line.me'||identity.aud!==c.env.HINATAMA_LOGIN_CHANNEL_ID||identity.nonce!==s.nonce||typeof identity.exp!=='number'||identity.exp<=now()||!/^U[a-f0-9]{32}$/.test(identity.sub)) throw new Error('identity_error');
    const followRes=await api('https://api.line.me/friendship/v1/status',{headers:{Authorization:`Bearer ${token.access_token}`}});
    if(!followRes.ok) throw new Error('friendship_error');
    const follow=await followRes.json() as {friendFlag:boolean};
    if(typeof follow.friendFlag!=='boolean') throw new Error('friendship_error');
    await friend(c.env.DB,a,identity.sub,follow.friendFlag,identity.name?.slice(0,200));
    const saved=await c.env.DB.prepare("UPDATE hinatama_diagnosis_sessions SET line_user_id=?,status='awaiting_friend',nonce=NULL,verifier=NULL WHERE id=? AND line_account_id=? AND status!='cancelled'").bind(identity.sub,sid,a.id).run();
    if(saved.meta.changes) await deliver(c.env,a,sid);
  } catch { await c.env.DB.prepare("UPDATE hinatama_diagnosis_sessions SET status='failed',nonce=NULL,verifier=NULL,last_error='login_failed' WHERE id=? AND line_account_id=? AND status!='cancelled'").bind(sid,a.id).run(); }
  return c.redirect(receiptPath(sid),303);
});
async function current(c: Context<DiagnosisEnv>):Promise<Session|null> {
  const a=await account(c.env), id=c.req.query('attempt');
  if(!a) return null;
  if(id!==undefined) {
    if(!validId.test(id)) return null;
    const cookie=getCookie(c,receiptCookie(id))||getCookie(c,cookieName)||'';
    if(!validId.test(cookie)) return null;
    return c.env.DB.prepare('SELECT * FROM hinatama_diagnosis_sessions WHERE id=? AND cookie_hash=? AND line_account_id=? AND expires_at>?').bind(id,await hash(cookie),a.id,now()).first<Session>();
  }
  // Only pre-release receipts used this URL/cookie. New cookies require their
  // explicit attempt ID; an ambiguous URL must not guess the latest session.
  const cookie=getCookie(c,cookieName)||'';
  if(!validId.test(cookie)) return null;
  return c.env.DB.prepare('SELECT * FROM hinatama_diagnosis_sessions WHERE cookie_hash=? AND line_account_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 1').bind(await hash(cookie),a.id,now()).first<Session>();
}
const receiptViews={
  sent:{heading:'結果をLINEに送りました',note:'診断結果の画像と解説を送信しました。下のボタンからLINEのトークでご確認ください。送信ボタンを押す必要はありません。'},
  awaiting_friend:{heading:'あと一歩で、診断結果へ',note:'ヒナタマを友だち追加すると、診断結果の画像と解説が自動で届きます。'},
  cancelled:{heading:'診断結果は、まだ受け取れます',note:'LINEとの連携がまだ完了していません。下のボタンから続けられます。8問への回答をやり直す必要はありません。'},
  failed:{heading:'結果の受け取りを完了できませんでした',note:'下のボタンからもう一度お試しください。8問への回答をやり直す必要はありません。'},
  pending:{heading:'診断結果をLINEへ',note:'LINEとの連携を確認しています。'},
  sending:{heading:'診断結果をLINEへ',note:'診断結果の画像と解説をLINEへ送っています。'}
};
function receiptState(s:Session) {
  const status=s.status in receiptViews?s.status:'pending';
  return {status,canRetry:status==='failed'&&!!s.line_user_id,canReconnect:codes.test(s.code)&&(status==='cancelled'||(status==='failed'&&!s.line_user_id))};
}
app.get(`${root}/status`,async c=>{
  const s=await current(c); if(!s) return c.text('受け取り画面の有効期限が切れました。診断ページからもう一度お試しください。',400);
  const state=receiptState(s),view=receiptViews[state.status as keyof typeof receiptViews];
  if(c.req.query('format')==='json') return c.json(state);
  // LINE accepted is not the same as the recipient having read the message.
  return c.html(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>診断結果をLINEへ｜ヒナタマ熊本</title><style>body{font-family:system-ui,sans-serif;background:#fff7f8;color:#45383e;margin:0;padding:36px 24px}main{max-width:440px;margin:auto}h1{font-size:26px;line-height:1.5}a,button{display:block;background:#ad517b;color:white;border:0;border-radius:8px;padding:18px;text-decoration:none;font-size:17px;width:auto;margin:16px 0;text-align:center}button{width:100%;cursor:pointer}p{line-height:1.8}.secondary{background:transparent;color:#725662;padding:8px;font-size:14px;text-decoration:underline}.detail{font-size:13px;color:#725662;margin-top:28px}[hidden]{display:none!important}</style><main><p>ヒナタマ熊本｜お仕事相談窓口</p><h1 id="heading">${view.heading}</h1><p id="note">${view.note}</p><a id="chat" ${state.status==='sent'?'':'hidden'} href="https://line.me/R/oaMessage/${encodeURIComponent(c.env.HINATAMA_BASIC_ID)}/">LINEのトークで結果を見る</a><a id="add" ${state.status==='awaiting_friend'?'':'hidden'} href="https://line.me/R/ti/p/${encodeURIComponent(c.env.HINATAMA_BASIC_ID)}">友だち追加して結果を受け取る</a><button id="retry" ${state.canRetry?'':'hidden'}>結果をもう一度受け取る</button><a id="reconnect" ${state.canReconnect?'':'hidden'} href="${root}/start?code=${codes.test(s.code)?s.code:'A1'}">LINEに連携して結果を受け取る</a><p id="connection" role="status"></p><a class="secondary" href="https://chat-hinatama.com/lp07/">診断ページに戻る</a><p class="detail">相談・面談の日程は店舗スタッフがご案内します。<a class="secondary" href="https://chat-hinatama.com/privacy/">プライバシーポリシー</a></p></main><script>const views=${JSON.stringify(receiptViews)};let n=0;function show(d){const st=d.status,v=views[st];if(!v)throw Error('status');document.getElementById('heading').textContent=v.heading;document.getElementById('note').textContent=v.note;document.getElementById('chat').hidden=st!=='sent';document.getElementById('add').hidden=st!=='awaiting_friend';document.getElementById('retry').hidden=!d.canRetry;document.getElementById('reconnect').hidden=!d.canReconnect;document.getElementById('connection').textContent='';return st;}async function read(){try{const r=await fetch('${receiptPath(s.id)}&format=json');if(!r.ok)throw Error('request');const st=show(await r.json());if(['pending','sending','awaiting_friend'].includes(st)&&n++<60)setTimeout(read,2000);}catch{document.getElementById('connection').textContent='状況を更新できませんでした。通信を確認してから画面を開き直してください。';}}document.getElementById('retry').onclick=async()=>{const b=document.getElementById('retry');b.disabled=true;try{const r=await fetch('${root}/retry?attempt=${s.id}',{method:'POST'});if(!r.ok)throw Error('retry');await read();}catch{document.getElementById('connection').textContent='受け取りを完了できませんでした。少し時間をおいてもう一度お試しください。';}finally{b.disabled=false;}};read();</script></html>`);
});
app.post(`${root}/retry`,async c=>{
  if(c.req.header('Origin')!==c.env.HINATAMA_WORKER_URL) return c.text('Forbidden',403);
  const a=await account(c.env),s=await current(c); if(!a||!s||!s.line_user_id) return c.text('診断ページからもう一度お試しください。',400);
  if(s.attempted_at && s.attempted_at>now()-15) return c.text('しばらくしてからお試しください。',429);
  await deliver(c.env,a,s.id); return c.json({ok:true});
});
app.post(`${root}/webhook`,async c=>{
  const a=await account(c.env); if(!a) return c.text('Not configured',503);
  const body=await c.req.text(); if(body.length>262144) return c.text('Too large',413);
  if(!await verifiedSignature(body,c.req.header('x-line-signature')||'',a.channel_secret)) return c.text('Invalid signature',401);
  const payload=JSON.parse(body) as {destination:string;events:Array<{type:string;webhookEventId:string;replyToken?:string;source:{type:string;userId:string};message?:{type:string;text?:string;id?:string}}>};
  if(payload.destination!==c.env.HINATAMA_BOT_USER_ID||!Array.isArray(payload.events)) return c.text('Invalid destination',400);
  for(const e of payload.events) {
    if(e.source?.type!=='user'||!/^U[a-f0-9]{32}$/.test(e.source.userId)||!e.webhookEventId||e.webhookEventId.length>128) continue;
    await c.env.DB.prepare("INSERT OR IGNORE INTO hinatama_webhook_events(line_account_id,event_id,status,attempted_at) VALUES(?,?,'pending',0)").bind(a.id,e.webhookEventId).run();
    const inserted=await c.env.DB.prepare("UPDATE hinatama_webhook_events SET status='processing',attempted_at=? WHERE line_account_id=? AND event_id=? AND (status IN ('pending','failed') OR (status='processing' AND attempted_at<?))").bind(now(),a.id,e.webhookEventId,now()-90).run();
    if(!inserted.meta.changes) continue;
    try {
    const f=await friend(c.env.DB,a,e.source.userId,e.type!=='unfollow');
    if(e.type==='follow'||e.type==='unfollow') {
      await c.env.DB.prepare("UPDATE friends SET is_following=?,updated_at=datetime('now') WHERE id=? AND line_account_id=?").bind(e.type==='follow'?1:0,f.id,a.id).run();
      if(e.type==='follow') {
        const waiting=await c.env.DB.prepare("SELECT id FROM hinatama_diagnosis_sessions WHERE line_account_id=? AND line_user_id=? AND status IN ('awaiting_friend','failed','sending') AND expires_at>?").bind(a.id,e.source.userId,now()).all<{id:string}>();
        for(const s of waiting.results) await deliver(c.env,a,s.id);
      }
    } else if(e.type==='message' && e.message) {
      const m=e.message.type==='text'?{type:'text',text:e.message.text?.slice(0,5000)||''}:{type:e.message.type};
      await log(c.env.DB,a,f.id,`hinatama-in:${e.webhookEventId}`,'incoming',m,null);
      const chat=await c.env.DB.prepare('SELECT id FROM chats WHERE friend_id=? AND line_account_id=?').bind(f.id,a.id).first<{id:string}>();
      if(chat) await c.env.DB.prepare("UPDATE chats SET status='unread',last_message_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND line_account_id=?").bind(chat.id,a.id).run();
      else await c.env.DB.prepare("INSERT INTO chats(id,friend_id,line_account_id,status,last_message_at) VALUES(?,?,?,'unread',datetime('now'))").bind(crypto.randomUUID(),f.id,a.id).run();
      const text=e.message.type==='text'?e.message.text?.trim():'';
      const aliases:Record<string,string>={'ヒナタマ収入':'income','ヒナタマ仕事内容':'job','ヒナタマ仕事':'job','ヒナタマ相談':'consultation','ヒナタマ面接':'interview','ヒナタマ面談':'interview'};
      const result=text?.match(/^ヒナタマ診断([A-D][1-3])$/);
      const code=result?.[1] || aliases[text||''];
      if(code&&e.replyToken&&!await diagnosisPaused(c.env.DB,a.id)) {
        const content=await c.env.DB.prepare('SELECT messages_json FROM hinatama_diagnosis_content WHERE line_account_id=? AND code=?').bind(a.id,code).first<{messages_json:string}>();
        if(content) {
          const msgs=messages(content.messages_json,c.env.HINATAMA_IMAGE_ORIGIN);
          const res=await api('https://api.line.me/v2/bot/message/reply',{method:'POST',headers:{Authorization:`Bearer ${a.channel_access_token}`,'Content-Type':'application/json'},body:JSON.stringify({replyToken:e.replyToken,messages:msgs})});
          if(!res.ok) {await c.env.DB.prepare("UPDATE hinatama_webhook_events SET status='reply_failed' WHERE line_account_id=? AND event_id=?").bind(a.id,e.webhookEventId).run();continue;}
          for(let i=0;i<msgs.length;i++) await log(c.env.DB,a,f.id,`hinatama-reply:${e.webhookEventId}:${i}`,'outgoing',msgs[i],'reply');
        }
      }
    }
    await c.env.DB.prepare("UPDATE hinatama_webhook_events SET status='done' WHERE line_account_id=? AND event_id=?").bind(a.id,e.webhookEventId).run();
    } catch {
      await c.env.DB.prepare("UPDATE hinatama_webhook_events SET status='failed' WHERE line_account_id=? AND event_id=?").bind(a.id,e.webhookEventId).run();
      return c.text('Event processing failed',503);
    }
  }
  return c.json({ok:true});
});
export const hinatamaDiagnosis=app;
