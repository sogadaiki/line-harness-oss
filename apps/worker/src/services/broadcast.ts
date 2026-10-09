import { extractFlexAltText } from '../utils/flex-alt-text.js';
import {
  getBroadcastById,
  getBroadcasts,
  updateBroadcastStatus,
  getFriendsByTag,
  jstNow,
  updateBroadcastLineRequestId,
  createBroadcastInsight,
} from '@line-crm/db';
import type { Broadcast, Friend } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import type { Message } from '@line-crm/line-sdk';
import { calculateStaggerDelay, sleep, addMessageVariation } from './stealth.js';
import { resolveDeliveryClient } from './line-client-resolver.js';
import { claimBroadcast, assertBroadcastSending, finishBroadcast, failBroadcast } from './broadcast-state.js';

const MULTICAST_BATCH_SIZE = 500;

export async function processBroadcastSend(
  db: D1Database,
  lineClient: LineClient,
  broadcastId: string,
  workerUrl?: string,
): Promise<Broadcast> {
  const broadcast = await getBroadcastById(db, broadcastId);
  if (!broadcast) {
    throw new Error(`Broadcast ${broadcastId} not found`);
  }
  const accountId = broadcast.line_account_id;
  if (!accountId) throw new Error('Broadcast account is required');
  lineClient = await resolveDeliveryClient(db,accountId);
  if (!['all','tag'].includes(broadcast.target_type)) throw new Error('Unknown broadcast target');

  // Auto-wrap URLs with tracking links (text with URLs → Flex with button)
  let finalType: string = broadcast.message_type;
  let finalContent = broadcast.message_content;
  if (workerUrl) {
    const { autoTrackContent } = await import('./auto-track.js');
    const tracked = await autoTrackContent(db, broadcast.message_type, broadcast.message_content, workerUrl, accountId);
    finalType = tracked.messageType;
    finalContent = tracked.content;
  }
  const altText = (broadcast as unknown as Record<string, unknown>).alt_text as string | undefined;
  const message = buildMessage(finalType, finalContent, altText || undefined);
  let totalCount = 0;
  let successCount = 0;
  await claimBroadcast(db,broadcastId);

  try {
    if (broadcast.target_type === 'all') {
      await assertBroadcastSending(db,broadcastId);
      // Record an attempt before the network call; ambiguous failures must not be blindly resent.
      await updateBroadcastLineRequestId(db,broadcast.id,null,`bcast_${broadcast.id.slice(0,8)}`);
      // Use LINE broadcast API (sends to all followers)
      const { requestId } = await lineClient.broadcast([message]);
      await updateBroadcastLineRequestId(db, broadcast.id, requestId, null);
      // We don't have exact count for broadcast API, set as 0 (unknown)
      totalCount = 0;
      successCount = 0;
    } else if (broadcast.target_type === 'tag') {
      if (!broadcast.target_tag_id) {
        throw new Error('target_tag_id is required for tag-targeted broadcasts');
      }

      const friends = await getFriendsByTag(db, broadcast.target_tag_id);
      const tag = await db.prepare('SELECT line_account_id FROM tags WHERE id=?').bind(broadcast.target_tag_id).first<{line_account_id:string|null}>();
      if (tag?.line_account_id !== accountId) throw new Error('Broadcast tag belongs to another account');
      const followingFriends = friends.filter((f) => f.is_following && f.line_account_id===accountId);
      if (!followingFriends.length) throw new Error('No recipients in selected account');
      totalCount = followingFriends.length;

      // Group friends by line_account_id so each group uses the correct LineClient.
      // account_id → LineClient キャッシュで DB 呼び出しを最小化する
      const clientCache = new Map<string, LineClient>();
      const grouped = new Map<string | null, Friend[]>();
      for (const f of followingFriends) {
        const key = f.line_account_id;
        const existing = grouped.get(key) ?? [];
        existing.push(f);
        grouped.set(key, existing);
      }

      const now = jstNow();
      const unit = `bcast_${broadcast.id.slice(0, 8)}`;
      await updateBroadcastLineRequestId(db,broadcast.id,null,unit);
      let globalBatchIndex = 0;
      const totalBatches = Math.ceil(followingFriends.length / MULTICAST_BATCH_SIZE);

      for (const [accountId, groupFriends] of grouped) {
        // Resolve client for this account group (with cache)
        let groupClient: LineClient;
        if (accountId) {
          if (clientCache.has(accountId)) {
            groupClient = clientCache.get(accountId)!;
          } else {
            groupClient = await resolveDeliveryClient(db, accountId, lineClient);
            clientCache.set(accountId, groupClient);
          }
        } else {
          groupClient = lineClient;
        }

        for (let i = 0; i < groupFriends.length; i += MULTICAST_BATCH_SIZE) {
          const batchIndex = globalBatchIndex;
          globalBatchIndex++;
          const batch = groupFriends.slice(i, i + MULTICAST_BATCH_SIZE);
          const lineUserIds = batch.map((f) => f.line_user_id);

          // Stealth: add staggered delay between batches
          if (batchIndex > 0) {
            const delay = calculateStaggerDelay(followingFriends.length, batchIndex);
            await sleep(delay);
          }

          // Stealth: add slight variation to text messages
          let batchMessage = message;
          if (message.type === 'text' && totalBatches > 1) {
            batchMessage = { ...message, text: addMessageVariation(message.text, batchIndex) };
          }

          try {
            await assertBroadcastSending(db,broadcastId);
            await groupClient.multicast(lineUserIds, [batchMessage], [unit]);
            successCount += batch.length;

            // Log only successfully sent messages
            for (const friend of batch) {
              const logId = crypto.randomUUID();
              await db
                .prepare(
                  `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
                   VALUES (?, ?, 'outgoing', ?, ?, ?, NULL, ?)`,
                )
                .bind(logId, friend.id, broadcast.message_type, broadcast.message_content, broadcastId, now)
                .run();
            }
          } catch (err) {
            console.error(`Multicast batch ${batchIndex} failed:`, err);
            throw err;
          }
        }
      }
      await updateBroadcastLineRequestId(db, broadcast.id, null, unit);
    }

    await createBroadcastInsight(db, broadcast.id);
    await finishBroadcast(db, broadcastId, totalCount, successCount);
  } catch (err) {
    await failBroadcast(db, broadcastId, totalCount, successCount);
    throw err;
  }

  return (await getBroadcastById(db, broadcastId))!;
}

export async function processScheduledBroadcasts(
  db: D1Database,
  lineClient: LineClient,
  workerUrl?: string,
  accountScope?: string,
): Promise<void> {
  const now = jstNow();
  const allBroadcasts = await getBroadcasts(db,accountScope);

  const nowMs = Date.now();
  const scheduled = allBroadcasts.filter(
    (b) =>
      b.status === 'scheduled' &&
      b.scheduled_at !== null &&
      new Date(b.scheduled_at).getTime() <= nowMs,
  );

  // account_id → LineClient キャッシュで DB 呼び出しを最小化する
  const clientCache = new Map<string, LineClient>();

  for (const broadcast of scheduled) {
    try {
      // broadcast.line_account_id でアカウント固有 client を解決
      const broadcastAccountId = broadcast.line_account_id;
      if (!broadcastAccountId) continue;
      let broadcastClient: LineClient;
      if (broadcastAccountId) {
        if (clientCache.has(broadcastAccountId)) {
          broadcastClient = clientCache.get(broadcastAccountId)!;
        } else {
          broadcastClient = await resolveDeliveryClient(db, broadcastAccountId, lineClient);
          clientCache.set(broadcastAccountId, broadcastClient);
        }
      } else {
        broadcastClient = lineClient;
      }
      await processBroadcastSend(db, broadcastClient, broadcast.id, workerUrl);
    } catch (err) {
      console.error(`Failed to send scheduled broadcast ${broadcast.id}:`, err);
      // Continue with next broadcast
    }
  }
}

function buildMessage(messageType: string, messageContent: string, altText?: string): Message {
  if (messageType === 'text') {
    return { type: 'text', text: messageContent };
  }

  if (messageType === 'image') {
    try {
      const parsed = JSON.parse(messageContent) as {
        originalContentUrl: string;
        previewImageUrl: string;
      };
      return {
        type: 'image',
        originalContentUrl: parsed.originalContentUrl,
        previewImageUrl: parsed.previewImageUrl,
      };
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
