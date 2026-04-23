import { LineClient } from '@line-crm/line-sdk';
import { getLineAccountById } from '@line-crm/db';

/**
 * Resolve the correct LineClient for a given friend's line_account_id.
 *
 * Returns the account-specific client when line_account_id is set and the
 * account record exists; otherwise falls back to the default client.
 *
 * NOTE: step-delivery.ts intentionally keeps its own inline resolution to
 * avoid regression risk (complex dedup flow). This utility is used by
 * reminder-delivery.ts and broadcast.ts only.
 */
export async function resolveDeliveryClient(
  db: D1Database,
  friendLineAccountId: string | null,
  defaultClient: LineClient,
): Promise<LineClient> {
  if (!friendLineAccountId) return defaultClient;
  const account = await getLineAccountById(db, friendLineAccountId);
  if (!account) return defaultClient;
  return new LineClient(account.channel_access_token);
}
