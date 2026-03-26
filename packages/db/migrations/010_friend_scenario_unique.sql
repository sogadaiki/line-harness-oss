-- Prevent duplicate scenario enrollments (race condition on follow webhook retry)
CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_scenarios_unique
  ON friend_scenarios(friend_id, scenario_id)
  WHERE status != 'completed';
