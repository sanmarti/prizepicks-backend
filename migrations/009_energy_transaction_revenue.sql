-- Separate revenue-tracking table (ppuser-owned) instead of altering
-- the postgres-owned energy_transactions table.
CREATE TABLE IF NOT EXISTS energy_pack_purchases (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID REFERENCES users(id),
  pack_id       UUID REFERENCES energy_packs(id),
  pack_name     VARCHAR(200),
  energy_amount INT,
  price_euros   DECIMAL(10,2),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_epp_user       ON energy_pack_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_epp_created_at ON energy_pack_purchases(created_at);
