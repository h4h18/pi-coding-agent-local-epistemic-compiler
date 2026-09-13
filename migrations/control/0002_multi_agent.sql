CREATE TABLE IF NOT EXISTS agent_nodes (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  status TEXT NOT NULL,
  role TEXT,
  operation TEXT,
  agent_id TEXT,
  lease_id TEXT,
  artifact_digest TEXT,
  idempotency_key TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, run_id, node_id),
  FOREIGN KEY(project_id, run_id) REFERENCES runs(project_id, run_id),
  UNIQUE(project_id, idempotency_key)
) STRICT;

CREATE TABLE IF NOT EXISTS agent_handles (
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  role TEXT NOT NULL,
  session_id TEXT NOT NULL,
  adapter TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  tool_profile TEXT NOT NULL,
  capability_token_id TEXT NOT NULL,
  lease_id TEXT,
  spawned_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  PRIMARY KEY(project_id, agent_id),
  FOREIGN KEY(project_id, run_id) REFERENCES runs(project_id, run_id)
) STRICT;

CREATE TABLE IF NOT EXISTS agent_node_events (
  project_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL,
  agent_id TEXT,
  payload_digest TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY(project_id, event_id),
  UNIQUE(project_id, run_id, node_id, sequence),
  FOREIGN KEY(project_id, run_id) REFERENCES runs(project_id, run_id)
) STRICT;

CREATE TABLE IF NOT EXISTS workspace_leases (
  project_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  overlay_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  isolation_verified INTEGER NOT NULL CHECK (isolation_verified IN (0,1)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(project_id, lease_id),
  FOREIGN KEY(project_id, run_id) REFERENCES runs(project_id, run_id)
) STRICT;

CREATE TABLE IF NOT EXISTS capability_tokens (
  project_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  mac TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(project_id, token_id),
  FOREIGN KEY(project_id, run_id) REFERENCES runs(project_id, run_id)
) STRICT;

CREATE INDEX IF NOT EXISTS agent_handles_run ON agent_handles(project_id, run_id);
CREATE INDEX IF NOT EXISTS agent_nodes_run ON agent_nodes(project_id, run_id);
CREATE INDEX IF NOT EXISTS workspace_leases_run ON workspace_leases(project_id, run_id);
