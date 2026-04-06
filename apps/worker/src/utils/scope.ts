import type { Context } from 'hono';
import type { Env } from '../index.js';

/**
 * Resolve the current LINE account scope from query parameter or environment binding.
 * Returns undefined when no scope is active (= show all accounts).
 */
export function getScope(c: Context<Env>): string | undefined {
  return c.req.query('lineAccountId') || c.get('scopedAccountId');
}
