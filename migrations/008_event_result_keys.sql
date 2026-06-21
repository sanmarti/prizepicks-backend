-- Add result_key to event_options for structured settlement logic
ALTER TABLE event_options ADD COLUMN IF NOT EXISTS result_key VARCHAR(30);

-- Expand event_type constraint to include BTTS and CORNER_OVER
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_event_type_check;
ALTER TABLE events ADD CONSTRAINT events_event_type_check
  CHECK (event_type IN ('MATCH_RESULT','GOALS','PLAYER_SCORE','CLEAN_SHEET','BTTS','CORNER_OVER'));
