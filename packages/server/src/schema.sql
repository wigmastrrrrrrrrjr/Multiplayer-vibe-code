CREATE TABLE IF NOT EXISTS lobbies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host_url TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS lobbies_expires_idx ON lobbies (expires_at);
