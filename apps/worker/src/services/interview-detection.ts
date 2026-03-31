/**
 * 面談日時抽出サービス — ユーザーメッセージから日時パターンを検出
 *
 * パダワン（ヒナタマ熊本）向けカスタムロジック。
 * ユーザーが送信した「4月1日18時」「明日14時」等から面談日時を抽出し、
 * Reminder APIで当日リマインド + 翌日フォローを自動登録する。
 */

import {
  getFriendTags,
  enrollFriendInReminder,
  jstNow,
} from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import { buildMessage } from './step-delivery.js';

/** 面談予約済タグ名 */
const INTERVIEW_BOOKED_TAG = '面談予約済';

/** 抽出結果 */
export interface ExtractedDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * 日本語テキストから日時を抽出する
 */
export function extractDateTime(text: string, now: Date): ExtractedDateTime | null {
  // JST基準の現在日時
  const jstNowDate = new Date(now.getTime() + 9 * 60 * 60_000);
  const currentYear = jstNowDate.getUTCFullYear();
  const currentMonth = jstNowDate.getUTCMonth() + 1;
  const currentDay = jstNowDate.getUTCDate();

  let month: number | null = null;
  let day: number | null = null;
  let hour: number | null = null;
  let minute = 0;

  // パターン1: 「4月1日 18時」「4月1日の18時30分」
  const fullDateMatch = text.match(/(\d{1,2})月(\d{1,2})日\s*[のに]?\s*(\d{1,2})時(?:\s*(\d{1,2})分)?/);
  if (fullDateMatch) {
    month = parseInt(fullDateMatch[1], 10);
    day = parseInt(fullDateMatch[2], 10);
    hour = parseInt(fullDateMatch[3], 10);
    if (fullDateMatch[4]) minute = parseInt(fullDateMatch[4], 10);
  }

  // パターン2: 「4/1 18:00」「4/1の18時」
  if (!month) {
    const slashDateMatch = text.match(/(\d{1,2})\/(\d{1,2})\s*[のに]?\s*(\d{1,2})[:時](\d{0,2})/);
    if (slashDateMatch) {
      month = parseInt(slashDateMatch[1], 10);
      day = parseInt(slashDateMatch[2], 10);
      hour = parseInt(slashDateMatch[3], 10);
      if (slashDateMatch[4]) minute = parseInt(slashDateMatch[4], 10);
    }
  }

  // パターン3: 「明日の14時」「明日14時」
  if (!month) {
    const tomorrowMatch = text.match(/明日\s*[のに]?\s*(\d{1,2})時(?:\s*(\d{1,2})分)?/);
    if (tomorrowMatch) {
      const tomorrow = new Date(jstNowDate);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      month = tomorrow.getUTCMonth() + 1;
      day = tomorrow.getUTCDate();
      hour = parseInt(tomorrowMatch[1], 10);
      if (tomorrowMatch[2]) minute = parseInt(tomorrowMatch[2], 10);
    }
  }

  // パターン4: 「明後日15時」
  if (!month) {
    const dayAfterMatch = text.match(/明後日\s*[のに]?\s*(\d{1,2})時(?:\s*(\d{1,2})分)?/);
    if (dayAfterMatch) {
      const dayAfter = new Date(jstNowDate);
      dayAfter.setUTCDate(dayAfter.getUTCDate() + 2);
      month = dayAfter.getUTCMonth() + 1;
      day = dayAfter.getUTCDate();
      hour = parseInt(dayAfterMatch[1], 10);
      if (dayAfterMatch[2]) minute = parseInt(dayAfterMatch[2], 10);
    }
  }

  // パターン5: 「1日の18時」（月なし → 当月 or 翌月）
  if (!month) {
    const dayOnlyMatch = text.match(/(\d{1,2})日\s*[のに]?\s*(\d{1,2})時(?:\s*(\d{1,2})分)?/);
    if (dayOnlyMatch) {
      day = parseInt(dayOnlyMatch[1], 10);
      hour = parseInt(dayOnlyMatch[2], 10);
      if (dayOnlyMatch[3]) minute = parseInt(dayOnlyMatch[3], 10);
      // 当月か翌月かを判定（過去日なら翌月）
      if (day < currentDay) {
        month = currentMonth === 12 ? 1 : currentMonth + 1;
      } else {
        month = currentMonth;
      }
    }
  }

  if (month === null || day === null || hour === null) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // 年の判定（過去の月なら翌年）
  let year = currentYear;
  if (month < currentMonth || (month === currentMonth && day < currentDay)) {
    year += 1;
  }

  return { year, month, day, hour, minute };
}

/**
 * ExtractedDateTime → ISO文字列（JST）
 */
export function toJstIsoString(dt: ExtractedDateTime): string {
  const m = String(dt.month).padStart(2, '0');
  const d = String(dt.day).padStart(2, '0');
  const h = String(dt.hour).padStart(2, '0');
  const min = String(dt.minute).padStart(2, '0');
  return `${dt.year}-${m}-${d}T${h}:${min}:00+09:00`;
}

/**
 * 面談日時を検出し、メタデータ保存 + リマインダ登録を行う
 */
export async function processInterviewDateDetection(
  db: D1Database,
  friendId: string,
  lineAccountId: string | null,
  messageText: string,
  lineClient: LineClient,
  replyToken: string,
): Promise<boolean> {
  // 面談予約済タグを持っているか確認
  const tags = await getFriendTags(db, friendId);
  const hasBookedTag = tags.some(t => t.name === INTERVIEW_BOOKED_TAG);
  if (!hasBookedTag) return false;

  // 日時抽出
  const extracted = extractDateTime(messageText, new Date());
  if (!extracted) return false;

  const interviewDatetime = toJstIsoString(extracted);

  // メタデータに保存
  const existing = await db
    .prepare('SELECT metadata FROM friends WHERE id = ?')
    .bind(friendId)
    .first<{ metadata: string | null }>();
  const meta = JSON.parse(existing?.metadata || '{}');
  meta.interview_datetime = interviewDatetime;
  meta.interview_detected_at = jstNow();
  await db
    .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(meta), jstNow(), friendId)
    .run();

  // リマインダに登録（「面談フォロー」リマインダを検索）
  const reminder = await db
    .prepare(`SELECT id FROM reminders WHERE name = '面談フォロー' AND is_active = 1${lineAccountId ? ` AND line_account_id = '${lineAccountId}'` : ''} LIMIT 1`)
    .first<{ id: string }>();

  if (reminder) {
    // target_date = 面談当日12:00 JST（リマインドはoffset=0で当日昼に届く）
    const reminderTargetDate = `${extracted.year}-${String(extracted.month).padStart(2, '0')}-${String(extracted.day).padStart(2, '0')}T12:00:00+09:00`;
    await enrollFriendInReminder(db, {
      friendId,
      reminderId: reminder.id,
      targetDate: reminderTargetDate,
    });
  }

  // 面談日まで3日以上あるか判定
  const interviewTime = new Date(interviewDatetime).getTime();
  const nowTime = Date.now();
  const daysUntilInterview = (interviewTime - nowTime) / (1000 * 60 * 60 * 24);

  if (daysUntilInterview >= 3) {
    // 流入経路タグに基づいた興味ベースのフォロー1通を送信
    await sendPreInterviewFollowUp(db, friendId, tags, lineClient);
  }

  // 確認の返信（replyToken使用=無料）
  try {
    const displayMonth = extracted.month;
    const displayDay = extracted.day;
    const displayHour = extracted.hour;
    const displayMinute = extracted.minute > 0 ? `${extracted.minute}分` : '';
    await lineClient.replyMessage(replyToken, [
      buildMessage('text', `${displayMonth}月${displayDay}日 ${displayHour}時${displayMinute}のご予約ですね！\n当日にリマインドをお送りしますね`),
    ]);
  } catch (err) {
    console.error('Failed to reply interview confirmation:', err);
  }

  console.log(`Interview detected: friend=${friendId} datetime=${interviewDatetime}`);
  return true;
}

/**
 * 面談前フォロー（3日以上先の場合のみ）
 * 流入経路タグに応じて内容を変える
 */
async function sendPreInterviewFollowUp(
  db: D1Database,
  friendId: string,
  tags: Array<{ name: string }>,
  lineClient: LineClient,
): Promise<void> {
  const tagNames = tags.map(t => t.name);

  let message: string;

  if (tagNames.includes('広告_高収入') || tagNames.includes('広告_稼げる')) {
    // 収入に興味がある → 稼いでいる事例
    message = [
      'ヒナタマからのお知らせです',
      '',
      '実はヒナタマでは5名中3名が',
      '1時間5,150円以上を達成しています',
      '',
      '例えば18時〜23時の5時間勤務で',
      '日払い33,000円というケースも',
      '',
      '未経験スタートの方がほとんどです',
      'スタッフが丁寧にサポートしますので',
      '安心してくださいね',
      '',
      '面談でもっと詳しくお話ししますね！',
    ].join('\n');
  } else if (tagNames.includes('広告_チャットレディ')) {
    // チャットレディKWで流入 → お仕事の雰囲気
    message = [
      'ヒナタマからのお知らせです',
      '',
      'お仕事のイメージは',
      'インスタライブやYouTubeライブと',
      'ほぼ同じです',
      '',
      '完全個室・顔出しなし・シフト自由',
      '直接会うことは一切ありません',
      '',
      '応募される方の95%が未経験者さまです',
      'PC操作もスタッフがお教えします',
      '',
      '面談でもっと詳しくお話ししますね！',
    ].join('\n');
  } else if (tagNames.includes('広告_地名')) {
    // 地名KWで流入 → 立地とアクセス
    message = [
      'ヒナタマからのお知らせです',
      '',
      'ヒナタマは熊本市中央区にある',
      '未経験者さま専門のお店です',
      '',
      'サクラマチから徒歩3分の好立地',
      '完全個室・シフト完全自由',
      '短時間の勤務も大歓迎です',
      '',
      '宿泊もできるので',
      '遠方からの方も安心ですよ',
      '',
      '面談でもっと詳しくお話ししますね！',
    ].join('\n');
  } else {
    // デフォルト → 安心感
    message = [
      'ヒナタマからのお知らせです',
      '',
      'ヒナタマは未経験者さま専門店として',
      '一人ひとり丁寧にサポートしています',
      '',
      '完全個室・顔出しなし・日払い',
      'シフトは完全自由で',
      '週1日・短時間からOKです',
      '',
      '気になることがあれば',
      '何でもLINEで聞いてくださいね',
      '',
      '面談でお会いできるのを',
      '楽しみにしています！',
    ].join('\n');
  }

  try {
    const friend = await db
      .prepare('SELECT line_user_id FROM friends WHERE id = ?')
      .bind(friendId)
      .first<{ line_user_id: string }>();
    if (friend) {
      await lineClient.pushMessage(friend.line_user_id, [
        buildMessage('text', message),
      ]);

      // ログ記録
      const logId = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, delivery_type, created_at)
           VALUES (?, ?, 'outgoing', 'text', ?, 'push', ?)`,
        )
        .bind(logId, friendId, message, jstNow())
        .run();
    }
  } catch (err) {
    console.error('Failed to send pre-interview follow-up:', err);
  }
}
