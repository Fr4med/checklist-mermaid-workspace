CREATE TABLE diagram_origins (
  diagram_id TEXT PRIMARY KEY NOT NULL,
  origin_chat_id TEXT CHECK (origin_chat_id IS NULL OR length(origin_chat_id) = 36),
  updated_at TEXT NOT NULL
);

CREATE TABLE diagram_edit_requests (
  id TEXT PRIMARY KEY NOT NULL,
  diagram_id TEXT NOT NULL,
  diagram_revision INTEGER NOT NULL CHECK (diagram_revision >= 1),
  diagram_hash TEXT NOT NULL CHECK (length(diagram_hash) = 64),
  diagram_title TEXT NOT NULL,
  origin_chat_id TEXT CHECK (origin_chat_id IS NULL OR length(origin_chat_id) = 36),
  annotations_json TEXT NOT NULL CHECK (json_valid(annotations_json)),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed')),
  applied_revision INTEGER CHECK (applied_revision IS NULL OR applied_revision >= 1)
);
CREATE INDEX diagram_edit_requests_diagram_date ON diagram_edit_requests(diagram_id, created_at DESC, id DESC);
