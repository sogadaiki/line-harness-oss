-- Explicit grants for non-owner staff on the shared worker. No automatic grants.
CREATE TABLE IF NOT EXISTS staff_line_accounts (
  staff_id TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, line_account_id)
);
