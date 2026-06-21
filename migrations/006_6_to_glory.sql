-- 6 to Glory: permanent competitive division progression system

-- Divisions (Academy → Division 4 → Division 3 → Division 2 → Division 1 → Champions)
CREATE TABLE divisions (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                 VARCHAR(100) NOT NULL,
  display_order        INT NOT NULL,
  icon                 VARCHAR(20),
  badge_url            TEXT,
  color_primary        VARCHAR(7)  DEFAULT '#6366f1',
  color_secondary      VARCHAR(7)  DEFAULT '#4f46e5',
  is_initial           BOOLEAN     DEFAULT FALSE,   -- Academy
  is_highest           BOOLEAN     DEFAULT FALSE,   -- Champions/Legend
  allows_relegation    BOOLEAN     DEFAULT TRUE,
  -- Point thresholds (NULL on relegation_max means no relegation boundary)
  relegation_max_points   INT,
  retention_min_points    INT NOT NULL DEFAULT 0,
  retention_max_points    INT NOT NULL,
  promotion_min_points    INT NOT NULL,
  is_active            BOOLEAN     DEFAULT TRUE,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (display_order)
);

-- Sprints: 4-gameweek competitive blocks
CREATE TABLE sprints (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           VARCHAR(100) NOT NULL,
  start_date     TIMESTAMPTZ NOT NULL,
  end_date       TIMESTAMPTZ NOT NULL,
  status         VARCHAR(20) DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','live','completed','archived')),
  gameweek_count INT DEFAULT 4,
  rule_snapshot  JSONB,        -- snapshot of division rules at settlement time
  settled_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Link existing gameweeks to sprints (a sprint contains exactly 4 gameweeks)
ALTER TABLE gameweeks ADD COLUMN IF NOT EXISTS sprint_id   UUID REFERENCES sprints(id) ON DELETE SET NULL;
ALTER TABLE gameweeks ADD COLUMN IF NOT EXISTS sprint_week INT;   -- 1-4 within the sprint
-- make competition_id fully optional (sprint gameweeks span multiple competitions)
ALTER TABLE gameweeks ALTER COLUMN competition_id DROP NOT NULL;

-- User's current division assignment
CREATE TABLE user_division_status (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  division_id            UUID REFERENCES divisions(id),
  is_rookie              BOOLEAN DEFAULT TRUE,
  rookie_until_sprint_id UUID REFERENCES sprints(id),
  assigned_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

-- User progress within a Sprint
CREATE TABLE user_sprint_progress (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID REFERENCES users(id) ON DELETE CASCADE,
  sprint_id             UUID REFERENCES sprints(id) ON DELETE CASCADE,
  division_id           UUID REFERENCES divisions(id),   -- division at sprint start
  is_rookie             BOOLEAN DEFAULT FALSE,
  total_correct_picks   INT DEFAULT 0,
  total_incorrect_picks INT DEFAULT 0,
  total_league_points   INT DEFAULT 0,
  perfect_weeks         INT DEFAULT 0,
  gameweeks_participated INT DEFAULT 0,
  sprint_outcome        VARCHAR(20) CHECK (sprint_outcome IN ('promoted','retained','relegated','rookie','pending')),
  final_division_id     UUID REFERENCES divisions(id),
  settled_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, sprint_id)
);

-- User's entry for one Gameweek (holds their 6 picks)
CREATE TABLE user_gameweek_entries (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID REFERENCES users(id) ON DELETE CASCADE,
  gameweek_id         UUID REFERENCES gameweeks(id) ON DELETE CASCADE,
  sprint_id           UUID REFERENCES sprints(id),
  status              VARCHAR(20) DEFAULT 'open'
    CHECK (status IN ('open','locked','settling','completed','void')),
  picks_submitted     INT DEFAULT 0,
  correct_picks       INT DEFAULT 0,
  incorrect_picks     INT DEFAULT 0,
  league_points       INT DEFAULT 0,
  perfect_week_bonus  INT DEFAULT 0,
  is_perfect_week     BOOLEAN DEFAULT FALSE,
  settled_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, gameweek_id)
);

-- Individual picks: exactly 6 per entry
CREATE TABLE user_picks (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entry_id         UUID REFERENCES user_gameweek_entries(id) ON DELETE CASCADE,
  user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
  gameweek_id      UUID REFERENCES gameweeks(id) ON DELETE CASCADE,
  event_id         UUID REFERENCES events(id),
  event_option_id  UUID REFERENCES event_options(id),
  pick_status      VARCHAR(20) DEFAULT 'pending'
    CHECK (pick_status IN ('pending','live','won','lost','void')),
  settled_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (entry_id, event_id)   -- one pick per event per entry
);

-- Badge catalog
CREATE TABLE badges (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code        VARCHAR(50) UNIQUE NOT NULL,
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  icon        TEXT,
  badge_url   TEXT,
  is_active   BOOLEAN DEFAULT TRUE
);

-- User badge awards
CREATE TABLE user_badges (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  badge_id     UUID REFERENCES badges(id),
  sprint_id    UUID REFERENCES sprints(id),
  gameweek_id  UUID REFERENCES gameweeks(id),
  earned_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Promotion / relegation movement log
CREATE TABLE promotion_relegation_history (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
  sprint_id        UUID REFERENCES sprints(id),
  from_division_id UUID REFERENCES divisions(id),
  to_division_id   UUID REFERENCES divisions(id),
  movement         VARCHAR(20) NOT NULL CHECK (movement IN ('promoted','retained','relegated','rookie')),
  league_points    INT NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Admin audit log
CREATE TABLE admin_audit_log (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_user_id UUID REFERENCES users(id),
  action        VARCHAR(100) NOT NULL,
  entity_type   VARCHAR(50),
  entity_id     TEXT,
  details       JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_gameweeks_sprint           ON gameweeks(sprint_id);
CREATE INDEX idx_user_div_status_user       ON user_division_status(user_id);
CREATE INDEX idx_sprint_progress_user       ON user_sprint_progress(user_id);
CREATE INDEX idx_sprint_progress_sprint     ON user_sprint_progress(sprint_id);
CREATE INDEX idx_gw_entries_user            ON user_gameweek_entries(user_id);
CREATE INDEX idx_gw_entries_gw              ON user_gameweek_entries(gameweek_id);
CREATE INDEX idx_gw_entries_sprint          ON user_gameweek_entries(sprint_id);
CREATE INDEX idx_user_picks_entry           ON user_picks(entry_id);
CREATE INDEX idx_user_picks_user            ON user_picks(user_id);
CREATE INDEX idx_user_picks_gw              ON user_picks(gameweek_id);
CREATE INDEX idx_promo_history_user         ON promotion_relegation_history(user_id);
CREATE INDEX idx_promo_history_sprint       ON promotion_relegation_history(sprint_id);
CREATE INDEX idx_user_badges_user           ON user_badges(user_id);

-- ── Seed Data ─────────────────────────────────────────────────────────────────

INSERT INTO divisions
  (name, display_order, icon, color_primary, color_secondary,
   is_initial, is_highest, allows_relegation,
   relegation_max_points, retention_min_points, retention_max_points, promotion_min_points)
VALUES
  ('Academy',           1, '🎓', '#6b7280', '#4b5563', TRUE,  FALSE, FALSE, NULL, 0,  16, 17),
  ('Division 4',        2, '🟢', '#10b981', '#059669', FALSE, FALSE, TRUE,  9,   10, 16, 17),
  ('Division 3',        3, '🔵', '#3b82f6', '#2563eb', FALSE, FALSE, TRUE,  10,  11, 17, 18),
  ('Division 2',        4, '🟣', '#8b5cf6', '#7c3aed', FALSE, FALSE, TRUE,  10,  11, 18, 19),
  ('Division 1',        5, '🟡', '#f59e0b', '#d97706', FALSE, FALSE, TRUE,  11,  12, 19, 20),
  ('Champions / Legend',6, '👑', '#ef4444', '#dc2626', FALSE, TRUE,  TRUE,  NULL, 0, 999,999);

INSERT INTO badges (code, name, description, icon) VALUES
  ('FIRST_GAMEWEEK',     'First Gameweek',       'Completed your first Gameweek',                        '🎮'),
  ('FIRST_CORRECT',      'First Correct Pick',   'Got your first correct prediction',                    '✅'),
  ('PERFECT_WEEK',       'Perfect Week',         '6/6 picks correct in one Gameweek — 10 League Points!','⭐'),
  ('PERFECT_MONTH',      'Perfect Month',        'Perfect Week in all 4 Gameweeks of a Sprint',          '🌟'),
  ('FIRST_PROMOTION',    'First Promotion',      'Promoted to a higher division for the first time',     '⬆️'),
  ('COMEBACK',           'Comeback Promotion',   'Promoted after being relegated',                       '💪'),
  ('THREE_PROMOTIONS',   'Rising Star',          'Promoted 3 times total',                               '🚀'),
  ('REACHED_DIV1',       'Elite Climber',        'Reached Division 1',                                   '🏅'),
  ('REACHED_CHAMPIONS',  'Champion',             'Reached Champions / Legend',                           '👑'),
  ('CONSISTENT_PLAYER',  'Consistent Player',    'Completed all 4 Gameweeks in a Sprint',                '🗓️');

-- Auto-assign Academy to all existing users
INSERT INTO user_division_status (user_id, division_id, is_rookie)
SELECT u.id, d.id, TRUE
FROM users u
CROSS JOIN divisions d
WHERE d.is_initial = TRUE
ON CONFLICT (user_id) DO NOTHING;
