CREATE TABLE workspace_password (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version TEXT NOT NULL,
  salt TEXT,
  verifier TEXT,
  iterations INTEGER NOT NULL DEFAULT 100000 CHECK (iterations = 100000),
  updated_at TEXT,
  CHECK ((salt IS NULL AND verifier IS NULL) OR (salt IS NOT NULL AND verifier IS NOT NULL AND length(salt) = 64 AND length(verifier) = 64))
);
INSERT INTO workspace_password (id, version) VALUES (1, 'none');

CREATE TABLE password_attempts (
  bucket TEXT PRIMARY KEY NOT NULL,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX password_attempts_expiry ON password_attempts(expires_at);
