import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const worker = (await import(pathToFileURL('/tmp/hinatama-worker-test/hinatama-entry.js'))).default;
const uid='U'+'a'.repeat(32), bot='U'+'b'.repeat(32), base='https://receiver.example', path='/hinatama/diagnosis';
const originalFetch=globalThis.fetch;
function fixture() {
  const sql=new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE line_accounts(id TEXT PRIMARY KEY,channel_id TEXT UNIQUE,channel_access_token TEXT,channel_secret TEXT,is_active INTEGER);
    CREATE TABLE friends(id TEXT PRIMARY KEY,line_user_id TEXT UNIQUE,line_account_id TEXT,is_following INTEGER,display_name TEXT,metadata TEXT,updated_at TEXT);
    CREATE TABLE messages_log(id TEXT PRIMARY KEY,friend_id TEXT,direction TEXT,message_type TEXT,content TEXT,delivery_type TEXT);
    CREATE TABLE chats(id TEXT PRIMARY KEY,friend_id TEXT,line_account_id TEXT,status TEXT,last_message_at TEXT,updated_at TEXT);
    INSERT INTO line_accounts VALUES('new','123','new-token','new-secret',1),('old','999','old-token','old-secret',1);`);
  sql.exec(readFileSync(new URL('../../../packages/db/migrations/023_hinatama_diagnosis.sql',import.meta.url),'utf8'));
  sql.exec(readFileSync(new URL('../../../packages/db/migrations/027_hinatama_diagnosis_control.sql',import.meta.url),'utf8'));
  for(const letter of ['A','B','C','D'])for(const n of [1,2,3])sql.prepare('INSERT INTO hinatama_diagnosis_content VALUES(?,?,?)').run('new',letter+n,JSON.stringify([{type:'image',originalContentUrl:`https://images.example/${letter}.jpg`,previewImageUrl:`https://images.example/${letter}.jpg`},{type:'text',text:`type ${letter+n}`} ]));
  sql.prepare('INSERT INTO hinatama_diagnosis_content VALUES(?,?,?)').run('new','interview',JSON.stringify([{type:'text',text:'staff arranges interview'}]));
  const DB={prepare(query){
    const s=sql.prepare(query);let args=[];
    return {
      bind(...a){args=a;return this;},
      async first(){return s.get(...args)||null;},
      async all(){return {results:s.all(...args)};},
      async run(){return {meta:{changes:Number(s.run(...args).changes)}};}
    };
  }};
  const env={DB,HINATAMA_CHANNEL_ID:'123',HINATAMA_LOGIN_CHANNEL_ID:'456',HINATAMA_LOGIN_SECRET:'new-login-secret',HINATAMA_BOT_USER_ID:bot,HINATAMA_BASIC_ID:'@newtest',HINATAMA_WORKER_URL:base,HINATAMA_IMAGE_ORIGIN:'https://images.example'};
  let nonce='',follow=true,pushStatus=200,badIdentity=false;const pushes=[],replies=[];
  globalThis.fetch=async(url,opts={})=>{
    assert.match(String(url),/^https:\/\/api\.line\.me\//);
    if(String(url).endsWith('/token')) {const params=new URLSearchParams(opts.body);assert.equal(params.get('client_id'),'456');assert.equal(params.get('client_secret'),'new-login-secret');assert.equal(params.get('code_verifier').length,64);return Response.json({access_token:'user-token',id_token:'id-token'});}
    if(String(url).endsWith('/verify')) {const params=new URLSearchParams(opts.body);assert.equal(params.get('nonce'),nonce);return Response.json({iss:'https://access.line.me',aud:badIdentity?'999':'456',nonce,sub:uid,exp:Math.floor(Date.now()/1000)+300});}
    if(String(url).endsWith('/status')) {assert.equal(opts.headers.Authorization,'Bearer user-token');return Response.json({friendFlag:follow});}
    if(String(url).endsWith('/push')) {assert.equal(opts.headers.Authorization,'Bearer new-token');assert.equal(JSON.parse(opts.body).to,uid);pushes.push({body:JSON.parse(opts.body),key:opts.headers['X-Line-Retry-Key']});return new Response('{}',{status:pushStatus,headers:pushStatus===409?{'X-Line-Accepted-Request-Id':'accepted'}:{}});}
    if(String(url).endsWith('/reply')) {assert.equal(opts.headers.Authorization,'Bearer new-token');replies.push(JSON.parse(opts.body));return Response.json({});}
    throw Error('Unexpected provider call');
  };
  const req=(route,options)=>worker.fetch(new Request(base+route,options),env,{});
  async function start(code='A1') {const r=await req(path+'/start?code='+code);assert.equal(r.status,302);const u=new URL(r.headers.get('location'));nonce=u.searchParams.get('nonce');assert.equal(u.searchParams.get('bot_prompt'),'aggressive');assert.equal(u.searchParams.get('scope'),'profile openid');assert.equal(u.searchParams.get('code_challenge_method'),'S256');const cookie=r.headers.get('set-cookie').split(';')[0];assert.match(r.headers.get('set-cookie'),/HttpOnly/);assert.match(r.headers.get('set-cookie'),/Secure/);return{state:u.searchParams.get('state'),cookie};}
  const callback=(s,cookie=s.cookie)=>req(path+'/callback?state='+s.state+'&code=valid-code',{headers:{Cookie:cookie}});
  async function webhook(type,eventId,options={}) {const body=JSON.stringify({destination:options.destination||bot,events:[{type,webhookEventId:eventId,source:{type:'user',userId:uid},replyToken:'reply-token',message:type==='message'?{type:'text',text:options.text||'面談希望です'}:undefined}]});const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(options.secret||'new-secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);const signature=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body))).toString('base64');return req(path+'/webhook',{method:'POST',headers:{'x-line-signature':signature},body});}
  return {sql,env,req,start,callback,webhook,pushes,replies,setFollow:v=>follow=v,setPush:v=>pushStatus=v,setBad:v=>badIdentity=v};
}
test('all twelve codes deliver image then text without a sent keyword',async()=>{for(const c of ['A1','A2','A3','B1','B2','B3','C1','C2','C3','D1','D2','D3']){const f=fixture();const s=await f.start(c);assert.equal((await f.callback(s)).status,303);assert.equal(f.pushes.length,1);assert.equal(f.pushes[0].body.messages[0].type,'image');assert.equal(f.pushes[0].body.messages[1].text,'type '+c);assert.equal(f.sql.prepare('SELECT status FROM hinatama_diagnosis_sessions').get().status,'sent');assert.equal(f.sql.prepare('SELECT line_account_id FROM friends').get().line_account_id,'new');}});
test('missing explicit account, inactive account, invalid code and old paths fail closed',async()=>{const f=fixture();assert.equal((await f.req(path+'/start?code=Z9')).status,400);delete f.env.HINATAMA_CHANNEL_ID;assert.equal((await f.req(path+'/start?code=A1')).status,503);assert.equal((await f.req('/webhook',{method:'POST',body:'{}'})).status,404);assert.equal(f.pushes.length,0);});
test('browser cookie mismatch, expiry and callback replay do not send',async()=>{const f=fixture();const s=await f.start();assert.equal((await f.callback(s,'hinatama_diagnosis='+ 'f'.repeat(64))).status,400);await f.callback(s);assert.equal((await f.callback(s)).status,400);assert.equal(f.pushes.length,1);const g=fixture();const t=await g.start();g.sql.exec('UPDATE hinatama_diagnosis_sessions SET expires_at=0');assert.equal((await g.callback(t)).status,400);assert.equal(g.pushes.length,0);});
test('wrong ID token audience rejects identity and stores no friend',async()=>{const f=fixture();const s=await f.start();f.setBad(true);await f.callback(s);assert.equal(f.pushes.length,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM friends').get().n,0);});
test('new add after callback sends once; webhook redelivery and status reads do not resend',async()=>{const f=fixture();f.setFollow(false);const s=await f.start();await f.callback(s);assert.equal(f.pushes.length,0);assert.equal((await f.webhook('follow','follow1')).status,200);assert.equal((await f.webhook('follow','follow1')).status,200);await f.req(path+'/status?format=json',{headers:{Cookie:s.cookie}});assert.equal(f.pushes.length,1);});
test('follow event before callback is preserved and yields one delivery',async()=>{const f=fixture();f.setFollow(false);const s=await f.start();await f.webhook('follow','follow-before');await f.callback(s);assert.equal(f.pushes.length,1);});
test('old friend identity conflict never reassigns or sends',async()=>{const f=fixture();f.sql.prepare('INSERT INTO friends(id,line_user_id,line_account_id,is_following,metadata) VALUES(?,?,?,?,?)').run('prior',uid,'old',1,'{}');const s=await f.start();await f.callback(s);assert.equal(f.pushes.length,0);assert.equal(f.sql.prepare('SELECT line_account_id FROM friends').get().line_account_id,'old');});
test('invalid signature and destination do not create friends or messages',async()=>{const f=fixture();assert.equal((await f.webhook('follow','wrong-signature',{secret:'old-secret'})).status,401);assert.equal((await f.webhook('follow','wrong-target',{destination:uid})).status,400);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM friends').get().n,0);});
test('quota failure is not sent; retry uses same key and frozen content; accepted 409 is idempotent',async()=>{const f=fixture();f.setPush(429);const s=await f.start();await f.callback(s);assert.equal(f.sql.prepare('SELECT status FROM hinatama_diagnosis_sessions').get().status,'failed');assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM messages_log').get().n,0);assert.equal((await f.req(path+'/retry',{method:'POST',headers:{Cookie:s.cookie,Origin:'https://evil.example'}})).status,403);f.sql.exec('UPDATE hinatama_diagnosis_sessions SET attempted_at=0');f.setPush(409);await f.req(path+'/retry',{method:'POST',headers:{Cookie:s.cookie,Origin:base}});assert.equal(f.pushes[0].key,f.pushes[1].key);assert.equal(f.sql.prepare('SELECT status FROM hinatama_diagnosis_sessions').get().status,'sent');assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM messages_log').get().n,2);});
test('explicit interview keyword replies once and stores staff unread chat only in new account',async()=>{const f=fixture();await f.webhook('message','msg1',{text:'ヒナタマ面談'});await f.webhook('message','msg1',{text:'ヒナタマ面談'});assert.equal(f.replies.length,1);assert.equal(f.pushes.length,0);const c=f.sql.prepare('SELECT * FROM chats').get();assert.equal(c.status,'unread');assert.equal(c.line_account_id,'new');});
test('blocked friend is not sent to until follow event',async()=>{const f=fixture();f.sql.prepare('INSERT INTO friends(id,line_user_id,line_account_id,is_following,metadata) VALUES(?,?,?,?,?)').run('blocked',uid,'new',0,'{}');const s=await f.start();await f.callback(s);assert.equal(f.pushes.length,0);await f.webhook('follow','unblock1');assert.equal(f.pushes.length,1);});
test('cancelled authorization clears transient credentials and never sends',async()=>{const f=fixture();const s=await f.start();await f.req(path+'/callback?state='+s.state+'&error=access_denied',{headers:{Cookie:s.cookie}});assert.equal(f.pushes.length,0);const row=f.sql.prepare('SELECT status,verifier,nonce FROM hinatama_diagnosis_sessions').get();assert.equal(row.status,'cancelled');assert.equal(row.verifier,null);assert.equal(row.nonce,null);});
process.on('exit',()=>{globalThis.fetch=originalFetch;});
test('concurrent callbacks atomically claim one delivery',async()=>{const f=fixture();const s=await f.start();const rs=await Promise.all([f.callback(s),f.callback(s)]);assert.deepEqual(rs.map(r=>r.status).sort(),[303,400]);assert.equal(f.pushes.length,1);});
test('failed webhook storage can be redelivered without duplicate incoming log',async()=>{const f=fixture();f.sql.exec("CREATE TRIGGER temporary_failure BEFORE INSERT ON chats BEGIN SELECT RAISE(ABORT,'test failure'); END;");assert.equal((await f.webhook('message','storage-retry')).status,503);f.sql.exec('DROP TRIGGER temporary_failure');assert.equal((await f.webhook('message','storage-retry')).status,200);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM messages_log').get().n,1);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM chats').get().n,1);});
test('pause blocks automatic result and keyword sends while preserving incoming staff chat',async()=>{
  const f=fixture();f.setFollow(false);const s=await f.start();await f.callback(s);
  f.sql.exec("INSERT INTO hinatama_diagnosis_control(line_account_id,is_paused) VALUES('new',1)");
  assert.equal((await f.req(path+'/start?code=A1')).status,503);
  assert.equal((await f.webhook('follow','paused-follow')).status,200);
  assert.equal((await f.webhook('message','paused-interview',{text:'ヒナタマ面談'})).status,200);
  assert.equal(f.pushes.length,0);assert.equal(f.replies.length,0);
  assert.equal(f.sql.prepare('SELECT status FROM chats').get().status,'unread');
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM messages_log WHERE direction='incoming'").get().n,1);
  f.sql.exec("UPDATE hinatama_diagnosis_sessions SET status='cancelled',claimed=1; UPDATE hinatama_diagnosis_control SET is_paused=0");
  await f.webhook('follow','resumed-follow');
  assert.equal(f.pushes.length,0);
  await f.webhook('message','resumed-interview',{text:'ヒナタマ面談'});
  assert.equal(f.replies.length,1);
});
