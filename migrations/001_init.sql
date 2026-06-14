CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  avatar_url TEXT,
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE leagues (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  competition VARCHAR(20) NOT NULL CHECK (competition IN ('EPL','CHAMPIONS','LALIGA','WORLDCUP','SERIEA')),
  season VARCHAR(10) NOT NULL,
  creator_id UUID REFERENCES users(id),
  max_teams INT DEFAULT 12,
  entry_fee DECIMAL(10,2) DEFAULT 0,
  prize_pool DECIMAL(10,2) DEFAULT 0,
  missed_week_rule VARCHAR(20) DEFAULT 'RANDOM' CHECK (missed_week_rule IN ('RANDOM','FAVORITES','ZERO')),
  league_format VARCHAR(20) DEFAULT 'STANDINGS' CHECK (league_format IN ('STANDINGS','PLAYOFFS')),
  status VARCHAR(20) DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','FINISHED')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE league_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id UUID REFERENCES leagues(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  payment_status VARCHAR(20) DEFAULT 'FREE' CHECK (payment_status IN ('FREE','PAID','PENDING','ON_HOLD')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(league_id, user_id)
);

CREATE TABLE invites (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id UUID REFERENCES leagues(id) ON DELETE CASCADE,
  code VARCHAR(20) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE gameweeks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id UUID REFERENCES leagues(id),
  week_number INT NOT NULL,
  competition VARCHAR(20),
  lock_time TIMESTAMPTZ NOT NULL,
  reveal_time TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','LOCKED','FINISHED')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gameweek_id UUID REFERENCES gameweeks(id) ON DELETE CASCADE,
  event_type VARCHAR(20) CHECK (event_type IN ('MATCH_RESULT','GOALS','PLAYER_SCORE','CLEAN_SHEET')),
  fixture_id VARCHAR(50),
  fixture_name VARCHAR(200),
  player_name VARCHAR(100),
  competition VARCHAR(20),
  match_time TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING','LIVE','FINISHED'))
);

CREATE TABLE event_options (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id UUID REFERENCES events(id) ON DELETE CASCADE,
  label VARCHAR(50) NOT NULL,
  energy_cost INT NOT NULL CHECK (energy_cost BETWEEN 1 AND 9),
  result VARCHAR(10) DEFAULT 'PENDING' CHECK (result IN ('PENDING','WON','LOST'))
);

CREATE TABLE user_cards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gameweek_id UUID REFERENCES gameweeks(id),
  user_id UUID REFERENCES users(id),
  total_energy_used INT DEFAULT 0,
  locked_at TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'OPEN' CHECK (status IN ('OPEN','LOCKED')),
  final_score INT DEFAULT 0,
  UNIQUE(gameweek_id, user_id)
);

CREATE TABLE card_picks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  card_id UUID REFERENCES user_cards(id) ON DELETE CASCADE,
  event_option_id UUID REFERENCES event_options(id),
  energy_cost_final INT NOT NULL,
  discount_applied INT DEFAULT 0,
  pick_status VARCHAR(20) DEFAULT 'SLEEPING' CHECK (pick_status IN ('SLEEPING','LIVE_FAVORABLE','LIVE_NEUTRAL','LIVE_RISK','WON','LOST')),
  projected_value DECIMAL(4,2) DEFAULT 0
);

CREATE TABLE matchups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gameweek_id UUID REFERENCES gameweeks(id),
  home_user_id UUID REFERENCES users(id),
  away_user_id UUID REFERENCES users(id),
  home_score INT DEFAULT 0,
  away_score INT DEFAULT 0,
  winner_user_id UUID REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING','LIVE','FINISHED'))
);

CREATE TABLE energy_wallets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID UNIQUE REFERENCES users(id),
  balance INT DEFAULT 0
);

CREATE TABLE energy_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  amount INT NOT NULL,
  type VARCHAR(20) CHECK (type IN ('PURCHASE','USAGE','REWARD')),
  description VARCHAR(200),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE standings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id UUID REFERENCES leagues(id),
  user_id UUID REFERENCES users(id),
  wins INT DEFAULT 0,
  losses INT DEFAULT 0,
  draws INT DEFAULT 0,
  points INT DEFAULT 0,
  total_energy_used INT DEFAULT 0,
  UNIQUE(league_id, user_id)
);

CREATE INDEX idx_league_members_league ON league_members(league_id);
CREATE INDEX idx_gameweeks_league ON gameweeks(league_id);
CREATE INDEX idx_events_gameweek ON events(gameweek_id);
CREATE INDEX idx_card_picks_card ON card_picks(card_id);
CREATE INDEX idx_matchups_gameweek ON matchups(gameweek_id);
CREATE INDEX idx_standings_league ON standings(league_id);
