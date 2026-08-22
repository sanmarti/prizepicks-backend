-- Explicit start/end date per gameweek for Mon-Sun scheduling
ALTER TABLE gameweeks ADD COLUMN IF NOT EXISTS start_date TIMESTAMPTZ;
ALTER TABLE gameweeks ADD COLUMN IF NOT EXISTS end_date   TIMESTAMPTZ;
