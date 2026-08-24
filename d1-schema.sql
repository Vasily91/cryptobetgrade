-- CryptoBetGrade backend schema (Cloudflare D1 / SQLite)
-- Covers: passwordless email-link accounts, and the complaint
-- submission + admin-review + message-thread system.

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT UNIQUE NOT NULL,
  is_admin   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One-time login links. A row is created when someone requests a
-- link; it's deleted (not just marked used) the moment it's redeemed,
-- so a stolen/guessed token can never be replayed.
CREATE TABLE IF NOT EXISTS magic_links (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- status lifecycle:
--   pending_review  -> just submitted, not shown publicly yet
--   open            -> admin approved, visible on the site
--   awaiting_response -> admin asked the submitter something, waiting on them
--   resolved        -> case closed, in the submitter's favor or settled
--   rejected        -> admin reviewed and declined to publish (spam, unverifiable, abusive)
--   removed         -> was public, later taken down (e.g. proven false)
CREATE TABLE IF NOT EXISTS complaints (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_slug      TEXT NOT NULL,
  operator_name      TEXT NOT NULL,
  submitter_user_id  INTEGER NOT NULL REFERENCES users(id),
  title              TEXT NOT NULL,
  description        TEXT NOT NULL,
  amount             TEXT,
  status             TEXT NOT NULL DEFAULT 'pending_review',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at        TEXT,
  reviewed_by        INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS complaint_messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  complaint_id   INTEGER NOT NULL REFERENCES complaints(id),
  author_user_id INTEGER NOT NULL REFERENCES users(id),
  author_role    TEXT NOT NULL, -- 'submitter' | 'admin'
  body           TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_complaints_operator_slug ON complaints(operator_slug);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
CREATE INDEX IF NOT EXISTS idx_complaint_messages_complaint_id ON complaint_messages(complaint_id);
