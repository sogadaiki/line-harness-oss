import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import worker from '../src/index.js';
import {fixture} from './d1-fixture.mjs';
import {matchConditions,validConditions} from '../src/utils/automation-conditions.js';
import {fireEvent} from '../src/services/event-bus.js';
import {processBroadcastSend} from '../src/services/broadcast.js';
import {processSegmentSend} from '../src/services/segment-send.js';
import {processStepDeliveries,resolveMetadata} from '../src/services/step-delivery.js';
import {processReminderDeliveries} from '../src/services/reminder-delivery.js';
import {LineClient} from '@line-crm/line-sdk';
import {sendAdConversions} from '../src/services/ad-conversion.js';
import {createAdPlatform,recordRefTracking} from '@line-crm/db';
import {createForm,createNotificationRule,createScoringRule,createOutgoingWebhook,createConversionPoint,trackConversion,getConversionEvents,getConversionReport,advanceFriendScenario,completeFriendScenario,createTrackedLink} from '@line-crm/db';
import {createScenario,createScenarioStep,enrollFriendInScenario,updateScenario,getFriendScenariosDueForDelivery,createReminder,createReminderStep,enrollFriendInReminder,createAutomation,createBroadcast,addTagToFriend,upsertFriend} from '@line-crm/db';

let outbound:any[]=[];
const fixtures:any[]=[];
const originalFetch=globalThis.fetch;
const originalNow=Date.now;
function setup(scope:string|undefined='a') {
  const f=fixture();fixtures.push(f);outbound=[];
  // A known daytime so a skipped delivery window cannot create a false pass.
  Date.now=()=>new Date('2026-10-10T03:00:00Z').getTime();
  globalThis.fetch=async(input:any,init:any={})=>{
    const url=String(input);
    assert.ok(url.startsWith('https://api.line.me/') || url.startsWith('https://fixture.invalid/'),'All external network is blocked: '+url);
    const body=init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body ? JSON.parse(init.body) : null;
    outbound.push({url,body,token:new Headers(init.headers).get('authorization')});
    return new Response(JSON.stringify(url.includes('/oauth2/v2.1/verify') ? {sub:body.id_token==='fixture-id-a'?'user-a':'user-b'} : url.includes('/profile/') ? {userId:'new-user',displayName:'架空利用者'} : {}),{headers:{'content-type':'application/json','x-line-request-id':'fixture-request'}});
  };
  const env:any={DB:f.db,API_KEY:'fixture-owner-key',SCOPED_LINE_ACCOUNT_ID:scope,LINE_CHANNEL_ACCESS_TOKEN:'fixture-fallback-never-use',LINE_CHANNEL_SECRET:'fixture-unassigned-secret',WORKER_URL:'',ASSETS:{fetch:()=>new Response('',{status:404})}};
  let requestNo=0;
  async function request(path:string,method='GET',body?:any,key='fixture-owner-key') {
    const promises:Promise<any>[]=[];
    const response=await worker.fetch(new Request('https://fixture.invalid'+path,{method,headers:{...(key?{Authorization:'Bearer '+key}:{}),'content-type':'application/json','cf-connecting-ip':'192.0.2.'+(++requestNo)},...(body!==undefined?{body:JSON.stringify(body)}:{})}),env,{waitUntil:(p:Promise<any>)=>promises.push(p)} as any);
    await Promise.all(promises);
    return {status:response.status,data:await response.json() as any};
  }
  return {...f,env,request};
}
afterEach(()=>{for(const f of fixtures.splice(0))f.close();globalThis.fetch=originalFetch;Date.now=originalNow;});

test('unknown or malformed automation conditions fail closed, including missing event fields',()=>{
  assert.equal(matchConditions({tagId:'tag-a'},{eventData:{tagId:'tag-b'}}),false);
  assert.equal(validConditions({tag_id:'tag-a'}),true);
  assert.equal(matchConditions({tag_id:'tag-a'},{}),false);
  assert.equal(matchConditions({keyword:'相談'},{}),false);
  assert.equal(matchConditions({score_threshold:5},{}),false);
  assert.equal(matchConditions({score_threshold:5},{eventData:{currentScore:6}}),true);
  assert.equal(matchConditions({tag_id:'tag-a'},{eventData:{tagId:'tag-a'}}),true);
});

test('API rejects conflicting selection, foreign IDs, nested IDs and references without writing',async()=>{
  const f=setup();
  const b=await createScenario(f.db,{name:'B用',triggerType:'manual',lineAccountId:'b'});
  const a=await createScenario(f.db,{name:'A用',triggerType:'manual',lineAccountId:'a'});
  const step=await createScenarioStep(f.db,{scenarioId:b.id,stepOrder:1,delayMinutes:0,messageType:'text',messageContent:'架空'});
  assert.equal((await f.request('/api/scenarios?lineAccountId=b','POST',{name:'拒否',triggerType:'manual'})).status,403);
  assert.equal((await f.request('/api/scenarios','POST',{name:'拒否',triggerType:'manual',lineAccountId:'b'})).status,403);
  for(const method of ['GET','PUT','DELETE'])assert.equal((await f.request('/api/scenarios/'+b.id,method,method==='PUT'?{isActive:false}:undefined)).status,404);
  assert.equal((await f.request(`/api/scenarios/${a.id}/steps/${step.id}`,'DELETE')).status,404);
  assert.equal((await f.request(`/api/scenarios/${a.id}/enroll/friend-b`,'POST',{})).status,404);
  assert.equal((await f.request('/api/friends/friend-a/tags','POST',{tagId:'tag-b'})).status,404);
  assert.equal((await f.request('/api/friends/friend-b/messages','POST',{content:'送信禁止'})).status,404);
  assert.equal(f.sql.prepare('SELECT is_active FROM scenarios WHERE id=?').get(b.id).is_active,1);
  assert.equal(outbound.length,0);
});

test('unbound workers require explicit selection and staff grants; account discovery respects grants',async()=>{
  const f=setup();delete f.env.SCOPED_LINE_ACCOUNT_ID;
  assert.equal((await f.request('/api/scenarios')).status,400);
  assert.equal((await f.request('/api/scenarios?lineAccountId=b','GET',undefined,'fixture-staff-key')).status,403);
  assert.equal((await f.request('/api/scenarios?lineAccountId=a','GET',undefined,'fixture-staff-key')).status,200);
  const list=await f.request('/api/line-accounts','GET',undefined,'fixture-staff-key');
  assert.deepEqual(list.data.data.map((a:any)=>a.id),['a']);
  assert.equal((await f.request('/api/users?lineAccountId=a','GET',undefined,'fixture-staff-key')).status,403);
});

test('creates without a body account save atomically to the selected account and stay visible; defaults are stopped',async()=>{
  const f=setup();
  const cases:any[]=[
    ['scenarios',{name:'架空シナリオ',triggerType:'manual'},'scenarios'],
    ['automations',{name:'架空自動化',eventType:'tag_change',conditions:{tag_id:'tag-a'},actions:[{type:'add_tag',params:{tagId:'tag-a'}}]},'automations'],
    ['broadcasts',{title:'架空下書き',messageType:'text',messageContent:'架空',targetType:'all'},'broadcasts'],
    ['reminders',{name:'架空リマインダ'},'reminders'],
    ['auto-replies',{keyword:'架空',responseContent:'架空結果'},'auto_replies'],
  ];
  for(const [path,body,table] of cases){
    const res=await f.request('/api/'+path,'POST',body);
    assert.equal(res.status,201,JSON.stringify(res));
    const row=f.sql.prepare(`SELECT * FROM ${table} WHERE id=?`).get(res.data.data.id);
    assert.equal(row.line_account_id,'a');
    if('is_active' in row)assert.equal(row.is_active,0);
    else assert.equal(row.status,'draft');
    const list=await f.request('/api/'+path);
    assert.ok(list.data.data.some((r:any)=>r.id===row.id));
  }
  assert.equal((await f.request('/api/automations','POST',{name:'無効条件',eventType:'tag_change',conditions:{tagId:'tag-a'},actions:[]})).status,400);
});

test('events derive account from friend and do not execute foreign or unassigned automations',async()=>{
  const f=setup();
  for(const account of ['a','b',null])await createAutomation(f.db,{name:'架空 '+account,eventType:'tag_change',isActive:true,lineAccountId:account,conditions:{tag_id:'tag-a'},actions:[{type:'send_message',params:{content:'結果 '+account}}]});
  await fireEvent(f.db,'tag_change',{friendId:'friend-a',eventData:{tagId:'tag-a'}});
  assert.equal(outbound.length,1);
  assert.equal(outbound[0].token,'Bearer fixture-token-a');
  assert.equal(outbound[0].body.to,'user-a');
  await fireEvent(f.db,'tag_change',{friendId:'friend-a',eventData:{tagId:'tag-a'}},undefined,'b');
  assert.equal(outbound.length,1);
});

test('DB tags, enrollments and friend upsert reject cross-account ownership',async()=>{
  const f=setup();
  await assert.rejects(addTagToFriend(f.db,'friend-a','tag-b'));
  const b=await createScenario(f.db,{name:'B',triggerType:'manual',lineAccountId:'b'});
  await assert.rejects(enrollFriendInScenario(f.db,'friend-a',b.id));
  await assert.rejects(upsertFriend(f.db,{lineUserId:'user-a',lineAccountId:'b',displayName:'上書き禁止'}));
  assert.equal(f.sql.prepare('SELECT display_name,line_account_id FROM friends WHERE id=?').get('friend-a').line_account_id,'a');
  assert.equal(f.sql.prepare('SELECT display_name FROM friends WHERE id=?').get('friend-a').display_name,'架空利用者 a');
});

test('stopping parent pauses due enrollments; re-enabling does not resume them or send messages',async()=>{
  const f=setup();
  const s=await createScenario(f.db,{name:'A',triggerType:'manual',lineAccountId:'a'});
  await createScenarioStep(f.db,{scenarioId:s.id,stepOrder:1,delayMinutes:0,messageType:'text',messageContent:'禁止'});
  const enrolled=await enrollFriendInScenario(f.db,'friend-a',s.id);
  f.sql.prepare('UPDATE friend_scenarios SET next_delivery_at=? WHERE id=?').run('2020-01-01T00:00:00+09:00',enrolled.id);
  assert.equal((await getFriendScenariosDueForDelivery(f.db,'2026-10-10T12:00:00+09:00')).length,1);
  await updateScenario(f.db,s.id,{is_active:0});
  await updateScenario(f.db,s.id,{is_active:1});
  assert.equal((await getFriendScenariosDueForDelivery(f.db,'2026-10-10T12:00:00+09:00')).length,0);
  const row=f.sql.prepare('SELECT status,next_delivery_at FROM friend_scenarios WHERE id=?').get(enrolled.id);
  assert.deepEqual({...row},{status:'paused',next_delivery_at:null});
  await processStepDeliveries(f.db,new LineClient('fixture-fallback-never-use'),'','a');
  assert.equal(outbound.length,0);
});

test('delivery queries exclude disabled parents, inactive accounts, wrong owners and unassigned friends',async()=>{
  const f=setup();
  const a=await createScenario(f.db,{name:'A',triggerType:'manual',lineAccountId:'a'});
  const b=await createScenario(f.db,{name:'B',triggerType:'manual',lineAccountId:'b'});
  for(const [id,friend,scenario] of [['ok','friend-a',a.id],['wrong','friend-a',b.id],['inactive','friend-b',b.id]])f.sql.prepare(`INSERT INTO friend_scenarios(id,friend_id,scenario_id,next_delivery_at) VALUES (?,?,?,?)`).run(id,friend,scenario,'2020-01-01T00:00:00+09:00');
  f.sql.prepare('UPDATE line_accounts SET is_active=0 WHERE id=?').run('b');
  assert.deepEqual((await getFriendScenariosDueForDelivery(f.db,'2026-10-10T12:00:00+09:00')).map((r:any)=>r.id),['ok']);
  f.sql.prepare('UPDATE scenarios SET is_active=0 WHERE id=?').run(a.id);
  assert.equal((await getFriendScenariosDueForDelivery(f.db,'2026-10-10T12:00:00+09:00')).length,0);
});

test('tag and OR-segment broadcasts send only following friends of their owning account',async()=>{
  const f=setup();
  // Seed a legacy bad relation directly to ensure sender still guards recipients.
  f.sql.prepare('INSERT INTO friend_tags(friend_id,tag_id) VALUES (?,?)').run('friend-b','tag-a');
  await addTagToFriend(f.db,'friend-a','tag-a');
  const tagged=await createBroadcast(f.db,{title:'架空タグ',messageType:'text',messageContent:'架空',targetType:'tag',targetTagId:'tag-a',lineAccountId:'a'});
  await processBroadcastSend(f.db,new LineClient('fixture-fallback-never-use'),tagged.id);
  assert.deepEqual(outbound[0].body.to,['user-a']);
  const segmented=await createBroadcast(f.db,{title:'架空条件',messageType:'text',messageContent:'架空',targetType:'all',lineAccountId:'a'});
  await processSegmentSend(f.db,new LineClient('fixture-fallback-never-use'),segmented.id,{operator:'OR',rules:[{type:'is_following',value:true},{type:'ref_code',value:'x'}]});
  assert.deepEqual(outbound[1].body.to,['user-a']);
  assert.ok(outbound.every(call=>call.token==='Bearer fixture-token-a'));
});

test('account stop reads back zero pending work and leaves account B unchanged',async()=>{
  const f=setup();
  for(const account of ['a','b']) {
    const s=await createScenario(f.db,{name:account,triggerType:'manual',lineAccountId:account});
    await enrollFriendInScenario(f.db,'friend-'+account,s.id);
    const r=await createReminder(f.db,{name:account,lineAccountId:account,isActive:true});
    await createReminderStep(f.db,{reminderId:r.id,offsetMinutes:0,messageType:'text',messageContent:'架空'});
    await enrollFriendInReminder(f.db,{friendId:'friend-'+account,reminderId:r.id,targetDate:'2020-01-01T00:00:00+09:00'});
    await createAutomation(f.db,{name:account,eventType:'tag_change',lineAccountId:account,isActive:true,actions:[]});
    await createBroadcast(f.db,{title:account,messageType:'text',messageContent:'架空',targetType:'all',lineAccountId:account,scheduledAt:'2020-01-01T00:00:00+09:00'});
  }
  const result=await f.request('/api/account-stop','POST',{kind:'all-automation'});
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(result.data.data.accountId,'a');
  assert.ok(Object.values(result.data.data.remaining).every(count=>count===0));
  for(const table of ['scenarios','reminders','automations'])assert.equal(f.sql.prepare(`SELECT is_active FROM ${table} WHERE line_account_id='b'`).get().is_active,1);
  assert.equal(f.sql.prepare(`SELECT status FROM broadcasts WHERE line_account_id='b'`).get().status,'scheduled');
  await processReminderDeliveries(f.db,new LineClient('fixture-fallback-never-use'),'a');
  assert.equal(outbound.length,0);
});

test('stop transaction failures are errors and roll back instead of claiming completion',async()=>{
  const f=setup();
  const a=await createScenario(f.db,{name:'A',triggerType:'manual',lineAccountId:'a'});
  f.sql.exec(`CREATE TRIGGER fixture_stop_failure BEFORE UPDATE ON automations BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`);
  await createAutomation(f.db,{name:'A',eventType:'tag_change',lineAccountId:'a',isActive:true,actions:[]});
  assert.equal((await f.request('/api/account-stop','POST',{kind:'all-automation'})).status,500);
  assert.equal(f.sql.prepare('SELECT is_active FROM scenarios WHERE id=?').get(a.id).is_active,1);
});

test('scoped cron does not send, health-check, refresh, or update another account',async()=>{
  const f=setup();
  for(const account of ['a','b'])await createBroadcast(f.db,{title:account,messageType:'text',messageContent:'架空',targetType:'all',lineAccountId:account,scheduledAt:'2020-01-01T00:00:00+09:00'});
  await worker.scheduled({} as any,f.env,{} as any);
  assert.ok(outbound.some(call=>call.url.includes('/message/broadcast')),'Must exercise real delivery, not skip it');
  assert.ok(outbound.every(call=>call.token==='Bearer fixture-token-a'));
  assert.equal(f.sql.prepare(`SELECT status FROM broadcasts WHERE line_account_id='b'`).get().status,'scheduled');
  assert.equal(f.sql.prepare(`SELECT COUNT(*) AS n FROM account_health_logs WHERE line_account_id='b'`).get().n,0);
});

test('webhook rejects other-account and unassigned signatures; follow cannot move an existing owner',async()=>{
  const f=setup();
  async function send(secret:string,userId:string) {
    const body=JSON.stringify({destination:'fixture-bot',events:[{type:'follow',replyToken:'fixture-reply',source:{type:'user',userId},timestamp:Date.now()}]});
    const promises:Promise<any>[]=[];
    const response=await worker.fetch(new Request('https://fixture.invalid/webhook',{method:'POST',headers:{'X-Line-Signature':createHmac('sha256',secret).update(body).digest('base64')},body}),f.env,{waitUntil:(p:Promise<any>)=>promises.push(p)} as any);
    await Promise.all(promises);assert.equal(response.status,200);
  }
  await send('fixture-secret-b','new-user');
  await send('fixture-unassigned-secret','new-user');
  assert.equal(outbound.length,0);
  await send('fixture-secret-a','user-b');
  assert.equal(f.sql.prepare('SELECT line_account_id FROM friends WHERE id=?').get('friend-b').line_account_id,'b');
  assert.ok(outbound.every(call=>!call.url.includes('/message/')));
});

test('metadata expansion does not use answers from another UUID-linked LINE',async()=>{
  const f=setup();
  assert.deepEqual(await resolveMetadata(f.db,{user_id:'shared-uuid',metadata:'{"own":"回答A"}'}),{own:'回答A'});
});

test('public form definition does not allow unauthenticated writes',async()=>{
  const f=setup();
  const response=await worker.fetch(new Request('https://fixture.invalid/api/forms/fixture-form',{method:'PUT',headers:{'content-type':'application/json'},body:'{"title":"禁止"}'}),f.env,{} as any);
  assert.equal(response.status,401);
});

test('bound worker and discovery queries cannot bypass staff grants',async()=>{
  const f=setup('b');
  assert.equal((await f.request('/api/scenarios','GET',undefined,'fixture-staff-key')).status,403);
  assert.deepEqual((await f.request('/api/line-accounts?lineAccountId=b','GET',undefined,'fixture-staff-key')).data.data,[]);
});

test('concurrent reminder runs claim once; uncertain failures are not blindly retried',async()=>{
  const f=setup();
  const r=await createReminder(f.db,{name:'架空通知',lineAccountId:'a',isActive:true});
  await createReminderStep(f.db,{reminderId:r.id,offsetMinutes:0,messageType:'text',messageContent:'架空通知'});
  const fr=await enrollFriendInReminder(f.db,{friendId:'friend-a',reminderId:r.id,targetDate:'2020-01-01T00:00:00+09:00'});
  const client=new LineClient('fixture-fallback-never-use');
  await Promise.all([processReminderDeliveries(f.db,client,'a'),processReminderDeliveries(f.db,client,'a')]);
  assert.equal(outbound.filter(c=>c.url.endsWith('/message/push')).length,1);
  assert.equal(f.sql.prepare('SELECT status FROM friend_reminder_deliveries').get().status,'sent');
  const r2=await createReminder(f.db,{name:'架空失敗',lineAccountId:'a',isActive:true});
  await createReminderStep(f.db,{reminderId:r2.id,offsetMinutes:0,messageType:'text',messageContent:'架空失敗'});
  await enrollFriendInReminder(f.db,{friendId:'friend-a',reminderId:r2.id,targetDate:'2020-01-01T00:00:00+09:00'});
  let attempts=0;
  globalThis.fetch=async()=>{attempts++;throw new Error('fixture ambiguous timeout')};
  await processReminderDeliveries(f.db,client,'a');
  await processReminderDeliveries(f.db,client,'a');
  assert.equal(attempts,1);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM friend_reminder_deliveries WHERE status='failed'").get().n,1);
  assert.equal(f.sql.prepare('SELECT status FROM friend_reminders WHERE id=?').get(fr.id).status,'completed');
});

test('stop during delivery survives late completion and blocks an automatic retry',async()=>{
  const f=setup();
  const b=await createBroadcast(f.db,{title:'架空停止',messageType:'text',messageContent:'架空',targetType:'all',lineAccountId:'a'});
  globalThis.fetch=async()=>{await f.request('/api/account-stop','POST',{kind:'broadcasts'});return new Response('{}',{headers:{'x-line-request-id':'fixture-request'}})};
  await assert.rejects(processBroadcastSend(f.db,new LineClient('fixture'),b.id));
  assert.equal(f.sql.prepare('SELECT status FROM broadcasts WHERE id=?').get(b.id).status,'draft');
  await assert.rejects(processBroadcastSend(f.db,new LineClient('fixture'),b.id));
  const s=await createScenario(f.db,{name:'架空登録',triggerType:'manual',lineAccountId:'a'});
  await createScenarioStep(f.db,{scenarioId:s.id,stepOrder:1,delayMinutes:0,messageType:'text',messageContent:'架空'});
  const fs=await enrollFriendInScenario(f.db,'friend-a',s.id);
  await updateScenario(f.db,s.id,{is_active:0});
  await advanceFriendScenario(f.db,fs.id,2,'2099-01-01T00:00:00+09:00');
  await completeFriendScenario(f.db,fs.id);
  assert.deepEqual({...f.sql.prepare('SELECT status,next_delivery_at FROM friend_scenarios WHERE id=?').get(fs.id)},{status:'paused',next_delivery_at:null});
});

test('public form and profile require verified identity before changing answers or sending',async()=>{
  const f=setup();
  f.sql.exec("UPDATE line_accounts SET login_channel_id='fixture-login-a' WHERE id='a'");
  const form=await createForm(f.db,{name:'架空回答',fields:'[]',lineAccountId:'a',saveToMetadata:true,onSubmitMessageType:'text',onSubmitMessageContent:'架空結果'});
  const path='/api/forms/'+form.id+'/submit';
  assert.equal((await f.request(path,'POST',{friendId:'friend-b',data:{answer:'禁止'}},'')).status,404);
  assert.equal((await f.request(path,'POST',{friendId:'friend-a',data:{answer:'禁止'}},'')).status,401);
  assert.equal((await f.request(path,'POST',{friendId:'friend-a',idToken:'fixture-id-b',data:{answer:'禁止'}},'')).status,403);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM form_submissions').get().n,0);
  assert.equal((await f.request('/api/liff/profile','POST',{lineUserId:'user-a'},'')).status,401);
  assert.equal((await f.request(path,'POST',{friendId:'friend-a',idToken:'fixture-id-a',data:{answer:'回答A'}},'')).status,201);
  assert.equal(JSON.parse(f.sql.prepare("SELECT metadata FROM friends WHERE id='friend-a'").get().metadata).answer,'回答A');
  assert.equal(f.sql.prepare("SELECT metadata FROM friends WHERE id='friend-b'").get().metadata,'{}');
  assert.equal(outbound.filter(c=>c.url.endsWith('/message/push')).length,1);
  assert.equal(outbound.find(c=>c.url.endsWith('/message/push')).token,'Bearer fixture-token-a');
});

test('scoring, notifications, webhooks and conversion reports stay within the event account',async()=>{
  const f=setup();
  for (const account of ['a','b',null]) {
    await createScoringRule(f.db,{name:'架空',eventType:'tag_change',scoreValue:5,lineAccountId:account});
    await createNotificationRule(f.db,{name:'架空',eventType:'tag_change',lineAccountId:account});
    await createOutgoingWebhook(f.db,{name:'架空',url:'https://fixture.invalid/webhook/'+account,eventTypes:['tag_change'],lineAccountId:account});
  }
  await fireEvent(f.db,'tag_change',{friendId:'friend-a'});
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM friend_scores WHERE friend_id='friend-a'").get().n,1);
  assert.deepEqual(f.sql.prepare('SELECT line_account_id FROM notifications').all().map((r:any)=>r.line_account_id),['a']);
  assert.deepEqual(outbound.map(c=>c.url),['https://fixture.invalid/webhook/a']);
  for (const account of ['a','b']) {
    const cp=await createConversionPoint(f.db,{name:'架空 '+account,eventType:'interview',value:100,lineAccountId:account});
    await trackConversion(f.db,{conversionPointId:cp.id,friendId:'friend-'+account});
  }
  assert.equal((await getConversionEvents(f.db,{lineAccountId:'a'})).length,1);
  const report=await getConversionReport(f.db,{lineAccountId:'a',startDate:'2020-01-01'});
  assert.equal(report.length,1);assert.equal(report[0].totalCount,1);assert.equal(report[0].totalValue,100);
  assert.equal((await getConversionReport(f.db,{lineAccountId:'a',startDate:'2099-01-01'}))[0].totalValue,0);
});

test('preloaded automation stops remaining actions and malformed rules do not block valid rules',async()=>{
  const f=setup();
  const bad=await createAutomation(f.db,{name:'架空旧不正定義',eventType:'message_received',isActive:true,lineAccountId:'a',actions:[]});
  f.sql.prepare('UPDATE automations SET conditions=? WHERE id=?').run('{invalid',bad.id);
  await createAutomation(f.db,{name:'架空停止',eventType:'message_received',isActive:true,lineAccountId:'a',actions:[{type:'send_message',params:{content:'1通目'}},{type:'send_message',params:{content:'2通目は禁止'}}]});
  let sends=0;
  globalThis.fetch=async()=>{sends++;await f.request('/api/account-stop','POST',{kind:'all-automation'});return new Response('{}')};
  await fireEvent(f.db,'message_received',{friendId:'friend-a'});
  assert.equal(sends,1);
  assert.equal(f.sql.prepare("SELECT status FROM automation_logs WHERE automation_id!=?").get(bad.id).status,'partial');
});

test('send preview counts only owned recipients and tracking rejects cross-account clicks',async()=>{
  const f=setup();
  await addTagToFriend(f.db,'friend-a','tag-a');
  f.sql.prepare('INSERT INTO friend_tags(friend_id,tag_id) VALUES (?,?)').run('friend-b','tag-a');
  const b=await createBroadcast(f.db,{title:'架空確認',messageType:'text',messageContent:'架空',targetType:'tag',targetTagId:'tag-a',lineAccountId:'a'});
  const preview=await f.request('/api/broadcasts/'+b.id+'/preview');
  assert.equal(preview.data.data.accountId,'a');assert.equal(preview.data.data.recipientCount,1);assert.equal(outbound.length,0);
  const link=await createTrackedLink(f.db,{name:'架空',originalUrl:'https://fixture.invalid/destination',lineAccountId:'a'});
  assert.equal((await f.request('/t/'+link.id+'?f=friend-b','GET',undefined,'')).status,404);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM link_clicks').get().n,0);
  assert.equal((await f.request('/api/meet-callback','POST',{line_user_id:'user-a'},'')).status,401);
  f.sql.prepare('UPDATE broadcasts SET message_content=? WHERE id=?').run('架空 https://fixture.invalid/detail',b.id);
  await processBroadcastSend(f.db,new LineClient('fixture'),b.id,'https://fixture.invalid');
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM tracked_links WHERE line_account_id IS NULL').get().n,0);
  assert.deepEqual(outbound[0].body.to,['user-a']);
});

test('ad conversions require explicit account mapping and OAuth cannot fall back to another account',async()=>{
  const f=setup();
  const res=await worker.fetch(new Request('https://fixture.invalid/auth/line?account=channel-a'),f.env,{} as any);
  assert.equal(res.status,403);assert.equal(outbound.length,0);
  await recordRefTracking(f.db,{refCode:'fixture',friendId:'friend-a',fbclid:'fixture-click'});
  const platform=await createAdPlatform(f.db,{name:'meta',config:{pixel_id:'fixture-pixel',access_token:'fixture-ad-token'}});
  await sendAdConversions(f.db,'friend-a','fixture-event');
  f.sql.prepare('UPDATE ad_platforms SET config=? WHERE id=?').run(JSON.stringify({line_account_id:'b',pixel_id:'fixture-pixel',access_token:'fixture-ad-token'}),platform.id);
  await sendAdConversions(f.db,'friend-a','fixture-event');
  assert.equal(outbound.length,0);
  f.sql.prepare('UPDATE ad_platforms SET config=? WHERE id=?').run(JSON.stringify({line_account_id:'a',pixel_id:'fixture-pixel',access_token:'fixture-ad-token'}),platform.id);
  globalThis.fetch=async(input,init:any)=>{assert.equal(String(input),'https://graph.facebook.com/v21.0/fixture-pixel/events');outbound.push(JSON.parse(init.body));return new Response('{}')};
  await sendAdConversions(f.db,'friend-a','fixture-event');
  assert.equal(outbound.length,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM ad_conversion_logs').get().n,1);
});
