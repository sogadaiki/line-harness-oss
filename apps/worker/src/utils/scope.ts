import type { Context } from 'hono';
import type { Env } from '../index.js';

/** Scope is authorized by accountScopeMiddleware; this helper is not authorization. */
export function getScope(c: Context<Env>): string | undefined {
  // Scoped binding always wins. Never let a client query override tenant scope.
  const scoped = c.env.SCOPED_LINE_ACCOUNT_ID || c.get('scopedAccountId');
  if (scoped) return scoped;
  // Fallback only when no scope is bound (multi-tenant mode like line-crm-worker)
  return c.req.query('lineAccountId') || undefined;
}
