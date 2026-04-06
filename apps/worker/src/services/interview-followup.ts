/**
 * 面談ブッチ検知 — cronトリガーで定期実行
 *
 * 翌日フォロー送信後48h経過しても返信がない友だちに
 * 面談ブッチタグを付与し、フォローシナリオを起動する。
 */

import {
  getFriendTags,
  addTagToFriend,
  getScenarios,
  enrollFriendInScenario,
  jstNow,
} from '@line-crm/db';
import { fireEvent } from './event-bus.js';

const INTERVIEW_BOOKED_TAG = '面談予約済';
const INTERVIEW_DONE_TAG = '面談完了';
const INTERVIEW_BUTCH_TAG = '面談ブッチ';

/** ブッチ判定: 面談日の翌日にチェック */
const BUTCH_THRESHOLD_HOURS = 24; // 面談日時から24h後にブッチ判定

export async function processInterviewButchDetection(
  db: D1Database,
  lineAccessToken: string,
): Promise<void> {
  // 3時間毎に実行（cron自体は5分毎だが、ブッチ判定はアバウトでいい）
  const jstHour = new Date(Date.now() + 9 * 60 * 60_000).getUTCHours();
  const jstMinute = new Date(Date.now() + 9 * 60 * 60_000).getUTCMinutes();
  if (jstHour % 3 !== 0 || jstMinute >= 5) return;

  const now = new Date();
  const nowMs = now.getTime();

  // 面談予約済タグを持つ全友だちを取得
  const bookedTag = await db
    .prepare(`SELECT id FROM tags WHERE name = ?`)
    .bind(INTERVIEW_BOOKED_TAG)
    .first<{ id: string }>();
  if (!bookedTag) return;

  const butchTag = await db
    .prepare(`SELECT id FROM tags WHERE name = ?`)
    .bind(INTERVIEW_BUTCH_TAG)
    .first<{ id: string }>();
  if (!butchTag) return;

  const doneTag = await db
    .prepare(`SELECT id FROM tags WHERE name = ?`)
    .bind(INTERVIEW_DONE_TAG)
    .first<{ id: string }>();

  // 面談予約済タグを持ち、interview_datetimeがメタデータにある友だちを検索
  const friends = await db
    .prepare(`
      SELECT f.id, f.metadata, f.line_account_id
      FROM friends f
      INNER JOIN friend_tags ft ON ft.friend_id = f.id
      WHERE ft.tag_id = ? AND f.is_following = 1
    `)
    .bind(bookedTag.id)
    .all<{ id: string; metadata: string | null; line_account_id: string | null }>();

  for (const friend of friends.results) {
    try {
      const meta = JSON.parse(friend.metadata || '{}');
      if (!meta.interview_datetime) continue;

      const interviewTime = new Date(meta.interview_datetime).getTime();
      const hoursSinceInterview = (nowMs - interviewTime) / (1000 * 60 * 60);

      // まだブッチ判定時間に達していない
      if (hoursSinceInterview < BUTCH_THRESHOLD_HOURS) continue;

      // 既にブッチタグ or 面談完了タグがあればスキップ
      const friendTags = await getFriendTags(db, friend.id);
      const tagNames = friendTags.map(t => t.name);
      if (tagNames.includes(INTERVIEW_BUTCH_TAG)) continue;
      if (tagNames.includes(INTERVIEW_DONE_TAG)) continue;

      // 面談日時以降にユーザーからの受信メッセージがあるかチェック
      const recentMessage = await db
        .prepare(`
          SELECT id FROM messages_log
          WHERE friend_id = ? AND direction = 'incoming'
          AND created_at > ?
          LIMIT 1
        `)
        .bind(friend.id, meta.interview_datetime)
        .first<{ id: string }>();

      // 返信があった場合はブッチではない（店長が対応中）
      if (recentMessage) continue;

      // ブッチ確定 → タグ付与
      await addTagToFriend(db, friend.id, butchTag.id);

      // tag_added シナリオを自動起動
      const scenarios = await getScenarios(db);
      for (const scenario of scenarios) {
        const accountMatch = !scenario.line_account_id || !friend.line_account_id || scenario.line_account_id === friend.line_account_id;
        if (
          scenario.trigger_type === 'tag_added' &&
          scenario.is_active &&
          scenario.trigger_tag_id === butchTag.id &&
          accountMatch
        ) {
          const existing = await db
            .prepare(`SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`)
            .bind(friend.id, scenario.id)
            .first<{ id: string }>();
          if (!existing) {
            await enrollFriendInScenario(db, friend.id, scenario.id);
          }
        }
      }

      // イベント発火
      await fireEvent(db, 'tag_change', {
        friendId: friend.id,
        eventData: { tagId: butchTag.id, action: 'add', source: 'interview_butch_detection' },
      }, lineAccessToken, friend.line_account_id);

      console.log(`Interview butch detected: friend=${friend.id} interview=${meta.interview_datetime}`);
    } catch (err) {
      console.error(`Butch detection error for friend ${friend.id}:`, err);
    }
  }
}
