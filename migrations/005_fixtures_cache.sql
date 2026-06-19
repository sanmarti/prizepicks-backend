-- Cache API-Football fixture data to avoid hitting daily quota

CREATE TABLE fixtures (
  id            BIGINT PRIMARY KEY,                                   -- API-Football fixture ID
  competition_id UUID REFERENCES competitions(id) ON DELETE CASCADE,
  round         VARCHAR(100),
  date          TIMESTAMPTZ,
  status_short  VARCHAR(10),
  status_long   VARCHAR(50),
  status_elapsed INT,
  referee       VARCHAR(100),
  venue_name    VARCHAR(100),
  venue_city    VARCHAR(100),
  home_team     VARCHAR(100),
  home_logo     TEXT,
  home_winner   BOOLEAN,
  away_team     VARCHAR(100),
  away_logo     TEXT,
  away_winner   BOOLEAN,
  home_goals    INT,
  away_goals    INT,
  ht_home       INT,
  ht_away       INT,
  et_home       INT,
  et_away       INT,
  pen_home      INT,
  pen_away      INT,
  details_cached BOOLEAN DEFAULT FALSE,
  cached_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE fixture_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fixture_id  BIGINT REFERENCES fixtures(id) ON DELETE CASCADE,
  elapsed     INT,
  extra       INT,
  team        VARCHAR(100),
  team_logo   TEXT,
  player      VARCHAR(100),
  assist      VARCHAR(100),
  type        VARCHAR(50),
  detail      VARCHAR(100),
  comments    TEXT
);

CREATE TABLE fixture_statistics (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fixture_id  BIGINT REFERENCES fixtures(id) ON DELETE CASCADE,
  team        VARCHAR(100),
  team_logo   TEXT,
  stat_type   VARCHAR(100),
  stat_value  VARCHAR(50)
);

CREATE TABLE fixture_lineups (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fixture_id    BIGINT REFERENCES fixtures(id) ON DELETE CASCADE,
  team          VARCHAR(100),
  team_logo     TEXT,
  formation     VARCHAR(20),
  coach         VARCHAR(100),
  is_substitute BOOLEAN DEFAULT FALSE,
  player_number INT,
  player_name   VARCHAR(100),
  player_pos    VARCHAR(10),
  player_grid   VARCHAR(10)
);

CREATE TABLE competition_standings (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  competition_id UUID REFERENCES competitions(id) ON DELETE CASCADE,
  group_name     VARCHAR(100),
  rank           INT,
  team           VARCHAR(100),
  team_logo      TEXT,
  points         INT,
  played         INT,
  win            INT,
  draw           INT,
  lose           INT,
  gf             INT,
  ga             INT,
  gd             INT,
  form           VARCHAR(10),
  description    TEXT,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_fixtures_competition  ON fixtures(competition_id);
CREATE INDEX idx_fixtures_status       ON fixtures(status_short);
CREATE INDEX idx_fixtures_date         ON fixtures(date);
CREATE INDEX idx_fixture_events_fix    ON fixture_events(fixture_id);
CREATE INDEX idx_fixture_stats_fix     ON fixture_statistics(fixture_id);
CREATE INDEX idx_fixture_lineups_fix   ON fixture_lineups(fixture_id);
CREATE INDEX idx_comp_standings_comp   ON competition_standings(competition_id);
