-- Track pack and price per purchase transaction for revenue reporting
ALTER TABLE energy_transactions
  ADD COLUMN IF NOT EXISTS pack_id     UUID REFERENCES energy_packs(id),
  ADD COLUMN IF NOT EXISTS price_euros DECIMAL(10,2);
