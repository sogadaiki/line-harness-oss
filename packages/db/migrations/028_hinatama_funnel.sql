-- Pseudonymous progress only; no answers, result codes, LINE IDs or raw OAuth values.
CREATE TABLE hinatama_funnel_visits (
  line_account_id TEXT NOT NULL,
  visit_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  client_started_at INTEGER NOT NULL,
  lp_version TEXT NOT NULL,
  source TEXT NOT NULL, medium TEXT NOT NULL, campaign TEXT NOT NULL,
  content TEXT NOT NULL, ref TEXT NOT NULL,
  PRIMARY KEY (line_account_id, visit_id)
);
CREATE TABLE hinatama_funnel_attempts (
  line_account_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  visit_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  client_started_at INTEGER NOT NULL,
  lp_version TEXT NOT NULL,
  source TEXT NOT NULL, medium TEXT NOT NULL, campaign TEXT NOT NULL,
  content TEXT NOT NULL, ref TEXT NOT NULL,
  PRIMARY KEY (line_account_id, attempt_id)
);
CREATE INDEX hinatama_funnel_cohort ON hinatama_funnel_attempts(line_account_id, started_at);
CREATE TABLE hinatama_funnel_events (
  line_account_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  PRIMARY KEY (line_account_id, attempt_id, event_key)
);
CREATE TABLE hinatama_funnel_receipt_views (
  line_account_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  attempt_id TEXT,
  viewed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  display_state TEXT NOT NULL,
  success_viewed_at INTEGER,
  PRIMARY KEY (line_account_id, receipt_id)
);
ALTER TABLE hinatama_diagnosis_sessions ADD COLUMN funnel_attempt_id TEXT;

-- Server-only joins use the existing internal friend UUID. No LINE ID, name,
-- message body, answer or result code is copied into the measurement tables.
CREATE TABLE hinatama_funnel_links (
  line_account_id TEXT NOT NULL, receipt_id TEXT NOT NULL,
  attempt_id TEXT, friend_id TEXT NOT NULL, authorized_at INTEGER NOT NULL,
  PRIMARY KEY(line_account_id, receipt_id)
);
CREATE INDEX hinatama_funnel_friend ON hinatama_funnel_links(line_account_id, friend_id, authorized_at);
CREATE TABLE hinatama_funnel_outcomes (
  line_account_id TEXT NOT NULL, event_id TEXT NOT NULL, friend_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('follow','refollow','follow_unknown','unfollow','inquiry')),
  occurred_at INTEGER NOT NULL,
  PRIMARY KEY(line_account_id, event_id)
);
CREATE INDEX hinatama_funnel_outcome_time ON hinatama_funnel_outcomes(line_account_id, occurred_at);
CREATE INDEX hinatama_funnel_first_outcome ON hinatama_funnel_outcomes(line_account_id, friend_id, kind, occurred_at);
CREATE TABLE hinatama_funnel_exclusions (
  line_account_id TEXT NOT NULL, friend_id TEXT NOT NULL, reason TEXT NOT NULL CHECK(reason='qa'),
  PRIMARY KEY(line_account_id, friend_id)
);
