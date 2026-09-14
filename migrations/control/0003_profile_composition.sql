CREATE TABLE IF NOT EXISTS run_compiled_profiles (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  composition_json TEXT NOT NULL,
  legacy_profile_id TEXT NOT NULL,
  blocked_reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, run_id),
  FOREIGN KEY(project_id, run_id) REFERENCES runs(project_id, run_id)
) STRICT;

CREATE TABLE IF NOT EXISTS related_runs (
  project_id TEXT NOT NULL,
  parent_run_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  child_run_id TEXT,
  relation TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  deferred INTEGER NOT NULL CHECK (deferred IN (0,1)),
  blocks_parent INTEGER NOT NULL CHECK (blocks_parent IN (0,1)),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, parent_run_id, plan_id),
  FOREIGN KEY(project_id, parent_run_id) REFERENCES runs(project_id, run_id)
) STRICT;

CREATE INDEX IF NOT EXISTS related_runs_parent ON related_runs(project_id, parent_run_id);
CREATE INDEX IF NOT EXISTS related_runs_child ON related_runs(project_id, child_run_id);
