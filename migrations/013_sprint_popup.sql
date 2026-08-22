-- Track whether a user has seen the sprint closing popup
ALTER TABLE user_sprint_progress ADD COLUMN IF NOT EXISTS closing_popup_seen_at TIMESTAMPTZ;
