-- CryptoBetGrade backend schema (Cloudflare D1 / SQLite)
-- Covers: passwordless email-link accounts, and the complaint
-- submission + admin-review + message-thread system.

-- operator_slug: added via the one-time /api/admin/migrate-operator-
-- accounts endpoint (ALTER TABLE, see worker.js), same reason as the
-- complaint_messages columns below (no wrangler CLI access to this
-- deploy's database). When set, this user may log in (the existing
-- passwordless magic-link flow — no separate login system) and reply
-- directly in that one operator's complaint threads, tagged
-- author_role='operator' (see postMessage in worker.js) — e.g. a
-- Rakebit support rep granted access only to Rakebit's own threads.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  operator_slug TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
--
-- public_summary: added via the one-time /api/admin/migrate-complaint-
-- summary endpoint (ALTER TABLE, see worker.js), same no-wrangler-CLI
-- reason as the other migration endpoints. An admin-written narrative of
-- the complaint in CryptoBetGrade's own voice (third person, like the
-- curated complaints' whatHappened text) — shown on the public complaint
-- page in place of the submitter's raw first-person `description` when
-- set, via getComplaint. Purely editorial framing: `description` itself,
-- and the submitter's own first message in the thread (a copy of it, see
-- submitComplaint), are never altered by setting this.
CREATE TABLE IF NOT EXISTS complaints (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_slug      TEXT NOT NULL,
  operator_name      TEXT NOT NULL,
  submitter_user_id  INTEGER NOT NULL REFERENCES users(id),
  title              TEXT NOT NULL,
  description        TEXT NOT NULL,
  public_summary     TEXT,
  amount             TEXT,
  status             TEXT NOT NULL DEFAULT 'pending_review',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at        TEXT,
  reviewed_by        INTEGER REFERENCES users(id)
);

-- visible/public_body: added via the one-time /api/admin/migrate-message-
-- visibility endpoint (ALTER TABLE, see worker.js) rather than being part
-- of this CREATE TABLE from the start, for the same no-wrangler-CLI reason
-- reviews' migration endpoint exists. They let an admin hide a message
-- from the public thread view, or swap in a redacted stand-in (e.g. a
-- submitter pasted their own email into a reply) without altering what
-- was actually written — the admin and the submitter themselves always
-- see the real `body`; everyone else sees `public_body` in its place when
-- set, or nothing at all when visible = 0.
CREATE TABLE IF NOT EXISTS complaint_messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  complaint_id   INTEGER NOT NULL REFERENCES complaints(id),
  author_user_id INTEGER NOT NULL REFERENCES users(id),
  author_role    TEXT NOT NULL, -- 'submitter' | 'admin' | 'operator'
  body           TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  visible        INTEGER NOT NULL DEFAULT 1, -- 0 = hidden from public thread view
  public_body    TEXT -- redacted stand-in shown to the public instead of `body`, when set
);

-- Star reviews, one per (operator, user) — see the unique index below.
-- Simpler lifecycle than complaints (no message thread, no
-- awaiting_response/resolved/removed): pending_review -> approved |
-- rejected. Applied to the live database via the one-time
-- /api/admin/migrate-reviews endpoint in worker.js (idempotent — every
-- statement here uses IF NOT EXISTS), since this deploy pipeline has no
-- wrangler/CLI access to run `wrangler d1 execute` directly.
CREATE TABLE IF NOT EXISTS reviews (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_slug      TEXT NOT NULL,
  operator_name      TEXT NOT NULL,
  submitter_user_id  INTEGER NOT NULL REFERENCES users(id),
  rating             INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title              TEXT,
  body               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending_review',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at        TEXT,
  reviewed_by        INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_complaints_operator_slug ON complaints(operator_slug);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
CREATE INDEX IF NOT EXISTS idx_complaint_messages_complaint_id ON complaint_messages(complaint_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_one_per_user ON reviews(operator_slug, submitter_user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_operator_slug ON reviews(operator_slug);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);
