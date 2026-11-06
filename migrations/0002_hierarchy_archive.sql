ALTER TABLE projects ADD COLUMN scope TEXT NOT NULL DEFAULT 'project' CHECK (scope IN ('project', 'chat'));
ALTER TABLE projects ADD COLUMN project_key TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN project_name TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN chat_id TEXT;
ALTER TABLE projects ADD COLUMN chat_title TEXT;
ALTER TABLE projects ADD COLUMN archived_at TEXT;

-- Existing connections keep their IDs and become separate project checklists.
-- Names are display labels, never a reason to merge records.
UPDATE projects SET project_key = id, project_name = name;

-- The previous Worker may finish an enrollment while the new code is uploaded.
-- Populate only its omitted identity fields within that same INSERT statement.
CREATE TRIGGER projects_fill_legacy_identity
AFTER INSERT ON projects
WHEN NEW.project_key = ''
BEGIN
  UPDATE projects SET project_key = NEW.id, project_name = NEW.name
  WHERE id = NEW.id AND project_key = '';
END;

CREATE UNIQUE INDEX projects_active_project_identity
  ON projects(project_key)
  WHERE scope = 'project' AND archived_at IS NULL;
CREATE UNIQUE INDEX projects_active_chat_identity
  ON projects(project_key, chat_id)
  WHERE scope = 'chat' AND archived_at IS NULL;
CREATE INDEX projects_archive_listing ON projects(archived_at, updated_at);
