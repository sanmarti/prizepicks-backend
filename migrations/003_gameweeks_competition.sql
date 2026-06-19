-- Gameweeks now belong to a competition, not a specific league.
-- All leagues sharing that competition inherit its gameweeks automatically.

ALTER TABLE gameweeks ADD COLUMN IF NOT EXISTS competition_id UUID REFERENCES competitions(id) ON DELETE CASCADE;

-- Make league_id nullable (legacy rows keep their value, new rows use competition_id)
ALTER TABLE gameweeks ALTER COLUMN league_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gameweeks_competition ON gameweeks(competition_id);
