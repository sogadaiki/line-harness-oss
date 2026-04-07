-- Remove duplicate messages_log entries before creating UNIQUE index
DELETE FROM messages_log
WHERE id NOT IN (
  SELECT MIN(id) FROM messages_log
  WHERE scenario_step_id IS NOT NULL
  GROUP BY friend_id, scenario_step_id
) AND scenario_step_id IS NOT NULL;

-- Prevent duplicate step delivery to the same friend for the same scenario step
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_log_step_dedup
ON messages_log(friend_id, scenario_step_id)
WHERE scenario_step_id IS NOT NULL;
