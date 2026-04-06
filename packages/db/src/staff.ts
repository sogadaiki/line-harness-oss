import { jstNow } from './utils.js';

export interface StaffMember {
  id: string;
  name: string;
  email: string | null;
  role: 'owner' | 'admin' | 'staff';
  api_key: string;
  is_active: number;
  line_user_id: string | null;
  permissions: string | null;
  invite_token: string | null;
  invite_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateStaffInput {
  name: string;
  email?: string | null;
  role: 'owner' | 'admin' | 'staff';
}

export interface UpdateStaffInput {
  name?: string;
  email?: string | null;
  role?: 'owner' | 'admin' | 'staff';
  is_active?: number;
}

function generateApiKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `lh_${hex}`;
}

export async function getStaffByApiKey(
  db: D1Database,
  apiKey: string,
): Promise<StaffMember | null> {
  return db
    .prepare('SELECT * FROM staff_members WHERE api_key = ? AND is_active = 1')
    .bind(apiKey)
    .first<StaffMember>();
}

export async function getStaffMembers(db: D1Database): Promise<StaffMember[]> {
  const result = await db
    .prepare('SELECT * FROM staff_members ORDER BY created_at ASC')
    .all<StaffMember>();
  return result.results;
}

export async function getStaffById(
  db: D1Database,
  id: string,
): Promise<StaffMember | null> {
  return db
    .prepare('SELECT * FROM staff_members WHERE id = ?')
    .bind(id)
    .first<StaffMember>();
}

export async function createStaffMember(
  db: D1Database,
  input: CreateStaffInput,
): Promise<StaffMember> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const apiKey = generateApiKey();

  await db
    .prepare(
      `INSERT INTO staff_members (id, name, email, role, api_key, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(id, input.name, input.email ?? null, input.role, apiKey, now, now)
    .run();

  return (await db
    .prepare('SELECT * FROM staff_members WHERE id = ?')
    .bind(id)
    .first<StaffMember>())!;
}

export async function updateStaffMember(
  db: D1Database,
  id: string,
  input: UpdateStaffInput,
): Promise<StaffMember | null> {
  const now = jstNow();
  const sets: string[] = ['updated_at = ?'];
  const values: (string | number | null)[] = [now];

  if (input.name !== undefined) { sets.push('name = ?'); values.push(input.name); }
  if (input.email !== undefined) { sets.push('email = ?'); values.push(input.email ?? null); }
  if (input.role !== undefined) { sets.push('role = ?'); values.push(input.role); }
  if (input.is_active !== undefined) { sets.push('is_active = ?'); values.push(input.is_active); }

  values.push(id);
  await db
    .prepare(`UPDATE staff_members SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  return db.prepare('SELECT * FROM staff_members WHERE id = ?').bind(id).first<StaffMember>();
}

export async function deleteStaffMember(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM staff_members WHERE id = ?').bind(id).run();
}

export async function regenerateStaffApiKey(db: D1Database, id: string): Promise<string> {
  const newKey = generateApiKey();
  const now = jstNow();
  const result = await db
    .prepare('UPDATE staff_members SET api_key = ?, updated_at = ? WHERE id = ?')
    .bind(newKey, now, id)
    .run();
  if (result.meta.changes === 0) {
    throw new Error(`Staff member not found: ${id}`);
  }
  return newKey;
}

export async function countStaffByRole(db: D1Database, role: string): Promise<number> {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM staff_members WHERE role = ?')
    .bind(role)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

export async function countActiveStaffByRole(db: D1Database, role: string): Promise<number> {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM staff_members WHERE role = ? AND is_active = 1')
    .bind(role)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

export async function getStaffByLineUserId(
  db: D1Database,
  lineUserId: string,
): Promise<StaffMember | null> {
  return db
    .prepare('SELECT * FROM staff_members WHERE line_user_id = ? AND is_active = 1')
    .bind(lineUserId)
    .first<StaffMember>();
}

export async function setStaffLineUserId(
  db: D1Database,
  staffId: string,
  lineUserId: string,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare('UPDATE staff_members SET line_user_id = ?, updated_at = ? WHERE id = ?')
    .bind(lineUserId, now, staffId)
    .run();
}

export async function createInviteToken(
  db: D1Database,
  staffId: string,
): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const now = jstNow();
  // 24h expiry
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  await db
    .prepare(
      'UPDATE staff_members SET invite_token = ?, invite_expires_at = ?, updated_at = ? WHERE id = ?',
    )
    .bind(token, expiresAt, now, staffId)
    .run();
  return token;
}

export async function getStaffByInviteToken(
  db: D1Database,
  token: string,
): Promise<StaffMember | null> {
  const staff = await db
    .prepare('SELECT * FROM staff_members WHERE invite_token = ? AND is_active = 1')
    .bind(token)
    .first<StaffMember>();
  if (!staff) return null;
  // Check expiry
  if (staff.invite_expires_at && new Date(staff.invite_expires_at).getTime() < Date.now()) {
    return null;
  }
  return staff;
}

/** Default permissions by role */
const DEFAULT_PERMISSIONS: Record<string, string[]> = {
  owner: ['*'],
  admin: ['friends', 'chats', 'scenarios', 'broadcasts', 'templates', 'reminders', 'automations', 'webhooks', 'notifications', 'scoring', 'conversions', 'affiliates', 'forms', 'accounts'],
  staff: ['friends', 'chats', 'scenarios', 'broadcasts', 'templates'],
};

export function getStaffPermissions(staff: StaffMember): string[] {
  // If custom permissions JSON is set, use it
  if (staff.permissions) {
    const parsed = JSON.parse(staff.permissions) as string[];
    return parsed;
  }
  // Otherwise, derive from role
  return DEFAULT_PERMISSIONS[staff.role] ?? [];
}

export async function clearInviteToken(
  db: D1Database,
  staffId: string,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare('UPDATE staff_members SET invite_token = NULL, invite_expires_at = NULL, updated_at = ? WHERE id = ?')
    .bind(now, staffId)
    .run();
}
