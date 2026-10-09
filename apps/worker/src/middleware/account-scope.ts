import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Env } from '../index.js';

const resources: Record<string, string> = {
  friends: 'friends', tags: 'tags', scenarios: 'scenarios', broadcasts: 'broadcasts',
  reminders: 'reminders', automations: 'automations', 'auto-replies': 'auto_replies',
  chats: 'chats', templates: 'templates', 'message-templates': 'message_templates',
  forms: 'forms', 'tracked-links': 'tracked_links', 'scoring-rules': 'scoring_rules',
  'notifications/rules': 'notification_rules', 'webhooks/incoming': 'incoming_webhooks',
  'webhooks/outgoing': 'outgoing_webhooks', 'conversions/points': 'conversion_points',
};
const references: Record<string, string> = {
  friendId: 'friends', tagId: 'tags', triggerTagId: 'tags', targetTagId: 'tags',
  scenarioId: 'scenarios', reminderId: 'reminders', formId: 'forms',
  onSubmitTagId: 'tags', onSubmitScenarioId: 'scenarios', conversionPointId: 'conversion_points',
};

export async function assertAccountResource(db: D1Database, table: string, id: string, accountId: string): Promise<void> {
  // table is an internal allowlisted constant, never a client string.
  const sql = table==='chats'
    ? `SELECT f.line_account_id FROM chats c JOIN friends f ON f.id=c.friend_id WHERE c.id=? AND (c.line_account_id IS NULL OR c.line_account_id=f.line_account_id)`
    : `SELECT line_account_id FROM ${table} WHERE id = ?`;
  const row = await db.prepare(sql).bind(id).first<{line_account_id: string | null}>();
  if (!row || row.line_account_id !== accountId) throw new HTTPException(404, { message: 'Resource not found in selected account' });
}

/** Every protected account operation requires an explicit, authorized account. */
export async function accountScopeMiddleware(c: Context<Env>, next: Next) {
  const staff = c.get('staff');
  const path = new URL(c.req.url).pathname;
  // These public legacy features have no account ownership model yet.
  if (c.env.SCOPED_LINE_ACCOUNT_ID && (path.startsWith('/pool/') || path === '/api/integrations/stripe/webhook')) throw new HTTPException(403,{message:'This global feature is unavailable on an account-scoped worker'});
  if (!path.startsWith('/api/') || path.startsWith('/api/auth/') || path === '/api/staff' || path.startsWith('/api/staff/')) return next();
  if (!staff) {
    // Public forms have a separate identity flow, but still cannot cross the worker's account.
    const form = path.match(/^\/api\/forms\/([^/]+)(?:\/submit)?$/);
    if (form && c.env.SCOPED_LINE_ACCOUNT_ID) await assertAccountResource(c.env.DB,'forms',form[1],c.env.SCOPED_LINE_ACCOUNT_ID);
    return next();
  }
  let body: Record<string, unknown> = {};
  if (['POST', 'PUT', 'PATCH'].includes(c.req.method) && c.req.header('content-type')?.includes('application/json')) {
    try { body = await c.req.json(); } catch { throw new HTTPException(400, {message: 'Invalid JSON'}); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HTTPException(400, {message: 'Expected JSON object'});
  }
  const bound = c.env.SCOPED_LINE_ACCOUNT_ID;
  const queryAccount = c.req.query('lineAccountId') || c.req.query('accountId');
  const bodyAccount = body.lineAccountId;
  if (bodyAccount !== undefined && (typeof bodyAccount !== 'string' || !bodyAccount)) throw new HTTPException(400, {message: 'lineAccountId must be a nonempty string'});
  if (queryAccount && bodyAccount && queryAccount !== bodyAccount) throw new HTTPException(403, {message: 'Conflicting account selection'});
  const requested = queryAccount || bodyAccount as string | undefined;
  if (bound && requested && requested !== bound) throw new HTTPException(403, {message: 'Account is outside this worker scope'});

  // Account discovery is separate from resource operations; registration is owner-only.
  if (path === '/api/line-accounts' && c.req.method === 'GET') {
    if (bound) c.set('scopedAccountId', bound);
    return next();
  }
  if (path === '/api/line-accounts' && c.req.method === 'POST') {
    if (bound || staff.role !== 'owner') throw new HTTPException(403, {message:'Account registration is not permitted here'});
    return next();
  }
  const accountId = bound || requested;
  if (!accountId) throw new HTTPException(400, {message:'Select a LINE account before operating'});
  const account = await c.env.DB.prepare('SELECT id, is_active FROM line_accounts WHERE id = ?').bind(accountId).first<{id:string;is_active:number}>();
  if (!account) throw new HTTPException(404, {message:'Selected account not found'});
  if (staff.role !== 'owner') {
    let grant;
    try { grant = await c.env.DB.prepare('SELECT 1 AS allowed FROM staff_line_accounts WHERE staff_id = ? AND line_account_id = ?').bind(staff.id, accountId).first(); }
    catch { throw new HTTPException(403, {message:'Account permissions have not been configured'}); }
    if (!grant) throw new HTTPException(403, {message:'Account access not granted'});
  }
  c.set('scopedAccountId', accountId);

  // Global identity/finance/pool operations need their own ownership model;
  // a selected account must not grant access to global data by accident.
  const globalPrefixes=['/api/users','/api/affiliates','/api/affiliates-report','/api/operators','/api/ad-platforms','/api/integrations','/api/accounts/migrations','/api/traffic-pools'];
  if (globalPrefixes.some(prefix=>path===prefix || path.startsWith(prefix+'/'))) {
    if (bound || staff.role !== 'owner') throw new HTTPException(403,{message:'全体管理用の機能です。このアカウント専用画面では操作できません。'});
    return next(); // Only the explicit owner console can use legacy global administration.
  }
  if (/^\/api\/accounts\/[^/]+\/migrate$/.test(path)) throw new HTTPException(409,{message:'Migration is not a completed account transfer. Prepare and review a separate migration plan.'});

  const parts = path.slice(5).split('/');
  if (parts[0] === 'line-accounts' || (parts[0] === 'accounts' && parts[1] !== 'migrations')) {
    if (parts[1] !== accountId) throw new HTTPException(404, {message:'Account not found in selected scope'});
  }
  for (const [prefix, table] of Object.entries(resources)) {
    const base = `/api/${prefix}`;
    if (path.startsWith(base + '/')) {
      const id = path.slice(base.length + 1).split('/')[0];
      if (['count','ref-stats','send','wrap','score','rules'].includes(id)) continue;
      await assertAccountResource(c.env.DB, table, decodeURIComponent(id), accountId);
    }
  }
  // Nested IDs must belong to the requested parent, not merely the account.
  const stepMatch = path.match(/^\/api\/(scenarios|reminders)\/([^/]+)\/steps\/([^/]+)$/);
  if (stepMatch) {
    const parent = stepMatch[1] === 'scenarios' ? 'scenario' : 'reminder';
    const row = await c.env.DB.prepare(`SELECT ${parent}_id AS parent_id FROM ${parent}_steps WHERE id = ?`).bind(stepMatch[3]).first<{parent_id:string}>();
    if (!row || row.parent_id !== stepMatch[2]) throw new HTTPException(404, {message:'Step not found in parent'});
  }
  const enroll = path.match(/\/enroll\/([^/]+)$/);
  if (enroll) await assertAccountResource(c.env.DB, 'friends', decodeURIComponent(enroll[1]), accountId);
  const friendReminder = path.match(/^\/api\/friend-reminders\/([^/]+)$/);
  if (friendReminder) {
    const row = await c.env.DB.prepare('SELECT f.line_account_id FROM friend_reminders fr JOIN friends f ON f.id=fr.friend_id JOIN reminders r ON r.id=fr.reminder_id WHERE fr.id=? AND r.line_account_id=f.line_account_id').bind(friendReminder[1]).first<{line_account_id:string}>();
    if (!row || row.line_account_id !== accountId) throw new HTTPException(404,{message:'Reminder registration not found in selected account'});
  }
  const tag = path.match(/^\/api\/friends\/[^/]+\/tags\/([^/]+)$/);
  if (tag) await assertAccountResource(c.env.DB, 'tags', decodeURIComponent(tag[1]), accountId);
  for (const [field, table] of Object.entries(references)) {
    const queryValue = c.req.query(field);
    if (queryValue) await assertAccountResource(c.env.DB,table,queryValue,accountId);
    if (body[field] !== undefined && body[field] !== null) {
      if (typeof body[field] !== 'string') throw new HTTPException(400,{message:`${field} must be a string`});
      await assertAccountResource(c.env.DB, table, body[field] as string, accountId);
    }
  }
  if (body.conditionType === 'tag_exists' || body.conditionType === 'tag_not_exists') {
    if (typeof body.conditionValue !== 'string') throw new HTTPException(400,{message:'Tag condition requires a tag ID'});
    await assertAccountResource(c.env.DB,'tags',body.conditionValue,accountId);
  }
  if (Array.isArray(body.actions)) {
    for (const action of body.actions) {
      if (!action || typeof action !== 'object' || !('params' in action)) continue;
      const params=(action as {params:Record<string,unknown>}).params;
      for (const [field, table] of Object.entries(references)) {
        if (params?.[field] !== undefined) {
          if (typeof params[field] !== 'string') throw new HTTPException(400,{message:`${field} must be a string`});
          await assertAccountResource(c.env.DB,table,params[field] as string,accountId);
        }
      }
    }
  }
  const conditionTag=(body.conditions as {tag_id?:unknown}|undefined)?.tag_id;
  if (conditionTag !== undefined) {
    if (typeof conditionTag !== 'string') throw new HTTPException(400,{message:'tag_id must be a string'});
    await assertAccountResource(c.env.DB,'tags',conditionTag,accountId);
  }
  if (!account.is_active && /\/(send|send-segment|loading|default|image)$/.test(path)) throw new HTTPException(409,{message:'Selected account is inactive'});
  return next();
}
