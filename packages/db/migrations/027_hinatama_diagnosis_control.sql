-- Dedicated diagnostic pause flag. No existing accounts or message data are changed.
CREATE TABLE IF NOT EXISTS hinatama_diagnosis_control (
  line_account_id TEXT PRIMARY KEY REFERENCES line_accounts(id),
  is_paused INTEGER NOT NULL DEFAULT 0 CHECK (is_paused IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
