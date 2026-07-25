-- padawan decision_log: AI推奨打ち手の提示・CEO判断・72h効果検証トレース
-- Refs: build-spec.md line 304-322

CREATE TABLE IF NOT EXISTS decision_log (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  playbook_id              TEXT    NOT NULL,                       -- playbook.yaml の id
  generated_at             TEXT    NOT NULL,                       -- 提示日時 (ISO8601)
  recommendation_level     TEXT    NOT NULL,                       -- HIGH/MED/LOW
  rationale                TEXT,                                   -- rationale_template 展開後
  evidence_json            TEXT,                                   -- 根拠データ JSON 文字列
  status                   TEXT    NOT NULL DEFAULT 'PENDING',     -- PENDING/APPROVED/REJECTED/HELD
  decided_at               TEXT,                                   -- CEO判断日時
  decided_by               TEXT,                                   -- 'CEO' 固定 (将来 'INADA' 等拡張)
  verification_metric_json TEXT,                                   -- verification_metric の JSON snapshot
  verification_result_json TEXT,                                   -- 72h後の検証結果 (NULL→VERIFIED後に埋まる)
  verified_at              TEXT                                    -- 検証完了日時
);

CREATE INDEX IF NOT EXISTS idx_decision_log_status       ON decision_log (status);
CREATE INDEX IF NOT EXISTS idx_decision_log_generated_at ON decision_log (generated_at);
CREATE INDEX IF NOT EXISTS idx_decision_log_playbook_id  ON decision_log (playbook_id);
