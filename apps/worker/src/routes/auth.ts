import { Hono } from 'hono';
import {
  getStaffByLineUserId,
  setStaffLineUserId,
  getStaffByInviteToken,
  createInviteToken,
  getStaffById,
  clearInviteToken,
  getStaffPermissions,
} from '@line-crm/db';
import { requireRole } from '../middleware/role-guard.js';
import { signJwt } from '../utils/jwt.js';
import type { Env } from '../index.js';

const auth = new Hono<Env>();

function getSessionSecret(env: Env['Bindings']): string {
  return env.SESSION_SECRET || env.API_KEY;
}

// ── LINE Login flow ─────────────────────────────────────────────────────

/**
 * GET /auth/staff/line — Redirect to LINE Login authorization screen
 */
auth.get('/auth/staff/line', (c) => {
  const inviteToken = c.req.query('invite') || '';

  // CSRF state: random + optional invite token
  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(stateBytes);
  const stateRandom = Array.from(stateBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const state = inviteToken ? `${stateRandom}:${inviteToken}` : stateRandom;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: c.env.LINE_LOGIN_CHANNEL_ID,
    redirect_uri: `${c.env.WORKER_URL}/auth/staff/line/callback`,
    state,
    scope: 'profile openid',
  });

  return c.redirect(`https://access.line.me/oauth2/v2.1/authorize?${params.toString()}`);
});

/**
 * GET /auth/staff/line/callback — LINE Login callback
 */
auth.get('/auth/staff/line/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state') || '';
  const error = c.req.query('error');

  if (error) {
    return c.html(errorPage('LINEログインがキャンセルされました'), 400);
  }

  if (!code) {
    return c.html(errorPage('認証コードがありません'), 400);
  }

  // Extract invite token from state if present
  const stateParts = state.split(':');
  const inviteToken = stateParts.length > 1 ? stateParts.slice(1).join(':') : null;

  // Exchange code for access token
  const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${c.env.WORKER_URL}/auth/staff/line/callback`,
      client_id: c.env.LINE_LOGIN_CHANNEL_ID,
      client_secret: c.env.LINE_LOGIN_CHANNEL_SECRET,
    }),
  });

  if (!tokenRes.ok) {
    return c.html(errorPage('LINEアクセストークンの取得に失敗しました'), 500);
  }

  const tokenData = await tokenRes.json() as { access_token: string };

  // Get LINE profile
  const profileRes = await fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!profileRes.ok) {
    return c.html(errorPage('LINEプロフィールの取得に失敗しました'), 500);
  }

  const profile = await profileRes.json() as { userId: string; displayName: string };
  const lineUserId = profile.userId;

  const secret = getSessionSecret(c.env);
  const scopedAccountId = c.env.SCOPED_LINE_ACCOUNT_ID;

  // Case 1: Invite token present — link LINE account to existing staff
  if (inviteToken) {
    const staffByInvite = await getStaffByInviteToken(c.env.DB, inviteToken);
    if (!staffByInvite) {
      return c.html(errorPage('招待リンクが無効か期限切れです'), 400);
    }

    // Check if this LINE user is already linked to another staff
    const existingStaff = await getStaffByLineUserId(c.env.DB, lineUserId);
    if (existingStaff && existingStaff.id !== staffByInvite.id) {
      return c.html(errorPage('このLINEアカウントは既に別のスタッフに紐づけられています'), 400);
    }

    await setStaffLineUserId(c.env.DB, staffByInvite.id, lineUserId);
    await clearInviteToken(c.env.DB, staffByInvite.id);

    const jwt = await signJwt({
      staffId: staffByInvite.id,
      role: staffByInvite.role,
      lineAccountId: scopedAccountId,
    }, secret);

    const adminUrl = c.env.ADMIN_URL || c.env.WORKER_URL;
    return buildSessionRedirect(c.env.WORKER_URL, adminUrl, jwt, staffByInvite.name, staffByInvite.role, getStaffPermissions(staffByInvite));
  }

  // Case 2: Existing staff with this LINE user ID
  const staffByLine = await getStaffByLineUserId(c.env.DB, lineUserId);
  if (staffByLine) {
    const jwt = await signJwt({
      staffId: staffByLine.id,
      role: staffByLine.role,
      lineAccountId: scopedAccountId,
    }, secret);

    const adminUrl = c.env.ADMIN_URL || c.env.WORKER_URL;
    return buildSessionRedirect(c.env.WORKER_URL, adminUrl, jwt, staffByLine.name, staffByLine.role, getStaffPermissions(staffByLine));
  }

  // Case 3: No matching staff — unauthorized
  return c.html(errorPage('このLINEアカウントにはアクセス権がありません。オーナーから招待リンクを受け取ってください。'), 403);
});

/**
 * POST /api/staff/:id/invite — Generate invite URL (owner only)
 */
auth.post('/api/staff/:id/invite', requireRole('owner'), async (c) => {
  const staffId = c.req.param('id')!;
  const staff = await getStaffById(c.env.DB, staffId);
  if (!staff) {
    return c.json({ success: false, error: 'Staff member not found' }, 404);
  }

  const token = await createInviteToken(c.env.DB, staffId);
  const inviteUrl = `${c.env.WORKER_URL}/auth/staff/line?invite=${token}`;

  return c.json({
    success: true,
    data: {
      inviteUrl,
      expiresIn: '24h',
    },
  });
});

/**
 * POST /api/auth/logout — Clear session cookie
 */
auth.post('/api/auth/logout', (c) => {
  const workerUrl = new URL(c.env.WORKER_URL);
  return c.json({ success: true }, 200, {
    'Set-Cookie': `lh_session=; Path=/; Domain=${workerUrl.hostname}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  });
});

/**
 * GET /api/staff/me/permissions — Return current staff permissions
 */
auth.get('/api/staff/me/permissions', async (c) => {
  const currentStaff = c.get('staff');
  if (currentStaff.id === 'env-owner') {
    return c.json({ success: true, data: { permissions: ['*'] } });
  }

  const member = await getStaffById(c.env.DB, currentStaff.id);
  if (!member) {
    return c.json({ success: false, error: 'Staff member not found' }, 404);
  }

  return c.json({
    success: true,
    data: { permissions: getStaffPermissions(member) },
  });
});

// ── Helper functions ────────────────────────────────────────────────────

function buildSessionRedirect(
  workerUrl: string,
  adminUrl: string,
  jwt: string,
  staffName: string,
  staffRole: string,
  permissions: string[],
): Response {
  const url = new URL(workerUrl);
  const maxAge = 30 * 24 * 60 * 60; // 30 days (match JWT_EXPIRY_SECONDS in utils/jwt.ts)
  // SameSite=None required so the cookie is sent on cross-origin fetch
  // from the admin Pages app (different hostname) to this worker.
  // Note: iOS Safari ITP blocks even SameSite=None cookies in cross-origin
  // fetch contexts. We additionally pass the JWT in a URL hash fragment so
  // the admin UI can store it in localStorage and send it as a Bearer token.
  const cookieStr = `lh_session=${jwt}; Path=/; Domain=${url.hostname}; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}`;

  const params = new URLSearchParams({
    auth: 'success',
    name: staffName,
    role: staffRole,
    permissions: JSON.stringify(permissions),
  });

  // Land on the admin /login page so its useEffect picks up the params,
  // writes them to localStorage, and forwards to '/'. Worker root serves
  // the customer-facing LIFF page, not the admin dashboard.
  //
  // The JWT is appended as a URL hash fragment (#token=...) instead of a
  // query parameter so it is NEVER sent to any server (HTTP spec: fragments
  // are client-side only). The admin login page reads window.location.hash,
  // saves the token to localStorage, then strips it via history.replaceState.
  // This is the iOS Safari fallback path when cross-origin cookies are blocked.
  const target = `${adminUrl}/login?${params.toString()}#token=${encodeURIComponent(jwt)}`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: target,
      'Set-Cookie': cookieStr,
    },
  });
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LINE Harness - エラー</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans',system-ui,sans-serif;background:#f5f5f5;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#fff;border-radius:16px;padding:40px;text-align:center;max-width:400px;width:90%;box-shadow:0 2px 12px rgba(0,0,0,0.08)}
.icon{width:48px;height:48px;margin:0 auto 16px;background:#FEE2E2;border-radius:50%;display:flex;align-items:center;justify-content:center}
.icon svg{width:24px;height:24px;color:#EF4444}
h1{font-size:18px;font-weight:700;margin-bottom:8px;color:#111}
p{font-size:14px;color:#666;line-height:1.6;margin-bottom:24px}
a{display:inline-block;padding:12px 32px;background:#06C755;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px}
a:hover{opacity:0.9}
</style>
</head>
<body>
<div class="card">
<div class="icon"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z"/></svg></div>
<h1>ログインエラー</h1>
<p>${message}</p>
<a href="/login">ログインに戻る</a>
</div>
</body>
</html>`;
}

export { auth };
