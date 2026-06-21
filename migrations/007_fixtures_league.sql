-- Add league metadata columns to fixtures so sprint gameweek builder
-- can show the league name even when there's no matching competition record.
ALTER TABLE fixtures
  ADD COLUMN IF NOT EXISTS league_name    VARCHAR(100),
  ADD COLUMN IF NOT EXISTS api_league_id  INTEGER;
