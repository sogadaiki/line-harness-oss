-- Notifications previously had no migration for their account ownership columns.
-- Inspect PRAGMA table_info first on installations with manual schema changes.
ALTER TABLE notification_rules ADD COLUMN line_account_id TEXT REFERENCES line_accounts(id);
ALTER TABLE notifications ADD COLUMN line_account_id TEXT REFERENCES line_accounts(id);
CREATE INDEX IF NOT EXISTS idx_notification_rules_account ON notification_rules(line_account_id);
CREATE INDEX IF NOT EXISTS idx_notifications_account ON notifications(line_account_id);
