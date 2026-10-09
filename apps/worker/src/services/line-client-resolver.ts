import { LineClient } from '@line-crm/line-sdk';
import { getLineAccountById } from '@line-crm/db';

/**
 * Resolve the correct LineClient for a given friend's line_account_id.
 *
 * Reject missing, deleted and inactive accounts. Never send through a default bot.
 */
export async function resolveDeliveryClient(
  db: D1Database,
  friendLineAccountId: string | null,
  _defaultClient?: LineClient,
): Promise<LineClient> {
  if (!friendLineAccountId) throw new Error('Delivery account is required');
  const account = await getLineAccountById(db, friendLineAccountId);
  if (!account || !account.is_active) throw new Error('Delivery account is missing or inactive');
  return new LineClient(account.channel_access_token);
}
