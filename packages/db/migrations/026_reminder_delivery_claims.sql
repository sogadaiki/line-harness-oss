-- Reserve a reminder step before calling LINE so concurrent crons cannot both send it.
-- Existing rows were recorded after successful sends and remain sent.
ALTER TABLE friend_reminder_deliveries ADD COLUMN status TEXT NOT NULL DEFAULT 'sent'
  CHECK(status IN ('pending','sent','failed'));
