-- Add line_account_id to tables that lack account scoping
-- Existing data gets NULL (= legacy/unscoped), which is fine for backward compat

ALTER TABLE templates ADD COLUMN line_account_id TEXT;
ALTER TABLE message_templates ADD COLUMN line_account_id TEXT;
ALTER TABLE scoring_rules ADD COLUMN line_account_id TEXT;
ALTER TABLE tracked_links ADD COLUMN line_account_id TEXT;
ALTER TABLE forms ADD COLUMN line_account_id TEXT;
ALTER TABLE incoming_webhooks ADD COLUMN line_account_id TEXT;
ALTER TABLE outgoing_webhooks ADD COLUMN line_account_id TEXT;
ALTER TABLE conversion_points ADD COLUMN line_account_id TEXT;
ALTER TABLE tags ADD COLUMN line_account_id TEXT;
