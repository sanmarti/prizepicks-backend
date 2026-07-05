-- Mark events as knockout-round matches. For knockout matches, ET goals count
-- toward goal-based markets (GOALS, BTTS, CLEAN_SHEET, PLAYER_SCORE).
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_knockout BOOLEAN NOT NULL DEFAULT FALSE;
