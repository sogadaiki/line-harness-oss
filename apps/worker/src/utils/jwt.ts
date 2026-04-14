/**
 * JWT utility using Web Crypto API (HS256).
 * No external dependencies — works in Cloudflare Workers.
 */

export interface JwtPayload {
  staffId: string;
  role: 'owner' | 'admin' | 'staff';
  lineAccountId: string | undefined;
  iat: number;
  exp: number;
}

const ALGORITHM = { name: 'HMAC', hash: 'SHA-256' } as const;
const JWT_EXPIRY_SECONDS = 30 * 24 * 60 * 60; // 30 days

function base64UrlEncode(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function getSigningKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    ALGORITHM,
    false,
    ['sign', 'verify'],
  );
}

export async function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    ...payload,
    iat: now,
    exp: now + JWT_EXPIRY_SECONDS,
  };

  const encoder = new TextEncoder();
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64UrlEncode(encoder.encode(JSON.stringify(fullPayload)));
  const signingInput = `${header}.${body}`;

  const key = await getSigningKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
  const sig = base64UrlEncode(new Uint8Array(signature));

  return `${signingInput}.${sig}`;
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, sig] = parts;
  const signingInput = `${header}.${body}`;

  const key = await getSigningKey(secret);
  const encoder = new TextEncoder();
  const signatureBytes = base64UrlDecode(sig);

  const valid = await crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(signingInput));
  if (!valid) return null;

  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as JwtPayload;

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) return null;

  return payload;
}
