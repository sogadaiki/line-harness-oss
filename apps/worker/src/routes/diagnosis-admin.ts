import { Hono } from 'hono';
import type { Env } from '../index.js';
import {requireRole} from '../middleware/role-guard.js';
import {diagnosisPaused} from '../services/hinatama-diagnosis.js';

const diagnosisAdmin = new Hono<Env>();
diagnosisAdmin.get('/api/diagnosis/status', async c => {
  const id = c.get('scopedAccountId');
  if (!id || id !== c.env.SCOPED_LINE_ACCOUNT_ID) return c.json({success:false,error:'Dedicated account required'},403);
  const data = await c.env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM friends WHERE line_account_id=? AND is_following=1) AS friends,
    (SELECT COUNT(*) FROM messages_log m JOIN friends f ON f.id=m.friend_id WHERE f.line_account_id=? AND m.delivery_type='push' AND LENGTH(m.id)=66 AND SUBSTR(m.id,65)=':0') AS resultsAccepted,
    (SELECT COUNT(*) FROM chats WHERE line_account_id=? AND status='unread') AS unreadChats,
    (SELECT COUNT(*) FROM hinatama_diagnosis_content WHERE line_account_id=?) AS replies,
    (SELECT COUNT(*) FROM hinatama_diagnosis_sessions WHERE line_account_id=? AND status='failed' AND expires_at>unixepoch()) AS currentFailures
  `).bind(id,id,id,id,id).first();
  return c.json({success:true,data:{...data,paused:await diagnosisPaused(c.env.DB,id)}});
});
diagnosisAdmin.post('/api/diagnosis/:action',requireRole('owner','admin'),async c=>{
  const id=c.get('scopedAccountId'),action=c.req.param('action');
  if(!id||id!==c.env.SCOPED_LINE_ACCOUNT_ID) return c.json({success:false,error:'Dedicated account required'},403);
  if(!['pause','resume'].includes(action||'')) return c.json({success:false,error:'Unknown action'},400);
  const pause=action==='pause';
  const operations=[c.env.DB.prepare("INSERT INTO hinatama_diagnosis_control(line_account_id,is_paused) VALUES(?,?) ON CONFLICT(line_account_id) DO UPDATE SET is_paused=excluded.is_paused,updated_at=datetime('now')").bind(id,pause?1:0)];
  if(pause) operations.push(c.env.DB.prepare("UPDATE hinatama_diagnosis_sessions SET status='cancelled',claimed=1,nonce=NULL,verifier=NULL WHERE line_account_id=? AND status IN ('pending','awaiting_friend','failed','sending')").bind(id));
  await c.env.DB.batch(operations);
  const paused=await diagnosisPaused(c.env.DB,id);
  if(paused!==pause) return c.json({success:false,error:'Control readback failed'},500);
  return c.json({success:true,data:{accountId:id,paused}});
});
export { diagnosisAdmin };
