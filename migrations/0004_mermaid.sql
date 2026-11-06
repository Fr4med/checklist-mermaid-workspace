CREATE TABLE mermaid_diagrams (
  id TEXT PRIMARY KEY NOT NULL CHECK (id <> 'interactive-example'),
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  svg TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at TEXT NOT NULL
);
