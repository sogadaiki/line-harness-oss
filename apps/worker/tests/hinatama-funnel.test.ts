import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {fixture} from './d1-fixture.mjs';
import {collectFunnel,parseFunnel,funnelReport,recordReceiptView,linkFunnelFriend,recordFunnelOutcome} from '../src/services/hinatama-funnel.js';
import worker from '../src/hinatama-entry.js';
const now=Math.floor(Date.now()/1000),start=now-1000;
const day=(n:number)=>new Date(n*1000+9*3600000).toISOString().slice(0,10);
const ids=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
const context={lp_version:'20261013-funnel-v1',source:'meta',medium:'paid_social',campaign:'hinatama_oct2026_d01',content:'image_style',ref:'m-d01-style'};
function packet(id=ids[0],questions=8,t=start){const keys=['start',...Array.from({length:questions},(_,i)=>['v'+(i+1),'q'+(i+1)]).flat(),...(questions===8?['complete','line_cta']:[])];return {kind:'attempt',id,visit_id:ids[2],started_at:t,sent_at:now,context,events:keys.map((key,i)=>({key,at:t+i}))};}
const valid=(p:unknown)=>{const result=parseFunnel(p,now);assert.ok(result);return result;};

test('new Q1 cohort and all three video creatives retain allowlisted attribution',()=>{
 for(const [ref,content] of [['m-d01-v03','video_v03_questions'],['m-d01-v04','video_v04_firststep'],['m-d01-v05','video_v05_schedule']]){
   assert.ok(parseFunnel({...packet(),context:{...context,lp_version:'20261021-q1-v1',ref,content}},now));
 }
});
test('server outcome joins survive transient receipt deletion; first inquiry is deduped across dates and assets',async()=>{
 const f=setup();await collectFunnel(f.db,'a',valid(packet(ids[0],8,start)));
 await linkFunnelFriend(f.db,'a','receipt1',ids[0],'friend-a');
 f.sql.prepare('UPDATE hinatama_funnel_links SET authorized_at=?').run(start+10);
 await recordFunnelOutcome(f.db,'a','friend-a','follow1','follow',(start+50)*1000);
 await recordFunnelOutcome(f.db,'a','friend-a','follow1','follow',(start+50)*1000);
 f.sql.prepare('DELETE FROM hinatama_diagnosis_sessions').run();
 await recordFunnelOutcome(f.db,'a','friend-a','message1','inquiry',(start+100)*1000);
 await recordFunnelOutcome(f.db,'a','friend-a','message2','inquiry',(start+200)*1000);
 const g=(await funnelReport(f.db,'a',day(start),day(start))).groups[0];
 assert.deepEqual(g.outcomes,{newFriends:1,unblocked:0,unknownFollows:0,inquiries:1});
 await recordFunnelOutcome(f.db,'b','friend-a','cross-account','follow',now*1000);
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM hinatama_funnel_outcomes WHERE line_account_id='b'").get().n,0);
 // A later authenticated diagnosis gets the subsequent first inquiry, never both.
 const p=packet(ids[1],8,start+300);p.context={...context,content:'video_v05_schedule',ref:'m-d01-v05'};
 await collectFunnel(f.db,'a',valid(p));await linkFunnelFriend(f.db,'a','receipt2',ids[1],'friend-a');
 f.sql.prepare("UPDATE hinatama_funnel_links SET authorized_at=? WHERE receipt_id='receipt2'").run(start+310);
 await recordFunnelOutcome(f.db,'a','friend-a','message3','inquiry',(start+400)*1000);
 assert.equal((await funnelReport(f.db,'a',day(start),day(start))).groups.reduce((n,g)=>n+g.outcomes.inquiries,0),1);
});
test('a verified follow may arrive before OAuth callback, but a pre-diagnosis follow is never credited',async()=>{
 const f=setup();await collectFunnel(f.db,'a',valid(packet()));
 await recordFunnelOutcome(f.db,'a','friend-a','earlier','follow',(start-1)*1000);
 await recordFunnelOutcome(f.db,'a','friend-a','unknown','follow_unknown',(now-5)*1000);
 await recordFunnelOutcome(f.db,'a','friend-a','unblock','refollow',(now-5)*1000);
 await linkFunnelFriend(f.db,'a','receipt',ids[0],'friend-a');
 assert.deepEqual((await funnelReport(f.db,'a',day(start),day(start))).groups[0].outcomes,{newFriends:0,unblocked:1,unknownFollows:1,inquiries:0});
});
test('authenticated QA exclusion removes visit, question and outcome counts',async()=>{
 const f=setup();await collectFunnel(f.db,'a',valid({kind:'visit',id:ids[2],started_at:start,sent_at:now,context}));await collectFunnel(f.db,'a',valid(packet()));
 await linkFunnelFriend(f.db,'a','qa-receipt',ids[0],'friend-a');
 f.sql.prepare("INSERT INTO hinatama_funnel_exclusions VALUES('a','friend-a','qa')").run();
 await recordFunnelOutcome(f.db,'a','friend-a','qa-follow','follow',now*1000);
 assert.equal((await funnelReport(f.db,'a',day(start),day(start))).groups.length,0);
});
test('only signed incoming user text counts; result requests, stickers, automatic replies and retries do not',async()=>{
 const f=setup(),uid='U'+'a'.repeat(32);
 const post=async(events:unknown[],validSignature=true)=>{
  const body=JSON.stringify({destination:f.env.HINATAMA_BOT_USER_ID,events});
  const signature=validSignature?createHmac('sha256','fixture-secret-a').update(body).digest('base64'):'invalid';
  return f.req('/hinatama/diagnosis/webhook',{method:'POST',headers:{'x-line-signature':signature},body});
 };
 const event=(id:string,extra:object)=>({webhookEventId:id,source:{type:'user',userId:uid},timestamp:now*1000,...extra});
 const events=[event('real-add',{type:'follow',follow:{isUnblocked:false}}),event('result-only',{type:'message',message:{type:'text',text:'ヒナタマ診断A1'}}),event('sticker',{type:'message',message:{type:'sticker'}}),event('real-question',{type:'message',message:{type:'text',text:'働く時間を相談したいです'}})];
 assert.equal((await post(events,false)).status,401);assert.equal((await post(events)).status,200);assert.equal((await post(events)).status,200);
 assert.deepEqual(f.sql.prepare('SELECT kind,COUNT(*) n FROM hinatama_funnel_outcomes GROUP BY kind ORDER BY kind').all().map(r=>({...r})),[{kind:'follow',n:1},{kind:'inquiry',n:1}]);
 const fid=f.sql.prepare('SELECT id FROM friends WHERE line_user_id=?').get(uid).id as string;
 await collectFunnel(f.db,'a',valid(packet()));await linkFunnelFriend(f.db,'a','callback',ids[0],fid);
 assert.equal((await funnelReport(f.db,'a',day(start),day(start))).groups[0].outcomes.newFriends,1);
});
function setup(){const f=fixture();f.sql.prepare('UPDATE line_accounts SET channel_id=? WHERE id=?').run('123','a');const env={DB:f.db,HINATAMA_CHANNEL_ID:'123',HINATAMA_LOGIN_CHANNEL_ID:'456',HINATAMA_LOGIN_SECRET:'test-secret',HINATAMA_BOT_USER_ID:'U'+'b'.repeat(32),HINATAMA_BASIC_ID:'@test',HINATAMA_WORKER_URL:'https://receiver.example',HINATAMA_IMAGE_ORIGIN:'https://images.example',SCOPED_LINE_ACCOUNT_ID:'a'};const req=(path:string,options?:RequestInit)=>worker.fetch(new Request('https://receiver.example'+path,options),env,{} as ExecutionContext);return {...f,env,req};}
test('allowlist rejects answers, codes, LINE identity, arbitrary UTM and malformed milestones',()=>{
 const p=packet();for(const extra of [{answers:[1,2]},{code:'A1'},{line_user_id:'private'},{token:'secret'}])assert.equal(parseFunnel({...p,...extra},now),null);
 assert.equal(parseFunnel({...p,context:{...context,source:'person@example.com'}},now),null);
 assert.equal(parseFunnel({...p,events:[{key:'type_A1',at:start}]},now),null);
 assert.equal(parseFunnel({...p,events:[{key:'start',at:start,answer:'private'}]},now),null);
 assert.equal(parseFunnel({...p,started_at:now-86401},now),null);
});
test('two diagnoses in one visit count twice; repeat packets and receipt reload count once',async()=>{
 const f=setup();await collectFunnel(f.db,'a',valid({kind:'visit',id:ids[2],started_at:start,sent_at:now,context}));
 for(const id of ids.slice(0,2)){await collectFunnel(f.db,'a',valid(packet(id)));await collectFunnel(f.db,'a',valid(packet(id)));await recordReceiptView(f.db,'a',id,id,'pending');await recordReceiptView(f.db,'a',id,id,'sent');}
 const r=await funnelReport(f.db,'a',day(start),day(start)),g=r.groups[0];assert.equal(g.started,2);assert.equal(g.lpViews,1);assert.equal(g.visitsStarted,1);assert.deepEqual(g.steps.map(s=>s.count),Array(12).fill(2));assert.equal(g.questionViews[7].count,2);assert.equal(g.resultStates.sent,2);assert.equal(r.unattributedResultViews,0);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM hinatama_funnel_events').get().n,38);
});
test('reached differs from answered; missing and out of order steps truncate closed funnel',async()=>{
 const f=setup(),p=packet(ids[0],2);p.events.push({key:'v3',at:start+5});await collectFunnel(f.db,'a',valid(p));
 const bad=packet(ids[1]);bad.events=bad.events.filter(e=>e.key!=='q3');await collectFunnel(f.db,'a',valid(bad));await recordReceiptView(f.db,'a','receipt',ids[1],'sent');
 const g=(await funnelReport(f.db,'a',day(start),day(start))).groups[0];assert.equal(g.steps[2].count,2);assert.equal(g.steps[3].count,0);assert.equal(g.questionViews[2].count,2);assert.equal(g.questionViews[3].count,0);assert.equal(g.steps[11].count,0);assert.equal(g.resultStates.sent,0);
 const reverse=packet(ids[2]);reverse.events.find(e=>e.key==='q2')!.at=start;await collectFunnel(f.db,'a',valid(reverse));assert.equal((await funnelReport(f.db,'a',day(start),day(start))).groups[0].steps[2].count,2);
});
test('JST start cohort includes next-day display; prior cohort is not misreported as unlinked',async()=>{
 const f=setup(),midnight=Math.floor(Date.parse(day(now)+'T00:00:00+09:00')/1000),t=midnight-60;
 await collectFunnel(f.db,'a',valid(packet(ids[0],8,t)));await recordReceiptView(f.db,'a','cross-midnight',ids[0],'sent');
 assert.equal((await funnelReport(f.db,'a',day(t),day(t))).groups[0].steps[11].count,1);
 const today=await funnelReport(f.db,'a',day(now),day(now));assert.equal(today.groups.length,0);assert.equal(today.unattributedResultViews,0);
});
test('late LP packets join prior receipt, direct result is separate, tenant and UTM filters isolate',async()=>{
 const f=setup();await recordReceiptView(f.db,'a','late',ids[0],'cancelled');await recordReceiptView(f.db,'a','unlinked',null,'sent');
 assert.equal((await funnelReport(f.db,'a',day(start),day(start))).unattributedResultViews,2);
 await collectFunnel(f.db,'a',valid(packet()));const r=await funnelReport(f.db,'a',day(start),day(start));assert.equal(r.unattributedResultViews,1);assert.equal(r.groups[0].steps[11].count,0);assert.equal(r.groups[0].receiptPageViews,1);assert.equal(r.groups[0].resultStates.cancelled,1);
 assert.equal((await funnelReport(f.db,'b',day(start),day(start))).groups.length,0);assert.equal((await funnelReport(f.db,'a',day(start),day(start),{source:'google'})).groups.length,0);
});
test('same-origin collector rejects forged result milestone; aggregate requires staff authentication',async()=>{
 const f=setup(),post=(p:unknown,origin='https://receiver.example')=>f.req('/hinatama/diagnosis/events',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(p)});
 assert.equal((await post(packet())).status,200);assert.equal((await post(packet(),'https://evil.example')).status,403);
 assert.equal((await post({...packet(),events:[{key:'result_view',at:start}]})).status,400);
 assert.equal((await f.req('/api/diagnosis/funnel?from='+day(start)+'&to='+day(start))).status,401);
 assert.equal((await f.req('/hinatama/diagnosis/view?attempt='+'a'.repeat(64),{method:'POST',headers:{Origin:'https://receiver.example','Content-Type':'application/json'},body:'{"state":"sent"}'})).status,400);
});
test('another browser joins via receiver; GET does not count; duplicate display and reconnect preserve trial',async()=>{
 const f=setup();await collectFunnel(f.db,'a',valid(packet()));f.sql.prepare('INSERT INTO hinatama_diagnosis_content VALUES(?,?,?)').run('a','A1',JSON.stringify([{type:'text',text:'dummy result'}]));
 const begin=await f.req('/hinatama/diagnosis/start?code=A1&funnel='+ids[0]);assert.equal(begin.status,302);
 const sid=f.sql.prepare('SELECT id FROM hinatama_diagnosis_sessions').get().id as string,cookie=begin.headers.get('set-cookie')!.split(';')[0];f.sql.prepare("UPDATE hinatama_diagnosis_sessions SET status='sent'").run();
 const url='/hinatama/diagnosis/status?attempt='+sid,r=await f.req(url,{headers:{Cookie:cookie}});assert.equal(r.status,200);assert.match(await r.text(),/requestAnimationFrame/);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM hinatama_funnel_receipt_views').get().n,0);
 for(let i=0;i<2;i++)assert.equal((await f.req('/hinatama/diagnosis/view?attempt='+sid,{method:'POST',headers:{Cookie:cookie,Origin:'https://receiver.example','Content-Type':'application/json'},body:'{"state":"sent"}'})).status,200);
 assert.equal((await funnelReport(f.db,'a',day(start),day(start))).groups[0].steps[11].count,1);
 assert.equal((await f.req('/hinatama/diagnosis/view?attempt='+sid,{method:'POST',headers:{Origin:'https://receiver.example','Content-Type':'application/json'},body:'{"state":"sent"}'})).status,400);
 f.sql.prepare("UPDATE hinatama_diagnosis_sessions SET status='cancelled'").run();assert.ok((await(await f.req(url,{headers:{Cookie:cookie}})).text()).includes('funnel='+ids[0]));
});
test('report validates dates/span and authorized empty data remains explicit',async()=>{
 const f=setup(),headers={Authorization:'Bearer fixture-staff-key'};
 assert.equal((await f.req('/api/diagnosis/funnel?from=2026-02-30&to=2026-03-01',{headers})).status,400);
 assert.equal((await f.req('/api/diagnosis/funnel?from=2026-01-01&to=2026-10-01',{headers})).status,400);
 const r=await f.req('/api/diagnosis/funnel?from='+day(start)+'&to='+day(start),{headers});assert.equal(r.status,200);assert.deepEqual((await r.json() as {data:{groups:unknown[]}}).data.groups,[]);
});

test('two-minute device skew is normalized; duplicate packets preserve cohort and 24-hour cutoff',async()=>{
 const f=setup(),p=packet();p.started_at+=120;p.sent_at+=120;p.events.forEach(e=>e.at+=120);await collectFunnel(f.db,'a',valid(p));await collectFunnel(f.db,'a',valid(p));await recordReceiptView(f.db,'a','skew',ids[0],'sent');
 assert.equal((await funnelReport(f.db,'a',day(start),day(start))).groups[0].steps[11].count,1);
 f.sql.prepare('UPDATE hinatama_funnel_receipt_views SET viewed_at=?,success_viewed_at=?').run(...Array(2).fill(Number(f.sql.prepare('SELECT started_at FROM hinatama_funnel_attempts').get().started_at)+86401));assert.equal((await funnelReport(f.db,'a',day(start),day(start))).groups[0].steps[11].count,0);
});

test('waiting/error pages are separate; only displayed success completes, and later retry does not undo it',async()=>{
 const f=setup();await collectFunnel(f.db,'a',valid(packet()));await recordReceiptView(f.db,'a','receipt',ids[0],'sent','pending');
 let g=(await funnelReport(f.db,'a',day(start),day(start))).groups[0];assert.equal(g.receiptPageViews,1);assert.equal(g.steps[11].count,0);
 await recordReceiptView(f.db,'a','receipt',ids[0],'sent','sent');await recordReceiptView(f.db,'a','retry',ids[0],'cancelled','cancelled');
 g=(await funnelReport(f.db,'a',day(start),day(start))).groups[0];assert.equal(g.steps[11].count,1);assert.equal(g.receiptPageViews,1);assert.equal(g.resultStates.cancelled,1);
});

test('direct public collector grants only LP POST/content-type CORS; no cookie or key required',async()=>{
 const f=setup(),path='/hinatama/diagnosis/events',Origin='https://chat-hinatama.com';
 const pre=await f.req(path,{method:'OPTIONS',headers:{Origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'}});assert.equal(pre.status,204);assert.equal(pre.headers.get('Access-Control-Allow-Origin'),Origin);assert.equal(pre.headers.get('Access-Control-Allow-Credentials'),null);assert.equal(pre.headers.get('Vary'),'Origin');
 for(const headers of [{Origin:'https://evil.example','Access-Control-Request-Method':'POST'},{Origin,'Access-Control-Request-Method':'GET'},{Origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Authorization'}])assert.equal((await f.req(path,{method:'OPTIONS',headers})).status,403);
 const r=await f.req(path,{method:'POST',headers:{Origin,'Content-Type':'application/json'},body:JSON.stringify(packet())});assert.equal(r.status,200);assert.equal(r.headers.get('Access-Control-Allow-Origin'),Origin);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM hinatama_funnel_attempts').get().n,1);
 const privateRoute=await f.req('/api/diagnosis/funnel?from='+day(start)+'&to='+day(start),{headers:{Origin}});assert.equal(privateRoute.status,401);assert.notEqual(privateRoute.headers.get('Access-Control-Allow-Origin'),Origin);
});
test('direct collector enforces byte size and schema and deduplicates repeated batches',async()=>{
 const f=setup(),post=(body:string)=>f.req('/hinatama/diagnosis/events',{method:'POST',headers:{Origin:'https://chat-hinatama.com','Content-Type':'application/json'},body});
 assert.equal((await post(JSON.stringify({padding:'あ'.repeat(3000)}))).status,413);assert.equal((await post(JSON.stringify({...packet(),code:'A1'}))).status,400);assert.equal((await post(JSON.stringify({...packet(),id:'not-a-trial'}))).status,400);
 for(let i=0;i<3;i++)assert.equal((await post(JSON.stringify(packet()))).status,200);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM hinatama_funnel_attempts').get().n,1);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM hinatama_funnel_events').get().n,19);
});
test('public telemetry rate budget cannot consume the authentication budget',async()=>{
 const f=setup(),ip='funnel-rate-fixture';f.sql.prepare('INSERT INTO hinatama_diagnosis_content VALUES(?,?,?)').run('a','A1',JSON.stringify([{type:'text',text:'dummy'}]));
 const headers={Origin:'https://chat-hinatama.com','Content-Type':'application/json','CF-Connecting-IP':ip};
 for(let i=0;i<240;i++)assert.equal((await f.req('/hinatama/diagnosis/events',{method:'POST',headers,body:'{}'})).status,400);
 assert.equal((await f.req('/hinatama/diagnosis/events',{method:'POST',headers,body:'{}'})).status,429);assert.equal((await f.req('/hinatama/diagnosis/start?code=A1',{headers:{'CF-Connecting-IP':ip}})).status,302);
});

test('official bridge start binds the trial and preserves callback, cookie and status URL',async()=>{
 const f=setup();f.env.HINATAMA_DIAGNOSIS_PUBLIC_URL='https://chat-hinatama.com/lp07/line/';f.env.HINATAMA_BRIDGE_SECRET='bridge-fixture';
 await collectFunnel(f.db,'a',valid(packet()));
 f.sql.prepare('INSERT INTO hinatama_diagnosis_content VALUES(?,?,?)').run('a','A1',JSON.stringify([{type:'text',text:'dummy'}]));
 const headers={'X-Hinatama-Bridge-Key':'bridge-fixture','X-Hinatama-Client-IP':'192.0.2.91'};
 // This is the fixed server-to-server GET produced after PHP's browser POST validation.
 const begin=await f.req('/hinatama/diagnosis/start?code=A1&funnel='+ids[0],{headers});
 assert.equal(begin.status,302);const auth=new URL(begin.headers.get('Location')!);
 assert.equal(auth.searchParams.get('redirect_uri'),'https://chat-hinatama.com/lp07/line/?step=callback');
 assert.equal(auth.searchParams.get('code'),null);assert.equal(auth.searchParams.get('funnel'),null);
 assert.match(begin.headers.get('Set-Cookie')!,/Path=\/lp07\/line\//);assert.match(begin.headers.get('Set-Cookie')!,/HttpOnly/);
 assert.match(begin.headers.get('Set-Cookie')!,/Secure/);assert.match(begin.headers.get('Set-Cookie')!,/SameSite=Lax/);
 const session=f.sql.prepare('SELECT id,funnel_attempt_id FROM hinatama_diagnosis_sessions').get(),cookie=begin.headers.get('Set-Cookie')!.split(';')[0];
 assert.equal(session.funnel_attempt_id,ids[0]);f.sql.prepare("UPDATE hinatama_diagnosis_sessions SET status='sent'").run();
 const path='/hinatama/diagnosis/status?attempt='+session.id;
 const page=await f.req(path,{headers:{...headers,Cookie:cookie}}),html=await page.text();
 assert.equal(page.status,200);assert.ok(html.includes('https://chat-hinatama.com/lp07/line/?step=view&attempt='+session.id));
 assert.equal(/googletagmanager|clarity\.ms/.test(html),false);assert.equal((await funnelReport(f.db,'a',day(start),day(start))).groups[0].steps[11].count,0);
 const display=()=>f.req('/hinatama/diagnosis/view?attempt='+session.id,{method:'POST',headers:{...headers,Cookie:cookie,Origin:'https://chat-hinatama.com','Content-Type':'application/json'},body:'{"state":"sent"}'});
 assert.equal((await display()).status,200);assert.equal((await display()).status,200);
 assert.equal((await funnelReport(f.db,'a',day(start),day(start))).groups[0].steps[11].count,1);
 assert.equal((await f.req('/hinatama/diagnosis/view?attempt='+session.id,{method:'POST',headers:{...headers,Origin:'https://chat-hinatama.com','Content-Type':'application/json'},body:'{"state":"sent"}'})).status,400);
 assert.equal((await f.req('/hinatama/diagnosis/view?attempt='+session.id,{method:'POST',headers:{...headers,Cookie:cookie,Origin:'https://evil.example','Content-Type':'application/json'},body:'{"state":"sent"}'})).status,403);
});
test('official reconnect preserves the same trial while new direct POST start is absent',async()=>{
 const f=setup();f.env.HINATAMA_DIAGNOSIS_PUBLIC_URL='https://chat-hinatama.com/lp07/line/';f.env.HINATAMA_BRIDGE_SECRET='bridge-fixture';
 f.sql.prepare('INSERT INTO hinatama_diagnosis_content VALUES(?,?,?)').run('a','A1',JSON.stringify([{type:'text',text:'dummy'}]));
 const headers={'X-Hinatama-Bridge-Key':'bridge-fixture','X-Hinatama-Client-IP':'192.0.2.92'};
 const begin=await f.req('/hinatama/diagnosis/start?code=A1&funnel='+ids[0],{headers});
 const session=f.sql.prepare('SELECT id FROM hinatama_diagnosis_sessions').get(),cookie=begin.headers.get('Set-Cookie')!.split(';')[0];
 f.sql.prepare("UPDATE hinatama_diagnosis_sessions SET status='cancelled'").run();
 const html=await(await f.req('/hinatama/diagnosis/status?attempt='+session.id,{headers:{...headers,Cookie:cookie}})).text();
 assert.ok(html.includes('https://chat-hinatama.com/lp07/line/?step=start&amp;code=A1&amp;funnel='+ids[0]));
 const post=await f.req('/hinatama/diagnosis/start',{method:'POST',headers:{Origin:'https://chat-hinatama.com','Content-Type':'application/x-www-form-urlencoded'},body:'code=A1'});
 assert.equal(post.status,404);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM hinatama_diagnosis_sessions').get().n,1);
});
