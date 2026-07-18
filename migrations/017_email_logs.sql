CREATE TABLE IF NOT EXISTS email_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resend_id    TEXT,
  type         TEXT NOT NULL,
  subject      TEXT NOT NULL,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_at    TIMESTAMPTZ,
  clicked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS email_logs_user_id_idx ON email_logs(user_id);
