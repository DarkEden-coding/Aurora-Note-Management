-- Stores guided-practice sessions, their questions, and the durable event queue practice_wait drains.
CREATE TABLE practice_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  note_id uuid NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE,
  title text NOT NULL,
  total_questions integer NOT NULL CHECK (total_questions > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'complete')),
  status_text text,
  options jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX practice_sessions_owner_idx ON practice_sessions(owner_id, status, updated_at);

CREATE TABLE practice_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  idx integer NOT NULL CHECK (idx >= 0),
  page_index integer NOT NULL CHECK (page_index >= 0),
  state text NOT NULL DEFAULT 'awaiting_work'
    CHECK (state IN ('awaiting_work', 'submitted', 'graded', 'closed')),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  max_points numeric(10, 2) NOT NULL CHECK (max_points > 0),
  points numeric(10, 2),
  latest_points numeric(10, 2),
  topics text[] NOT NULL DEFAULT '{}',
  prompt_object_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, idx)
);

CREATE TABLE practice_events (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES practice_questions(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('submitted', 'next', 'retry')),
  attempt integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);
CREATE INDEX practice_events_pending_idx
  ON practice_events(session_id, id)
  WHERE consumed_at IS NULL;
