import { jstNow } from '@line-crm/db';

export async function claimBroadcast(db:D1Database, id:string):Promise<void> {
  const claimed=await db.prepare(`UPDATE broadcasts SET status='sending'
    WHERE id=? AND status IN ('draft','scheduled') AND success_count=0
    AND line_request_id IS NULL AND aggregation_unit IS NULL
    AND EXISTS (SELECT 1 FROM line_accounts a WHERE a.id=broadcasts.line_account_id AND a.is_active=1)
    RETURNING id`).bind(id).first();
  if (!claimed) throw new Error('Broadcast cannot be started: already attempted, sending, sent or inactive');
}

export async function assertBroadcastSending(db:D1Database,id:string):Promise<void> {
  const row=await db.prepare(`SELECT b.id FROM broadcasts b JOIN line_accounts a ON a.id=b.line_account_id
    WHERE b.id=? AND b.status='sending' AND a.is_active=1`).bind(id).first();
  if (!row) throw new Error('Broadcast was stopped');
}

export async function finishBroadcast(db:D1Database,id:string,total:number,success:number):Promise<void> {
  const row=await db.prepare(`UPDATE broadcasts SET status='sent',sent_at=?,total_count=?,success_count=?
    WHERE id=? AND status='sending' RETURNING id`).bind(jstNow(),total,success,id).first();
  if (!row) throw new Error('Broadcast was stopped during delivery');
}

export async function failBroadcast(db:D1Database,id:string,total:number,success:number):Promise<void> {
  // Preserve the stop state and partial counts. Recorded tracking IDs prevent a blind resend.
  await db.prepare(`UPDATE broadcasts SET status='draft',scheduled_at=NULL,total_count=?,success_count=?
    WHERE id=? AND status IN ('draft','sending')`).bind(total,success,id).run();
}
