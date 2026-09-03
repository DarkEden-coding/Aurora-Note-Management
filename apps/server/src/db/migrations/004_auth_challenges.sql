-- Stores independent, short-lived WebAuthn ceremonies so concurrent login attempts cannot invalidate each other.
CREATE TABLE auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('registration', 'authentication')),
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes',
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_challenges_active_idx
  ON auth_challenges (user_id, kind, expires_at)
  WHERE consumed_at IS NULL;
