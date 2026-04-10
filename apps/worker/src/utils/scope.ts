import type { Context } from 'hono';
import type { Env } from '../index.js';

/**
 * Resolve the current LINE account scope.
 *
 * Priority (HARDLOCK):
 *   1. `scopedAccountId` from env binding (set by middleware when SCOPED_LINE_ACCOUNT_ID is configured)
 *   2. `lineAccountId` query parameter (multi-tenant fallback for line-crm-worker)
 *
 * SECURITY: When the worker is bound to a single LINE account
 * (`SCOPED_LINE_ACCOUNT_ID` env var), the scoped value is ALWAYS authoritative
 * and the client-supplied query parameter is COMPLETELY IGNORED. This guarantees
 * cross-account isolation: a tenant-scoped worker (e.g. hinatama-line-worker)
 * cannot serve, modify, or leak data from any other LINE account, regardless of
 * what the client sends.
 *
 * Do NOT change this priority without understanding the cross-tenant data leak
 * incident from 2026-04-10. See memory: feedback_account_isolation_hardlock.md
 */
export function getScope(c: Context<Env>): string | undefined {
  // Scoped binding always wins. Never let a client query override tenant scope.
  const scoped = c.get('scopedAccountId') as string | undefined;
  if (scoped) return scoped;
  // Fallback only when no scope is bound (multi-tenant mode like line-crm-worker)
  return c.req.query('lineAccountId') || undefined;
}
