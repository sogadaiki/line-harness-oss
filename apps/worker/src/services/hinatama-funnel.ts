/** First-party random-ID milestones. Never accepts answers, result codes or LINE identity. */
export const funnelId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const observationHours = 24;
export type FunnelContext = {lp_version:string;source:string;medium:string;campaign:string;content:string;ref:string};
type Event = {key:string;at:number};
type Packet = {kind:'visit'|'attempt';id:string;visit_id?:string;started_at:number;sent_at:number;context:FunnelContext;events:Event[]};
const fields = ['lp_version','source','medium','campaign','content','ref'] as const;
const allowed:Record<string,readonly string[]> = {
  source:['meta','google','direct','unknown'],medium:['paid_social','cpc','none','unknown'],
  campaign:['hinatama_oct2026_d01','none','unknown'],content:['image_style','rsa_style','video_v03_questions','video_v04_firststep','video_v05_schedule','none','unknown'],
  ref:['m-d01-style','g-d01-style','m-d01-v03','m-d01-v04','m-d01-v05','none','unknown']
};
const object=(v:unknown):v is Record<string,unknown> => !!v && typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:readonly string[])=>Object.keys(v).every(k=>keys.includes(k));
export function parseFunnel(v:unknown,now:number):Packet|null {
  if(!object(v)||!exact(v,['kind','id','visit_id','started_at','context','events','sent_at']))return null;
  if(v.kind!=='visit'&&v.kind!=='attempt'||typeof v.id!=='string'||!funnelId.test(v.id))return null;
  if(!Number.isInteger(v.started_at)||!Number.isInteger(v.sent_at)||Math.abs(Number(v.sent_at)-now)>300||Number(v.started_at)<Number(v.sent_at)-86400||Number(v.started_at)>Number(v.sent_at))return null;
  if(!object(v.context)||!exact(v.context,fields)||fields.some(k=>typeof (v.context as Record<string,unknown>)[k]!=='string'))return null;
  const ctx=v.context as unknown as FunnelContext;
  if(!/^(20261013-funnel-v1|20261021-q1-v1)$/.test(ctx.lp_version)||fields.some(k=>k!=='lp_version'&&!allowed[k].includes(ctx[k])))return null;
  if(v.kind==='visit') {
    if(v.visit_id!==undefined||v.events!==undefined)return null;
    return {kind:'visit',id:v.id,started_at:Number(v.started_at),sent_at:Number(v.sent_at),context:ctx,events:[]};
  }
  if(typeof v.visit_id!=='string'||!funnelId.test(v.visit_id)||!Array.isArray(v.events)||v.events.length<1||v.events.length>19)return null;
  const events:Event[]=[];
  for(const e of v.events) {
    if(!object(e)||!exact(e,['key','at'])||typeof e.key!=='string'||!/^(start|v[1-8]|q[1-8]|complete|line_cta)$/.test(e.key)||!Number.isInteger(e.at)||Number(e.at)<Number(v.started_at)||Number(e.at)>Math.min(Number(v.sent_at),Number(v.started_at)+86400)||events.some(x=>x.key===e.key))return null;
    events.push({key:e.key,at:Number(e.at)});
  }
  if(!events.some(e=>e.key==='start'&&e.at===v.started_at))return null;
  return {kind:'attempt',id:v.id,visit_id:v.visit_id,started_at:Number(v.started_at),sent_at:Number(v.sent_at),context:ctx,events};
}
export async function collectFunnel(db:D1Database,accountId:string,p:Packet):Promise<void> {
  const ctx=fields.map(k=>p.context[k]),canonicalStart=Math.floor(Date.now()/1000)-(p.sent_at-p.started_at);
  if(p.kind==='visit') {
    await db.prepare('INSERT OR IGNORE INTO hinatama_funnel_visits VALUES(?,?,?,?,?,?,?,?,?,?)').bind(accountId,p.id,canonicalStart,p.started_at,...ctx).run();return;
  }
  // First packet wins cohort/attribution; repeat batches cannot change them.
  await db.prepare('INSERT OR IGNORE INTO hinatama_funnel_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(accountId,p.id,p.visit_id!,canonicalStart,p.started_at,...ctx).run();
  const cohort=await db.prepare('SELECT started_at,client_started_at FROM hinatama_funnel_attempts WHERE line_account_id=? AND attempt_id=?').bind(accountId,p.id).first<{started_at:number;client_started_at:number}>();
  if(!cohort||cohort.client_started_at!==p.started_at)return;
  for(const e of p.events)await db.prepare('INSERT OR IGNORE INTO hinatama_funnel_events VALUES(?,?,?,?)').bind(accountId,p.id,e.key,cohort.started_at+e.at-p.started_at).run();
}
export async function recordReceiptView(db:D1Database,accountId:string,receiptId:string,attemptId:string|null,state:string,displayedState:string=state):Promise<void> {
  const time=Math.floor(Date.now()/1000);
  await db.prepare(`INSERT INTO hinatama_funnel_receipt_views VALUES(?,?,?,?,?,?,?) ON CONFLICT(line_account_id,receipt_id) DO UPDATE SET updated_at=excluded.updated_at,display_state=excluded.display_state,success_viewed_at=COALESCE(hinatama_funnel_receipt_views.success_viewed_at,excluded.success_viewed_at)`).bind(accountId,receiptId,attemptId,time,time,state,state==='sent'&&displayedState==='sent'?time:null).run();
}
/** Called only after verified OAuth identity, never from the anonymous collector. */
export async function linkFunnelFriend(db:D1Database,accountId:string,receiptId:string,attemptId:string|null,friendId:string):Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO hinatama_funnel_links SELECT ?,?,?,id,? FROM friends WHERE id=? AND line_account_id=?`).bind(accountId,receiptId,attemptId,Math.floor(Date.now()/1000),friendId,accountId).run();
}
export type OutcomeKind='follow'|'refollow'|'follow_unknown'|'unfollow'|'inquiry';
/** Caller has verified the LINE webhook signature, destination and event ID. */
export async function recordFunnelOutcome(db:D1Database,accountId:string,friendId:string,eventId:string,kind:OutcomeKind,timestamp?:number):Promise<void> {
  const now=Math.floor(Date.now()/1000);
  const at=typeof timestamp==='number'&&Number.isFinite(timestamp)?Math.floor(timestamp/1000):now;
  if(at<0||at>now+300)return;
  await db.prepare(`INSERT OR IGNORE INTO hinatama_funnel_outcomes SELECT ?,?,id,?,? FROM friends WHERE id=? AND line_account_id=?`).bind(accountId,eventId,kind,at,friendId,accountId).run();
}
type OutcomeCounts={newFriends:number;unblocked:number;unknownFollows:number;inquiries:number};
type OutcomeJoin={event_id:string;kind:OutcomeKind;friend_id:string;occurred_at:number;attempt_id:string;started_at:number;authorized_at:number};
export async function attributedOutcomes(db:D1Database,id:string,begin:number,end:number) {
  const rows=(await db.prepare(`SELECT o.*,l.attempt_id,a.started_at,l.authorized_at
    FROM hinatama_funnel_outcomes o JOIN hinatama_funnel_links l ON l.line_account_id=o.line_account_id AND l.friend_id=o.friend_id
    JOIN hinatama_funnel_attempts a ON a.line_account_id=l.line_account_id AND a.attempt_id=l.attempt_id
    WHERE o.line_account_id=? AND o.occurred_at>=? AND o.occurred_at<? AND a.started_at<=o.occurred_at
      AND o.occurred_at<=a.started_at+604800 AND l.authorized_at<=o.occurred_at+CASE WHEN o.kind IN ('follow','refollow','follow_unknown') THEN 600 ELSE 0 END
      AND NOT EXISTS(SELECT 1 FROM hinatama_funnel_outcomes earlier WHERE earlier.line_account_id=o.line_account_id AND earlier.friend_id=o.friend_id AND earlier.kind=o.kind AND (earlier.occurred_at<o.occurred_at OR (earlier.occurred_at=o.occurred_at AND earlier.event_id<o.event_id)))
      AND NOT EXISTS(SELECT 1 FROM hinatama_funnel_exclusions x WHERE x.line_account_id=o.line_account_id AND x.friend_id=o.friend_id)
    ORDER BY o.occurred_at,o.event_id,l.authorized_at DESC,l.receipt_id DESC`).bind(id,begin,end+604800).all<OutcomeJoin>()).results;
  const byAttempt=new Map<string,OutcomeCounts>(),seenEvents=new Set<string>(),seenFriends=new Set<string>();
  for(const row of rows) {
    if(seenEvents.has(row.event_id))continue;seenEvents.add(row.event_id);
    // Last authenticated diagnosis gets one attribution. Multiple messages and
    // webhook retries cannot count one person twice in the same outcome.
    const unique=row.friend_id+':'+row.kind;
    if(seenFriends.has(unique))continue;seenFriends.add(unique);
    const count=byAttempt.get(row.attempt_id)||{newFriends:0,unblocked:0,unknownFollows:0,inquiries:0};
    if(row.kind==='follow')count.newFriends++;
    if(row.kind==='refollow')count.unblocked++;
    if(row.kind==='follow_unknown')count.unknownFollows++;
    if(row.kind==='inquiry')count.inquiries++;
    byAttempt.set(row.attempt_id,count);
  }
  return byAttempt;
}
type Attempt = FunnelContext & {attempt_id:string;visit_id:string;started_at:number};
type Row = {attempt_id:string;event_key:string;occurred_at:number};
type View = {success_viewed_at:number|null;cohort_start:number|null;receipt_id:string;attempt_id:string|null;viewed_at:number;updated_at:number;display_state:string};
export async function funnelReport(db:D1Database,id:string,from:string,to:string,filters:Record<string,string|undefined>={}) {
  const begin=Math.floor(Date.parse(from+'T00:00:00+09:00')/1000),end=Math.floor(Date.parse(to+'T00:00:00+09:00')/1000)+86400;
  const attempts=(await db.prepare('SELECT * FROM hinatama_funnel_attempts WHERE line_account_id=? AND started_at>=? AND started_at<? ORDER BY started_at').bind(id,begin,end).all<Attempt>()).results;
  const qa=(await db.prepare(`SELECT l.attempt_id,a.visit_id FROM hinatama_funnel_links l JOIN hinatama_funnel_exclusions x ON x.line_account_id=l.line_account_id AND x.friend_id=l.friend_id JOIN hinatama_funnel_attempts a ON a.line_account_id=l.line_account_id AND a.attempt_id=l.attempt_id WHERE l.line_account_id=? AND a.started_at>=? AND a.started_at<?`).bind(id,begin,end).all<{attempt_id:string;visit_id:string}>()).results;
  const qaAttempts=new Set(qa.map(q=>q.attempt_id)),qaVisits=new Set(qa.map(q=>q.visit_id));
  const events=(await db.prepare('SELECT e.* FROM hinatama_funnel_events e JOIN hinatama_funnel_attempts a ON a.line_account_id=e.line_account_id AND a.attempt_id=e.attempt_id WHERE a.line_account_id=? AND a.started_at>=? AND a.started_at<?').bind(id,begin,end).all<Row>()).results;
  const views=(await db.prepare('SELECT v.*,a.started_at AS cohort_start FROM hinatama_funnel_receipt_views v LEFT JOIN hinatama_funnel_attempts a ON a.line_account_id=v.line_account_id AND a.attempt_id=v.attempt_id WHERE v.line_account_id=? AND v.viewed_at>=? AND v.viewed_at<? ORDER BY v.updated_at,v.receipt_id').bind(id,begin,end+86400).all<View>()).results;
  const visits=(await db.prepare('SELECT * FROM hinatama_funnel_visits WHERE line_account_id=? AND started_at>=? AND started_at<?').bind(id,begin,end).all<FunnelContext & {visit_id:string}>()).results;
  const outcomes=await attributedOutcomes(db,id,begin,end);
  const eventsByAttempt=new Map<string,Row[]>(),viewsByAttempt=new Map<string,View[]>();
  for(const e of events){const rows=eventsByAttempt.get(e.attempt_id)||[];rows.push(e);eventsByAttempt.set(e.attempt_id,rows);}
  for(const v of views)if(v.attempt_id){const rows=viewsByAttempt.get(v.attempt_id)||[];rows.push(v);viewsByAttempt.set(v.attempt_id,rows);}
  const keys=['start',...Array.from({length:8},(_,i)=>'q'+(i+1)),'complete','line_cta','result_view'];
  const labels=['1問目表示（旧版は開始クリック）',...Array.from({length:8},(_,i)=>'設問'+(i+1)+'回答完了'),'診断完了','LINE CTA','LINE送信受付済み画面の表示'];
  const groupMap=new Map<string,{lpVersion:string;source:string;medium:string;campaign:string;content:string;ref:string;started:number;receiptPageViews:number;lpViews:number;visitsStarted:number;steps:Array<{key:string;label:string;count:number;dropoff:number|null;rate:number|null}>;questionViews:Array<{questionNumber:number;count:number}>;resultStates:Record<string,number>;visitIds:Set<string>}>();
  const accepted=(c:FunnelContext)=>(!filters.source||c.source===filters.source)&&(!filters.campaign||c.campaign===filters.campaign)&&(!filters.version||c.lp_version===filters.version);
  function group(c:FunnelContext) {
    const key=JSON.stringify(fields.map(k=>c[k]));let g=groupMap.get(key);
    if(!g){g={lpVersion:c.lp_version,source:c.source,medium:c.medium,campaign:c.campaign,content:c.content,ref:c.ref,started:0,receiptPageViews:0,lpViews:0,visitsStarted:0,steps:keys.map((key,i)=>({key,label:labels[i],count:0,dropoff:null,rate:null})),questionViews:Array.from({length:8},(_,i)=>({questionNumber:i+1,count:0})),resultStates:{pending:0,sending:0,awaiting_friend:0,sent:0,cancelled:0,failed:0},visitIds:new Set()};groupMap.set(key,g);}return g;
  }
  for(const v of visits)if(accepted(v)&&!qaVisits.has(v.visit_id))group(v).lpViews++;
  for(const a of attempts) {
    if(!accepted(a)||qaAttempts.has(a.attempt_id))continue;const g=group(a),endAt=a.started_at+86400;
    const es=new Map((eventsByAttempt.get(a.attempt_id)||[]).filter(e=>e.occurred_at>=a.started_at&&e.occurred_at<=endAt).map(e=>[e.event_key,e.occurred_at]));
    if(!es.has('start'))continue;g.started++;g.visitIds.add(a.visit_id);
    const receipt=(viewsByAttempt.get(a.attempt_id)||[]).filter(v=>v.viewed_at>=a.started_at&&v.viewed_at<=endAt);
    const successViews=receipt.filter(v=>v.success_viewed_at!==null&&v.success_viewed_at>=a.started_at&&v.success_viewed_at<=endAt);
    if(successViews.length)es.set('result_view',Math.min(...successViews.map(v=>v.success_viewed_at!)));
    let previous=a.started_at,throughCta=false;
    for(const step of g.steps){const at=es.get(step.key),viewAt=step.key.startsWith('q')?es.get('v'+step.key.slice(1)):undefined;if(at===undefined||at<previous||step.key.startsWith('q')&&(viewAt===undefined||viewAt<previous||viewAt>at)){break;}step.count++;previous=at;if(step.key==='line_cta')throughCta=true;}
    let answeredAt=a.started_at;for(const q of g.questionViews){const seen=es.get('v'+q.questionNumber),answered=es.get('q'+q.questionNumber);if(seen===undefined||seen<answeredAt)break;q.count++;if(answered===undefined||answered<seen)break;answeredAt=answered;}
    if(throughCta&&receipt.length){g.receiptPageViews++;const last=receipt[receipt.length-1];if(last.display_state in g.resultStates)g.resultStates[last.display_state]++;}
  }
  for(const g of groupMap.values()) {
    // Visit conversion stays separate because one visit may contain multiple diagnoses.
    g.visitsStarted=visits.filter(v=>accepted(v)&&JSON.stringify(fields.map(k=>v[k]))===JSON.stringify([g.lpVersion,g.source,g.medium,g.campaign,g.content,g.ref])&&g.visitIds.has(v.visit_id)).length;
    g.steps.forEach((s,i)=>{s.dropoff=i?g.steps[i-1].count-s.count:null;s.rate=g.started?s.count/g.started:null;});
  }
  return {from,to,timezone:'Asia/Tokyo',observationHours,outcomeObservationDays:7,attributionModel:'last_authenticated_diagnosis',asOf:Math.floor(Date.now()/1000),groups:[...groupMap.values()].map(({visitIds,...g})=>{
    const counts:OutcomeCounts={newFriends:0,unblocked:0,unknownFollows:0,inquiries:0};
    for(const a of attempts)if(accepted(a)&&JSON.stringify(fields.map(k=>a[k]))===JSON.stringify([g.lpVersion,g.source,g.medium,g.campaign,g.content,g.ref])){
      const o=outcomes.get(a.attempt_id);if(o)for(const key of Object.keys(counts) as (keyof OutcomeCounts)[])counts[key]+=o[key];
    }
    return {...g,outcomes:counts};
  }),unattributedResultViews:views.filter(v=>v.viewed_at<end&&v.cohort_start===null).length};
}
