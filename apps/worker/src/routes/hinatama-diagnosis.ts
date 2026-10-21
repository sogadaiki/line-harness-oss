import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { collectFunnel, funnelId, parseFunnel, recordReceiptView, linkFunnelFriend, recordFunnelOutcome } from '../services/hinatama-funnel.js';
import { account, api, challenge, deliver, diagnosisPaused, friend, hash, log, messages, now, random, verifiedSignature, type Bindings, type Session } from '../services/hinatama-diagnosis.js';
export type DiagnosisEnv = {Bindings: Bindings;Variables:{bridged:boolean}};
const app = new Hono<DiagnosisEnv>();
const root='/hinatama/diagnosis';
const lpOrigin='https://chat-hinatama.com';
const cookieName='hinatama_diagnosis';
const receiptCookie=(id:string)=>`${cookieName}_${id.slice(0,16)}`;
const validId=/^[a-f0-9]{64}$/;
const codes=/^[A-D][1-3]$/;
const rates=new Map<string,{count:number;until:number}>();
function publicPath(c:Context<DiagnosisEnv>,step:string,params:Record<string,string>={}) {
  if(c.get('bridged')) {
    const u=new URL(c.env.HINATAMA_DIAGNOSIS_PUBLIC_URL!);u.searchParams.set('step',step);
    for(const [key,value] of Object.entries(params))u.searchParams.set(key,value);
    return u.href;
  }
  const query=new URLSearchParams(params).toString();return `${root}/${step}${query?'?'+query:''}`;
}
function callbackUrl(c:Context<DiagnosisEnv>) {return c.get('bridged')?publicPath(c,'callback'):`${c.env.HINATAMA_WORKER_URL}${root}/callback`;}
const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
export function diagnosisRecovery(c:Context<DiagnosisEnv>,note:string,status:400|403|429|503=400,receipt?:string) {
  c.header('Cache-Control','no-store');c.header('Referrer-Policy','no-referrer');c.header('X-Content-Type-Options','nosniff');
  c.header('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  if(c.req.query('format')==='json')return c.json({status:'unavailable',error:'receipt_unavailable'},status);
  const chat=/^@[a-z0-9]+$/.test(c.env.HINATAMA_BASIC_ID||'')?`https://line.me/R/oaMessage/${encodeURIComponent(c.env.HINATAMA_BASIC_ID)}/`:'https://chat-hinatama.com/lp07/';
  return c.html(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LINE結果の受け取り｜ヒナタマ熊本</title><style>body{font-family:system-ui,sans-serif;background:#fff7f8;color:#45383e;margin:0;padding:36px 24px}main{max-width:440px;margin:auto}h1{font-size:26px;line-height:1.5}p{line-height:1.8}a{display:block;background:#ad517b;color:white;padding:18px;margin:18px 0;border-radius:8px;text-decoration:none;text-align:center}.secondary{background:transparent;color:#725662;text-decoration:underline}</style><main><p>ヒナタマ熊本｜お仕事相談窓口</p><h1>診断結果の受け取りを続ける</h1><p>${escape(note)}</p>${receipt?`<a href="${escape(receipt)}">今回の受け取り状況を見る</a>`:''}<a href="https://chat-hinatama.com/lp07/">診断ページに戻る</a><a class="secondary" href="${chat}">LINEでスタッフに相談する</a><p>結果がすでに届いている場合は、LINEのトークから確認できます。</p></main></html>`,status);
}
app.use(`${root}/*`,async(c,next)=>{
  c.set('bridged',false);
  const supplied=c.req.header('X-Hinatama-Bridge-Key');
  if(supplied) {
    const expected=c.env.HINATAMA_BRIDGE_SECRET||'';let difference=supplied.length^expected.length;
    for(let i=0;i<expected.length;i++)difference|=(supplied.charCodeAt(i)||0)^expected.charCodeAt(i);
    let validUrl=false;try{const u=new URL(c.env.HINATAMA_DIAGNOSIS_PUBLIC_URL||'');validUrl=u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname.endsWith('/');}catch{}
    if(!expected||difference||!validUrl)return diagnosisRecovery(c,'接続を確認できませんでした。診断ページからお進みください。',403);
    c.set('bridged',true);
  }
  c.header('Cache-Control','no-store'); c.header('Referrer-Policy','no-referrer'); c.header('X-Content-Type-Options','nosniff');
  c.header('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  // Only this public statistics endpoint accepts cross-origin browser requests.
  // Origin/CORS limits browsers; it does not authenticate anonymous milestones.
  if(c.req.path===`${root}/events` && !c.get('bridged')) {
    const origin=c.req.header('Origin');
    if(origin===lpOrigin){c.header('Access-Control-Allow-Origin',lpOrigin);c.header('Vary','Origin');}
    if(c.req.method==='OPTIONS') {
      const headers=(c.req.header('Access-Control-Request-Headers')||'').toLowerCase().split(',').map(v=>v.trim()).filter(Boolean);
      if(origin!==lpOrigin||c.req.header('Access-Control-Request-Method')!=='POST'||headers.some(v=>v!=='content-type'))return c.json({ok:false},403);
      c.header('Access-Control-Allow-Methods','POST');c.header('Access-Control-Allow-Headers','Content-Type');c.header('Access-Control-Max-Age','600');
      return c.body(null,204);
    }
  }
  const telemetry=c.req.path.endsWith('/events')||c.req.path.endsWith('/view');
  const key=(telemetry?'funnel:':'')+await hash((c.get('bridged')?c.req.header('X-Hinatama-Client-IP'):c.req.header('CF-Connecting-IP'))||'local');
  const r=rates.get(key); if(r && r.until>now() && r.count>=(telemetry?240:120)) return diagnosisRecovery(c,'アクセスが続いているため、少し時間をおいてからお試しください。',429);
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
app.options(`${root}/events`,c=>c.json({ok:false},403));
app.post(`${root}/events`,bodyLimit({maxSize:8192,onError:c=>c.json({ok:false},413)}),async c=>{
  const origin=c.get('bridged')?new URL(c.env.HINATAMA_DIAGNOSIS_PUBLIC_URL!).origin:new URL(c.env.HINATAMA_WORKER_URL).origin;
  if((c.req.header('Origin')!==origin&&(c.get('bridged')||c.req.header('Origin')!==lpOrigin))||c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')return c.json({ok:false},403);
  const a=await account(c.env);if(!a)return c.json({ok:false},503);
  const raw=await c.req.text();if(new TextEncoder().encode(raw).byteLength>8192)return c.json({ok:false},413);
  let value:unknown;try{value=JSON.parse(raw);}catch{return c.json({ok:false},400);}
  const packet=parseFunnel(value,now());if(!packet)return c.json({ok:false},400);
  await collectFunnel(c.env.DB,a.id,packet);return c.json({ok:true});
});
async function startDiagnosis(c:Context<DiagnosisEnv>,code:string,funnel:string|undefined) {
  const a=await account(c.env); if(!a) return diagnosisRecovery(c,'ただいま接続を確認しています。LINEでスタッフにご相談いただけます。',503);
  if(await diagnosisPaused(c.env.DB,a.id)) return diagnosisRecovery(c,'結果の自動送信はただいま休止中です。LINEでスタッフにご相談ください。',503);
  if(!codes.test(code)) return diagnosisRecovery(c,'診断ページからお進みください。');
  const content=await c.env.DB.prepare('SELECT messages_json FROM hinatama_diagnosis_content WHERE line_account_id=? AND code=?').bind(a.id,code).first<{messages_json:string}>();
  if(!content) return diagnosisRecovery(c,'ただいま接続を確認しています。LINEでスタッフにご相談いただけます。',503);
  messages(content.messages_json,c.env.HINATAMA_IMAGE_ORIGIN);
  if(funnel!==undefined&&!funnelId.test(funnel))return diagnosisRecovery(c,'診断ページからお進みください。');
  const state=random(), cookie=random(), verifier=random(), nonce=random(),sid=await hash(state);
  // Remove only expired transient state from this new account, never old-account/customer logs.
  await c.env.DB.prepare('DELETE FROM hinatama_diagnosis_sessions WHERE line_account_id=? AND expires_at<?').bind(a.id,now()-86400).run();
  const created=await c.env.DB.prepare('INSERT INTO hinatama_diagnosis_sessions(id,line_account_id,cookie_hash,code,nonce,verifier,messages_json,expires_at,retry_key,created_at,funnel_attempt_id) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM hinatama_diagnosis_control WHERE line_account_id=? AND is_paused=1)').bind(sid,a.id,await hash(cookie),code,nonce,verifier,content.messages_json,now()+600,crypto.randomUUID(),now(),funnel||null,a.id).run();
  if(!created.meta.changes) return diagnosisRecovery(c,'結果の自動送信はただいま休止中です。LINEでスタッフにご相談ください。',503);
  // Separate browser receipts survive a second visit/back navigation. A single
  // latest-attempt cookie used to make an earlier successful screen show cancelled.
  setCookie(c,receiptCookie(sid),cookie,{path:c.get('bridged')?new URL(c.env.HINATAMA_DIAGNOSIS_PUBLIC_URL!).pathname:root,httpOnly:true,secure:true,sameSite:'Lax',maxAge:600});
  const u=new URL('https://access.line.me/oauth2/v2.1/authorize');
  const params={response_type:'code',client_id:c.env.HINATAMA_LOGIN_CHANNEL_ID,redirect_uri:callbackUrl(c),state,scope:'profile openid',nonce,bot_prompt:'aggressive',code_challenge:await challenge(verifier),code_challenge_method:'S256',ui_locales:'ja'};
  for(const [k,v] of Object.entries(params)) u.searchParams.set(k,v);
  return c.redirect(u.href,c.req.method==='POST'?303:302);
}
app.get(`${root}/start`,c=>startDiagnosis(c,c.req.query('code')||'',c.req.query('funnel')));
app.get(`${root}/callback`,async c=>{
  const a=await account(c.env); if(!a) return diagnosisRecovery(c,'ただいま接続を確認しています。LINEでスタッフにご相談いただけます。',503);
  if(await diagnosisPaused(c.env.DB,a.id)) return diagnosisRecovery(c,'結果の自動送信はただいま休止中です。LINEでスタッフにご相談ください。',503);
  const state=c.req.query('state')||'';
  if(!validId.test(state)) return diagnosisRecovery(c,'認証画面からの接続を確認できませんでした。診断を始めたブラウザからもう一度お進みください。');
  const sid=await hash(state);
  // Allow only an exact legacy-cookie/session match for attempts already in flight
  // when this release is deployed. Never pick another diagnosis as a fallback.
  const cookie=getCookie(c,receiptCookie(sid))||getCookie(c,cookieName)||'';
  if(!validId.test(cookie)) return diagnosisRecovery(c,'認証画面からの接続を確認できませんでした。診断を始めたブラウザからもう一度お進みください。');
  const ch=await hash(cookie);
  const s=await c.env.DB.prepare('SELECT * FROM hinatama_diagnosis_sessions WHERE id=? AND line_account_id=? AND cookie_hash=?').bind(sid,a.id,ch).first<Session>();
  if(!s||s.expires_at<=now())return diagnosisRecovery(c,'接続の有効期限が切れたか、診断を始めたブラウザを確認できませんでした。診断ページからもう一度お進みください。');
  if(s.claimed)return diagnosisRecovery(c,'この認証はすでに受け付けています。今回の受け取り状況を確認できます。',400,publicPath(c,'status',{attempt:sid}));
  const claim=await c.env.DB.prepare('UPDATE hinatama_diagnosis_sessions SET claimed=1 WHERE id=? AND line_account_id=? AND claimed=0').bind(sid,a.id).run();
  if(!claim.meta.changes) return diagnosisRecovery(c,'今回の受け取り状況を確認してください。',400,publicPath(c,'status',{attempt:sid}));
  if(c.req.query('error')) { await c.env.DB.prepare("UPDATE hinatama_diagnosis_sessions SET status='cancelled',nonce=NULL,verifier=NULL,last_error='authorization_denied' WHERE id=? AND line_account_id=?").bind(sid,a.id).run(); return c.redirect(publicPath(c,'status',{attempt:sid}),303); }
  try {
    const code=c.req.query('code'); if(!code || code.length>2048) throw new Error('oauth_error');
    const tokenRes=await api('https://api.line.me/oauth2/v2.1/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:callbackUrl(c),client_id:c.env.HINATAMA_LOGIN_CHANNEL_ID,client_secret:c.env.HINATAMA_LOGIN_SECRET,code_verifier:s.verifier})});
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
    const linkedFriend=await friend(c.env.DB,a,identity.sub,follow.friendFlag,identity.name?.slice(0,200));
    await linkFunnelFriend(c.env.DB,a.id,sid,s.funnel_attempt_id,linkedFriend.id);
    const saved=await c.env.DB.prepare("UPDATE hinatama_diagnosis_sessions SET line_user_id=?,status='awaiting_friend',nonce=NULL,verifier=NULL WHERE id=? AND line_account_id=? AND status!='cancelled'").bind(identity.sub,sid,a.id).run();
    if(saved.meta.changes) await deliver(c.env,a,sid);
  } catch { await c.env.DB.prepare("UPDATE hinatama_diagnosis_sessions SET status='failed',nonce=NULL,verifier=NULL,last_error='login_failed' WHERE id=? AND line_account_id=? AND status!='cancelled'").bind(sid,a.id).run(); }
  return c.redirect(publicPath(c,'status',{attempt:sid}),303);
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
app.post(`${root}/view`,async c=>{
  const origin=c.get('bridged')?new URL(c.env.HINATAMA_DIAGNOSIS_PUBLIC_URL!).origin:new URL(c.env.HINATAMA_WORKER_URL).origin;
  if(c.req.header('Origin')!==origin||!c.req.header('Content-Type')?.startsWith('application/json'))return c.json({ok:false},403);
  const raw=await c.req.text();if(raw.length>100)return c.json({ok:false},400);
  let body:unknown;try{body=JSON.parse(raw);}catch{return c.json({ok:false},400);}
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||!('state' in body)||typeof body.state!=='string'||!Object.hasOwn(receiptViews,body.state))return c.json({ok:false},400);
  const s=await current(c);if(!s)return c.json({ok:false},400);
  // State is observed at the authenticated display report, not a read/delivery/new-friend claim.
  await recordReceiptView(c.env.DB,s.line_account_id,s.id,s.funnel_attempt_id,receiptState(s).status,body.state);return c.json({ok:true});
});
app.get(`${root}/status`,async c=>{
  const s=await current(c); if(!s) return diagnosisRecovery(c,'受け取り画面の有効期限が切れたか、診断を始めたブラウザを確認できませんでした。診断ページからもう一度お進みください。');
  const state=receiptState(s),view=receiptViews[state.status as keyof typeof receiptViews];
  if(c.req.query('format')==='json') return c.json(state);
  // LINE accepted is not the same as the recipient having read the message.
  return c.html(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>診断結果をLINEへ｜ヒナタマ熊本</title><style>body{font-family:system-ui,sans-serif;background:#fff7f8;color:#45383e;margin:0;padding:36px 24px}main{max-width:440px;margin:auto}h1{font-size:26px;line-height:1.5}a,button{display:block;background:#ad517b;color:white;border:0;border-radius:8px;padding:18px;text-decoration:none;font-size:17px;width:auto;margin:16px 0;text-align:center}button{width:100%;cursor:pointer}p{line-height:1.8}.secondary{background:transparent;color:#725662;padding:8px;font-size:14px;text-decoration:underline}.detail{font-size:13px;color:#725662;margin-top:28px}[hidden]{display:none!important}</style><main><p>ヒナタマ熊本｜お仕事相談窓口</p><h1 id="heading">${view.heading}</h1><p id="note">${view.note}</p><a id="chat" ${state.status==='sent'?'':'hidden'} href="https://line.me/R/oaMessage/${encodeURIComponent(c.env.HINATAMA_BASIC_ID)}/">LINEのトークで結果を見る</a><a id="add" ${state.status==='awaiting_friend'?'':'hidden'} href="https://line.me/R/ti/p/${encodeURIComponent(c.env.HINATAMA_BASIC_ID)}">友だち追加して結果を受け取る</a><button id="retry" ${state.canRetry?'':'hidden'}>結果をもう一度受け取る</button><a id="reconnect" ${state.canReconnect?'':'hidden'} href="${escape(publicPath(c,'start',{code:codes.test(s.code)?s.code:'A1',...(s.funnel_attempt_id?{funnel:s.funnel_attempt_id}:{})}))}">LINEに連携して結果を受け取る</a><p id="connection" role="status"></p><button id="refresh" hidden>受け取り状況をもう一度確認する</button><a class="secondary" href="https://line.me/R/oaMessage/${encodeURIComponent(c.env.HINATAMA_BASIC_ID)}/">LINEでスタッフに相談する</a><a class="secondary" href="https://chat-hinatama.com/lp07/">診断ページに戻る</a><p class="detail">相談・面談の日程は店舗スタッフがご案内します。<a class="secondary" href="https://chat-hinatama.com/privacy/">プライバシーポリシー</a></p></main><script>const views=${JSON.stringify(receiptViews)};let n=0,autoOpened=false;const chat=document.getElementById('chat'),openedKey='hinatama-chat:${s.id}';function rememberOpen(){autoOpened=true;try{sessionStorage.setItem(openedKey,'1');}catch{}}chat.onclick=rememberOpen;function openChat(st){if(st!=='sent'||autoOpened||!/iPhone|iPad|iPod|Android/i.test(navigator.userAgent))return;try{if(sessionStorage.getItem(openedKey)){autoOpened=true;return;}}catch{}rememberOpen();document.getElementById('connection').textContent='LINEのトークを開きます。自動で開かない場合は、下のボタンを押してください。';const move=()=>{try{location.assign(chat.href);}catch{}};if(typeof requestAnimationFrame==='function')requestAnimationFrame(()=>requestAnimationFrame(move));else setTimeout(move,0);}let displayedState=null,viewState='${state.status}',viewRetries=0;function reportView(st){viewState=st;if(typeof requestAnimationFrame!=='function')return;requestAnimationFrame(()=>requestAnimationFrame(()=>{if(document.hidden||document.getElementById('heading').hidden)return;if(displayedState===st)return;displayedState=st;fetch('${publicPath(c,'view',{attempt:s.id})}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:st}),keepalive:true}).then(r=>{if(!r.ok)throw Error('measurement');}).catch(()=>{displayedState=null;if(viewRetries++<2)setTimeout(()=>reportView(viewState),1000);});}));}document.addEventListener?.('visibilitychange',()=>{if(!document.hidden)reportView(viewState);});reportView('${state.status}');function show(d){const st=d.status,v=views[st];if(!v)throw Error('status');document.getElementById('heading').textContent=v.heading;document.getElementById('note').textContent=v.note;document.getElementById('chat').hidden=st!=='sent';document.getElementById('add').hidden=st!=='awaiting_friend';document.getElementById('retry').hidden=!d.canRetry;document.getElementById('reconnect').hidden=!d.canReconnect;document.getElementById('connection').textContent='';document.getElementById('heading').setAttribute?.('data-state',st);reportView(st);return st;}async function read(){try{const r=await fetch('${publicPath(c,'status',{attempt:s.id,format:'json'})}');if(!r.ok)throw Error('request');const st=show(await r.json());openChat(st);if(['pending','sending','awaiting_friend'].includes(st)){if(n++<60)setTimeout(read,2000);else{document.getElementById('connection').textContent='確認に時間がかかっています。状況をもう一度確認するか、LINEでスタッフにご相談ください。';document.getElementById('refresh').hidden=false;}}}catch{document.getElementById('connection').textContent='状況を更新できませんでした。通信を確認してから画面を開き直してください。';document.getElementById('refresh').hidden=false;}}document.getElementById('refresh').onclick=()=>location.reload();document.getElementById('retry').onclick=async()=>{const b=document.getElementById('retry');b.disabled=true;try{const r=await fetch('${publicPath(c,'retry',{attempt:s.id})}',{method:'POST'});if(!r.ok)throw Error('retry');await read();}catch{document.getElementById('connection').textContent='受け取りを完了できませんでした。少し時間をおいてもう一度お試しください。';}finally{b.disabled=false;}};read();</script></html>`);
});
app.post(`${root}/retry`,async c=>{
  const origin=c.get('bridged')?new URL(c.env.HINATAMA_DIAGNOSIS_PUBLIC_URL!).origin:c.env.HINATAMA_WORKER_URL;
  if(c.req.header('Origin')!==origin) return c.text('Forbidden',403);
  const a=await account(c.env),s=await current(c); if(!a||!s||!s.line_user_id) return c.text('診断ページからもう一度お試しください。',400);
  if(s.attempted_at && s.attempted_at>now()-15) return c.text('しばらくしてからお試しください。',429);
  await deliver(c.env,a,s.id); return c.json({ok:true});
});
app.post(`${root}/webhook`,async c=>{
  const a=await account(c.env); if(!a) return c.text('Not configured',503);
  const body=await c.req.text(); if(body.length>262144) return c.text('Too large',413);
  if(!await verifiedSignature(body,c.req.header('x-line-signature')||'',a.channel_secret)) return c.text('Invalid signature',401);
  const payload=JSON.parse(body) as {destination:string;events:Array<{type:string;timestamp?:number;follow?:{isUnblocked?:boolean};webhookEventId:string;replyToken?:string;source:{type:string;userId:string};message?:{type:string;text?:string;id?:string}}>};
  if(payload.destination!==c.env.HINATAMA_BOT_USER_ID||!Array.isArray(payload.events)) return c.text('Invalid destination',400);
  for(const e of payload.events) {
    if(e.source?.type!=='user'||!/^U[a-f0-9]{32}$/.test(e.source.userId)||!e.webhookEventId||e.webhookEventId.length>128) continue;
    await c.env.DB.prepare("INSERT OR IGNORE INTO hinatama_webhook_events(line_account_id,event_id,status,attempted_at) VALUES(?,?,'pending',0)").bind(a.id,e.webhookEventId).run();
    const inserted=await c.env.DB.prepare("UPDATE hinatama_webhook_events SET status='processing',attempted_at=? WHERE line_account_id=? AND event_id=? AND (status IN ('pending','failed') OR (status='processing' AND attempted_at<?))").bind(now(),a.id,e.webhookEventId,now()-90).run();
    if(!inserted.meta.changes) continue;
    try {
    const f=await friend(c.env.DB,a,e.source.userId,e.type!=='unfollow');
    if(e.type==='follow'||e.type==='unfollow') {
      const kind=e.type==='unfollow'?'unfollow':e.follow?.isUnblocked===false?'follow':e.follow?.isUnblocked===true?'refollow':'follow_unknown';
      await recordFunnelOutcome(c.env.DB,a.id,f.id,e.webhookEventId,kind,e.timestamp);
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
      // Actual incoming text, including a consultation/intake keyword, is an
      // inquiry. Result-request keywords, stickers and automatic replies are not.
      if(text&&!result)await recordFunnelOutcome(c.env.DB,a.id,f.id,e.webhookEventId,'inquiry',e.timestamp);
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
