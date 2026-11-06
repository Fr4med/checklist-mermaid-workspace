-- Library organization is independent from diagram source and review revisions.
-- Tombstones keep source, origin links and saved review requests recoverable.
CREATE TABLE IF NOT EXISTS diagram_library (
  diagram_id TEXT PRIMARY KEY NOT NULL,
  project_key TEXT,
  project_name TEXT,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  deleted_at TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at TEXT NOT NULL,
  CHECK ((project_key IS NULL) = (project_name IS NULL))
);
