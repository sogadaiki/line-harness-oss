-- Additive tables only. Existing accounts, automations and friend rows are preserved.
CREATE TABLE IF NOT EXISTS hinatama_diagnosis_content (
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  code TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  PRIMARY KEY (line_account_id, code)
);
CREATE TABLE IF NOT EXISTS hinatama_diagnosis_sessions (
  id TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  cookie_hash TEXT NOT NULL,
  code TEXT NOT NULL,
  nonce TEXT,
  verifier TEXT,
  messages_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0,
  line_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_key TEXT NOT NULL,
  attempted_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hinatama_sessions_cookie ON hinatama_diagnosis_sessions(cookie_hash);
CREATE INDEX IF NOT EXISTS idx_hinatama_sessions_user ON hinatama_diagnosis_sessions(line_account_id,line_user_id,status);
CREATE TABLE IF NOT EXISTS hinatama_webhook_events (
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  event_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempted_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (line_account_id,event_id)
);
