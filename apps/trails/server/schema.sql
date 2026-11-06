-- Accounts and the backup index for the trail app. File contents live in object storage, not here.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- One outstanding sign-in code per address. Only a keyed hash of the code is kept.
CREATE TABLE IF NOT EXISTS login_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);

-- Only a hash of each session token is kept, so a leaked table can't sign anyone in.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions (user_id);

-- Keys are hashed, so this table holds no email or IP addresses.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

-- What each account has backed up. A deleted item stays as a marker so other phones learn of it.
CREATE TABLE IF NOT EXISTS items (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  size INTEGER NOT NULL,
  deleted INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, id)
);
