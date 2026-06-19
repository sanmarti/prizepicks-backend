-- Store the API-Football league ID and season on each competition
-- so the calendar can be fetched without a hardcoded name mapping.

ALTER TABLE competitions
  ADD COLUMN IF NOT EXISTS api_league_id VARCHAR(10),
  ADD COLUMN IF NOT EXISTS api_season    VARCHAR(10);
