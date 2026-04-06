-- LINE Login + JWT session support for staff_members
ALTER TABLE staff_members ADD COLUMN line_user_id TEXT;
ALTER TABLE staff_members ADD COLUMN permissions TEXT;  -- JSON string
ALTER TABLE staff_members ADD COLUMN invite_token TEXT;
ALTER TABLE staff_members ADD COLUMN invite_expires_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_line_user_id ON staff_members(line_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_invite_token ON staff_members(invite_token);
