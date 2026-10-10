export type Message = { type: 'text'; text: string } | { type: 'image'; originalContentUrl: string; previewImageUrl: string };
export type Account = { id: string; channel_id: string; channel_access_token: string; channel_secret: string; is_active: number };
export type Session = { id: string; line_account_id: string; cookie_hash: string; code: string; nonce: string; verifier: string; messages_json: string; expires_at: number; claimed: number; line_user_id: string | null; status: string; retry_key: string; attempted_at: number | null; created_at: number };
export type Bindings = { DB: D1Database; HINATAMA_CHANNEL_ID: string; HINATAMA_LOGIN_CHANNEL_ID: string; HINATAMA_LOGIN_SECRET: string; HINATAMA_BOT_USER_ID: string; HINATAMA_BASIC_ID: string; HINATAMA_WORKER_URL: string; HINATAMA_IMAGE_ORIGIN: string; HINATAMA_DIAGNOSIS_PUBLIC_URL?: string; HINATAMA_BRIDGE_SECRET?: string };
const encoder = new TextEncoder();
export const now = () => Math.floor(Date.now() / 1000);
export const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), v => v.toString(16).padStart(2, '0')).join('');
export async function hash(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), v => v.toString(16).padStart(2,'0')).join(''); }
export async function challenge(verifier: string) { return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
export async function account(env: Bindings): Promise<Account | null> {
  if (!/^\d+$/.test(env.HINATAMA_CHANNEL_ID || '') || !/^\d+$/.test(env.HINATAMA_LOGIN_CHANNEL_ID || '') || !env.HINATAMA_LOGIN_SECRET || !/^U[a-f0-9]{32}$/.test(env.HINATAMA_BOT_USER_ID || '') || !/^@[a-z0-9]+$/.test(env.HINATAMA_BASIC_ID || '') || !/^https:\/\/[^/]+$/.test(env.HINATAMA_WORKER_URL || '')) return null;
  // Never fall back to any existing worker's LINE_* environment or default account.
  return env.DB.prepare('SELECT id,channel_id,channel_access_token,channel_secret,is_active FROM line_accounts WHERE channel_id=? AND is_active=1').bind(env.HINATAMA_CHANNEL_ID).first<Account>();
}
export async function diagnosisPaused(db: D1Database, id: string): Promise<boolean> {
  // A missing control table fails closed; never silently bypass an unapplied migration.
  const row = await db.prepare('SELECT is_paused FROM hinatama_diagnosis_control WHERE line_account_id=?').bind(id).first<{is_paused:number}>();
  return row?.is_paused === 1;
}
export function messages(raw: string, imageOrigin: string): Message[] {
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data) || data.length < 1 || data.length > 5) throw new Error('invalid_content');
  for (const m of data) {
    if (m?.type === 'text' && typeof m.text === 'string' && m.text.length > 0 && m.text.length <= 5000) continue;
    if (m?.type === 'image' && ['originalContentUrl','previewImageUrl'].every(k => { try { const u = new URL(m[k]); return u.origin === imageOrigin && u.protocol === 'https:' && /\.(jpg|jpeg|png)$/.test(u.pathname); } catch { return false; } })) continue;
    throw new Error('invalid_content');
  }
  return data as Message[];
}
export async function verifiedSignature(body: string, signature: string, secret: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['verify']);
    return crypto.subtle.verify('HMAC', key, Uint8Array.from(atob(signature), x=>x.charCodeAt(0)), encoder.encode(body));
  } catch { return false; }
}
export async function api(url: string, init: RequestInit): Promise<Response> { return fetch(url, {...init, signal: AbortSignal.timeout(12000)}); }
export async function friend(db: D1Database, a: Account, uid: string, following: boolean, name?: string): Promise<{id:string;is_following:number}> {
  if (!/^U[a-f0-9]{32}$/.test(uid)) throw new Error('invalid_user');
  // The legacy schema has a globally unique LINE ID. A conflict never moves an old friend into this account.
  await db.prepare("INSERT OR IGNORE INTO friends(id,line_user_id,line_account_id,is_following,display_name,metadata) VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(),uid,a.id,following?1:0,name || null,JSON.stringify({source:'lp07-diagnosis'})).run();
  const f = await db.prepare('SELECT id,is_following,line_account_id FROM friends WHERE line_user_id=?').bind(uid).first<{id:string;is_following:number;line_account_id:string}>();
  if (!f || f.line_account_id !== a.id) throw new Error('account_conflict');
  return f;
}
export async function log(db: D1Database, a: Account, fid: string, id: string, direction: 'incoming'|'outgoing', m: Message | {type:string;text?:string}, delivery: 'push'|'reply'|null) {
  await db.prepare('INSERT OR IGNORE INTO messages_log(id,friend_id,direction,message_type,content,delivery_type) SELECT ?,id,?,?,?,? FROM friends WHERE id=? AND line_account_id=?').bind(id,direction,m.type,JSON.stringify(m),delivery,fid,a.id).run();
}
export async function deliver(env: Bindings, a: Account, sid: string): Promise<void> {
  const db = env.DB;
  if (await diagnosisPaused(db,a.id)) return;
  const s = await db.prepare('SELECT * FROM hinatama_diagnosis_sessions WHERE id=? AND line_account_id=?').bind(sid,a.id).first<Session>();
  if (!s?.line_user_id || s.expires_at <= now() || ['sent','cancelled'].includes(s.status)) return;
  const f = await db.prepare('SELECT id,is_following FROM friends WHERE line_user_id=? AND line_account_id=?').bind(s.line_user_id,a.id).first<{id:string;is_following:number}>();
  if (!f?.is_following) return;
  const content = messages(s.messages_json, env.HINATAMA_IMAGE_ORIGIN);
  const claim = await db.prepare("UPDATE hinatama_diagnosis_sessions SET status='sending',attempted_at=?,last_error=NULL WHERE id=? AND line_account_id=? AND (status IN ('awaiting_friend','failed') OR (status='sending' AND attempted_at<?))").bind(now(),sid,a.id,now()-90).run();
  if (!claim.meta.changes) return;
  try {
    if (await diagnosisPaused(db,a.id)) return;
    const res = await api('https://api.line.me/v2/bot/message/push',{method:'POST',headers:{Authorization:`Bearer ${a.channel_access_token}`,'Content-Type':'application/json','X-Line-Retry-Key':s.retry_key},body:JSON.stringify({to:s.line_user_id,messages:content})});
    const accepted = res.ok || (res.status===409 && !!res.headers.get('X-Line-Accepted-Request-Id'));
    if (!accepted) throw new Error(`line_${res.status}`);
    // Stable IDs make logs idempotent after a process crash / LINE accepted-request retry.
    for (let i=0;i<content.length;i++) await log(db,a,f.id,`${sid}:${i}`,'outgoing',content[i],'push');
    await db.prepare("UPDATE friends SET metadata=json_set(metadata,'$.diagnosis_code',?),updated_at=datetime('now') WHERE id=? AND line_account_id=?").bind(s.code,f.id,a.id).run();
    await db.prepare("UPDATE hinatama_diagnosis_sessions SET status='sent',nonce=NULL,verifier=NULL,last_error=NULL WHERE id=? AND line_account_id=?").bind(sid,a.id).run();
  } catch (e) {
    const error = e instanceof Error && /^line_\d+$/.test(e.message) ? e.message : 'delivery_error';
    await db.prepare("UPDATE hinatama_diagnosis_sessions SET status='failed',last_error=? WHERE id=? AND line_account_id=? AND status!='cancelled'").bind(error,sid,a.id).run();
  }
}
