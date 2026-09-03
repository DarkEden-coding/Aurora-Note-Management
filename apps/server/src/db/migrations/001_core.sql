-- Creates Aurora's core relations: identity, passkeys, sessions, library, canvas, sync ledger, history, and files.
-- Requires PostgreSQL 13+ (gen_random_uuid is built in); the pgcrypto extension is
-- created explicitly so older clusters and hardened default-extension settings still work.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setup_token_hash text,
  theme text NOT NULL DEFAULT 'neomorphic' CHECK (theme IN ('neomorphic', 'glass', 'minimal')),
  enrolled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE passkey_credentials (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'passkey',
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  user_agent text
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at) WHERE revoked_at IS NULL;

-- Files are created before notes so pdf notes can reference them directly.
CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK (size >= 0),
  mime_type text NOT NULL,
  original_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, sha256)
);
CREATE INDEX files_owner_idx ON files(owner_id);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  color text NOT NULL DEFAULT '#8b7cf6',
  sort_order integer NOT NULL DEFAULT 0,
  is_favorite boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_owner_idx ON projects(owner_id, archived_at);

CREATE TABLE folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES folders(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT folders_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX folders_owner_project_idx ON folders(owner_id, project_id);
CREATE INDEX folders_parent_idx ON folders(parent_id);

CREATE TABLE notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  folder_id uuid REFERENCES folders(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT 'Untitled note',
  kind text NOT NULL DEFAULT 'canvas' CHECK (kind IN ('canvas', 'pdf')),
  canvas_mode text NOT NULL DEFAULT 'infinite' CHECK (canvas_mode IN ('infinite', 'fixed-width', 'fixed-height', 'paged')),
  background jsonb NOT NULL DEFAULT '{}',
  favorite boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  trashed_at timestamptz,
  revision integer NOT NULL DEFAULT 0,
  pdf_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_owner_idx ON notes(owner_id, trashed_at);
CREATE INDEX notes_project_idx ON notes(project_id);
CREATE INDEX notes_folder_idx ON notes(folder_id);

CREATE TABLE pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  page_index integer NOT NULL,
  width numeric(12, 2) NOT NULL DEFAULT 794,
  height numeric(12, 2) NOT NULL DEFAULT 1123,
  background jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (note_id, page_index)
);
CREATE INDEX pages_note_idx ON pages(note_id);

CREATE TABLE canvas_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  page_id uuid REFERENCES pages(id) ON DELETE SET NULL,
  kind text NOT NULL,
  x double precision NOT NULL,
  y double precision NOT NULL,
  width double precision NOT NULL CHECK (width > 0),
  height double precision NOT NULL CHECK (height > 0),
  rotation double precision NOT NULL DEFAULT 0,
  z_index integer NOT NULL DEFAULT 0,
  locked boolean NOT NULL DEFAULT false,
  group_id uuid,
  payload jsonb NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX canvas_objects_owner_note_idx ON canvas_objects(owner_id, note_id);
CREATE INDEX canvas_objects_page_idx ON canvas_objects(page_id);

-- Conflicts are created before operations because the operations ledger references them.
CREATE TABLE conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  object_id uuid NOT NULL,
  base_object jsonb NOT NULL,
  incoming_object jsonb NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conflicts_owner_unresolved_idx ON conflicts(owner_id, resolved_at);

-- Operations are the idempotency ledger; the client operation ID is the primary key.
CREATE TABLE operations (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  device_id uuid NOT NULL,
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  object_id uuid NOT NULL,
  base_revision integer NOT NULL,
  client_timestamp timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('applied', 'conflict')),
  conflict_id uuid REFERENCES conflicts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operations_owner_created_idx ON operations(owner_id, created_at);
CREATE INDEX operations_owner_object_idx ON operations(owner_id, object_id);

CREATE TABLE snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT '',
  object_count integer NOT NULL DEFAULT 0,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX snapshots_note_idx ON snapshots(owner_id, note_id, created_at);

CREATE TABLE note_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  source_note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_page_index integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
