CREATE TABLE competitions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  logo_url TEXT,
  cover_url TEXT,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  num_weeks INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS competition_id UUID REFERENCES competitions(id) ON DELETE SET NULL;

CREATE INDEX idx_competitions_dates ON competitions(start_date, end_date);
CREATE INDEX idx_leagues_competition_id ON leagues(competition_id);
