import { Hono } from 'hono';
import type { Env } from '../index.js';
import { getScope } from '../utils/scope.js';
import { requireRole } from '../middleware/role-guard.js';
import { jstNow } from '@line-crm/db';

export const accountStop = new Hono<Env>();
accountStop.post('/api/account-stop', requireRole('owner', 'admin'), async c => {
  const accountId = getScope(c)!;
  const {kind} = await c.req.json<{kind:string}>();
  if (!['broadcasts','scenarios','all-automation'].includes(kind)) return c.json({success:false,error:'Unknown stop kind'},400);
  const db=c.env.DB,now=jstNow();
  const statements:D1PreparedStatement[]=[];
  if (kind !== 'scenarios') statements.push(db.prepare(`UPDATE broadcasts SET status='draft', scheduled_at=NULL WHERE line_account_id=? AND status IN ('scheduled','sending')`).bind(accountId));
  if (kind !== 'broadcasts') {
    statements.push(db.prepare(`UPDATE scenarios SET is_active=0,updated_at=? WHERE line_account_id=?`).bind(now,accountId));
    statements.push(db.prepare(`UPDATE friend_scenarios SET status='paused',next_delivery_at=NULL,updated_at=? WHERE status='active' AND scenario_id IN (SELECT id FROM scenarios WHERE line_account_id=?)`).bind(now,accountId));
  }
  if (kind === 'all-automation') {
    for (const table of ['automations','auto_replies','reminders','outgoing_webhooks']) statements.push(db.prepare(`UPDATE ${table} SET is_active=0 WHERE line_account_id=?`).bind(accountId));
    statements.push(db.prepare(`UPDATE friend_reminders SET status='cancelled',updated_at=? WHERE status='active' AND reminder_id IN (SELECT id FROM reminders WHERE line_account_id=?)`).bind(now,accountId));
  }
  const results=await db.batch(statements);
  const remaining=await db.prepare(`SELECT
    (SELECT COUNT(*) FROM broadcasts WHERE line_account_id=? AND status IN ('scheduled','sending')) AS broadcasts,
    (SELECT COUNT(*) FROM friend_scenarios fs JOIN scenarios s ON s.id=fs.scenario_id WHERE s.line_account_id=? AND fs.status='active') AS scenarios,
    (SELECT COUNT(*) FROM automations WHERE line_account_id=? AND is_active=1) AS automations,
    (SELECT COUNT(*) FROM auto_replies WHERE line_account_id=? AND is_active=1) AS autoReplies,
    (SELECT COUNT(*) FROM friend_reminders fr JOIN reminders r ON r.id=fr.reminder_id WHERE r.line_account_id=? AND fr.status='active') AS reminders,
    (SELECT COUNT(*) FROM outgoing_webhooks WHERE line_account_id=? AND is_active=1) AS webhooks`).bind(accountId,accountId,accountId,accountId,accountId,accountId).first<Record<string,number>>();
  const required=kind==='broadcasts'?['broadcasts']:kind==='scenarios'?['scenarios']:Object.keys(remaining??{});
  if (!remaining || required.some(key=>remaining[key]>0)) return c.json({success:false,error:'Stop incomplete; check remaining work',data:{accountId,remaining}},409);
  return c.json({success:true,data:{accountId,kind,changed:results.reduce((n,r)=>n+r.meta.changes,0),remaining}});
});
