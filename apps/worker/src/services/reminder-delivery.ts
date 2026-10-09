import { extractFlexAltText } from '../utils/flex-alt-text.js';

/**
 * リマインダ配信処理 — cronトリガーで定期実行
 *
 * target_date + offset_minutes の時刻が現在時刻以前で
 * まだ配信されていないステップを配信する
 */

import {
  getDueReminderDeliveries,
  markReminderStepDelivered,
  completeReminderIfDone,
  getFriendById,
  jstNow,
} from '@line-crm/db';
import type { LineClient, Message } from '@line-crm/line-sdk';
import { addJitter, sleep } from './stealth.js';
import { resolveDeliveryClient } from './line-client-resolver.js';

export async function processReminderDeliveries(
  db: D1Database,
  lineClient: LineClient,
  accountScope?: string,
): Promise<void> {
  const now = jstNow();
  const dueReminders = await getDueReminderDeliveries(db, now);

  for (let i = 0; i < dueReminders.length; i++) {
    const fr = dueReminders[i];
    try {
      // ステルス: バースト回避のためランダム遅延
      if (i > 0) {
        await sleep(addJitter(50, 200));
      }

      const friend = await getFriendById(db, fr.friend_id);
      if (!friend || !friend.is_following) {
        // フォロー解除済み — スキップ
        continue;
      }

      // フレンドの line_account_id から正しい LINE クライアントを解決する
      if (accountScope && friend.line_account_id !== accountScope) continue;
      const deliveryClient = await resolveDeliveryClient(db, friend.line_account_id, lineClient);

      for (const step of fr.steps) {
        const eligible=await db.prepare(`SELECT fr.id FROM friend_reminders fr JOIN reminders r ON r.id=fr.reminder_id JOIN friends f ON f.id=fr.friend_id JOIN line_accounts a ON a.id=f.line_account_id WHERE fr.id=? AND fr.status='active' AND r.is_active=1 AND a.is_active=1 AND f.is_following=1 AND r.line_account_id=f.line_account_id`).bind(fr.id).first();
        if (!eligible) break;
        const message = buildMessage(step.message_type, step.message_content);
        const claimId=crypto.randomUUID();
        const claimed=await db.prepare(`INSERT INTO friend_reminder_deliveries(id,friend_reminder_id,reminder_step_id,status)
          VALUES (?,?,?,'pending') ON CONFLICT(friend_reminder_id,reminder_step_id) DO NOTHING RETURNING id`)
          .bind(claimId,fr.id,step.id).first();
        if (!claimed) continue;
        try {
          const stillEligible=await db.prepare(`SELECT fr.id FROM friend_reminders fr JOIN reminders r ON r.id=fr.reminder_id JOIN friends f ON f.id=fr.friend_id JOIN line_accounts a ON a.id=f.line_account_id WHERE fr.id=? AND fr.status='active' AND r.is_active=1 AND a.is_active=1 AND f.is_following=1 AND r.line_account_id=f.line_account_id`).bind(fr.id).first();
          if (!stillEligible) {await db.prepare('DELETE FROM friend_reminder_deliveries WHERE id=?').bind(claimId).run();break;}
          await deliveryClient.pushMessage(friend.line_user_id, [message]);
        } catch(error) {
          // A timeout can mean LINE accepted the send. Keep the claim for manual review.
          await db.prepare("UPDATE friend_reminder_deliveries SET status='failed' WHERE id=?").bind(claimId).run();
          throw error;
        }

        // メッセージログに記録
        const logId = crypto.randomUUID();
        await db
          .prepare(
            `INSERT INTO messages_log (id, friend_id, direction, message_type, content, created_at)
             VALUES (?, ?, 'outgoing', ?, ?, ?)`,
          )
          .bind(logId, friend.id, step.message_type, step.message_content, jstNow())
          .run();

        // 配信済みを記録
        await markReminderStepDelivered(db, fr.id, step.id);
      }

      // 全ステップ配信済みかチェック
      await completeReminderIfDone(db, fr.id, fr.reminder_id);
    } catch (err) {
      console.error(`リマインダ配信エラー (friend_reminder ${fr.id}):`, err);
    }
  }
}

function buildMessage(messageType: string, messageContent: string, altText?: string): Message {
  if (messageType === 'text') {
    return { type: 'text', text: messageContent };
  }
  if (messageType === 'image') {
    try {
      const parsed = JSON.parse(messageContent) as { originalContentUrl: string; previewImageUrl: string };
      return { type: 'image', originalContentUrl: parsed.originalContentUrl, previewImageUrl: parsed.previewImageUrl };
    } catch {
      return { type: 'text', text: messageContent };
    }
  }
  if (messageType === 'flex') {
    try {
      const contents = JSON.parse(messageContent);
      return { type: 'flex', altText: altText || extractFlexAltText(contents), contents };
    } catch {
      return { type: 'text', text: messageContent };
    }
  }
  return { type: 'text', text: messageContent };
}
