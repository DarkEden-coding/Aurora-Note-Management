-- Persists each owner's ordered, user-editable drawing colors for cross-device sync.
ALTER TABLE users
  ADD COLUMN drawing_palette jsonb NOT NULL DEFAULT '["#000000"]'::jsonb;
