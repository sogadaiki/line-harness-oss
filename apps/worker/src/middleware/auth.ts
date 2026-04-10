import type { Context, Next } from 'hono';
import { getStaffByApiKey, getStaffById } from '@line-crm/db';
import { verifyJwt } from '../utils/jwt.js';
import type { Env } from '../index.js';

interface JwtPayload {
  staffId: string;
}

function parseCookie(header: string, name: string): string | null {
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

export async function authMiddleware(c: Context<Env>, next: Next): Promise<Response | void> {
  // Skip auth for the LINE webhook endpoint — it uses signature verification instead
  // Skip auth for OpenAPI docs — public documentation
  const path = new URL(c.req.url).pathname;
  if (
    path === '/webhook' ||
    path === '/docs' ||
    path === '/openapi.json' ||
    path === '/api/affiliates/click' ||
    path.startsWith('/t/') ||
    path.startsWith('/r/') ||
    path.startsWith('/pool/') ||
    path.startsWith('/images/') ||
    path.startsWith('/api/liff/') ||
    path.startsWith('/auth/') ||
    path === '/setup' ||
    path === '/api/integrations/stripe/webhook' ||
    path.match(/^\/api\/webhooks\/incoming\/[^/]+\/receive$/) ||
    path.match(/^\/api\/forms\/[^/]+\/submit$/) ||
    path.match(/^\/api\/forms\/[^/]+$/) || // GET form definition (public for LIFF)
    path === '/api/meet-callback' || // Meet Harness completion callback
    path === '/api/qr' || // Public QR proxy — used by desktop landing pages
    path === '/api/auth/logout' // Logout clears cookie, no auth needed
  ) {
    return next();
  }

  // Set account scope for all auth paths (tenant-isolated Workers like hinatama)
  const applyScope = () => {
    if (c.env.SCOPED_LINE_ACCOUNT_ID) {
      c.set('scopedAccountId', c.env.SCOPED_LINE_ACCOUNT_ID);
    }
  };

  // Strategy 1: Bearer token
  const authHeader = c.req.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length);

    // 1a: Try as staff API key
    const staff = await getStaffByApiKey(c.env.DB, token);
    if (staff) {
      c.set('staff', { id: staff.id, name: staff.name, role: staff.role });
      applyScope();
      return next();
    }

    // 1b: Try as JWT session token (iOS Safari fallback for cross-origin
    //     where third-party cookies are blocked. The admin UI stores the JWT
    //     in localStorage and sends it as Bearer instead of relying on cookie.)
    const secret = c.env.SESSION_SECRET || c.env.API_KEY;
    const jwtPayload = await verifyJwt(token, secret) as JwtPayload | null;
    if (jwtPayload && jwtPayload.staffId) {
      const jwtStaff = await getStaffById(c.env.DB, jwtPayload.staffId);
      if (jwtStaff && jwtStaff.is_active) {
        c.set('staff', { id: jwtStaff.id, name: jwtStaff.name, role: jwtStaff.role });
        applyScope();
        return next();
      }
    }

    // 1c: Fallback — env API_KEY acts as owner
    if (token === c.env.API_KEY) {
      c.set('staff', { id: 'env-owner', name: 'Owner', role: 'owner' as const });
      applyScope();
      return next();
    }
  }

  // Strategy 2: Cookie JWT session (works on PC, blocked by iOS Safari ITP for cross-origin)
  const cookieHeader = c.req.header('Cookie') || '';
  const sessionToken = parseCookie(cookieHeader, 'lh_session');
  if (sessionToken) {
    const secret = c.env.SESSION_SECRET || c.env.API_KEY;
    const payload = await verifyJwt(sessionToken, secret) as JwtPayload | null;
    if (payload && payload.staffId) {
      // Verify staff still exists and is active
      const staff = await getStaffById(c.env.DB, payload.staffId);
      if (staff && staff.is_active) {
        c.set('staff', { id: staff.id, name: staff.name, role: staff.role });
        applyScope();
        return next();
      }
    }
  }

  return c.json({ success: false, error: 'Unauthorized' }, 401);
}
