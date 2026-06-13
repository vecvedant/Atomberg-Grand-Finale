-- Schema for the video support platform. SQLite via Node's built-in node:sqlite.
-- All timestamps are stored as ISO-8601 strings (UTC) for easy querying/display.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Staff accounts (admin / manager / agent). Customers join via invite, no account.
-- manager_id links an agent to the manager who owns their pool (NULL for managers/admin).
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('agent', 'manager', 'admin')),
  manager_id    TEXT REFERENCES agents(id),
  employee_id   TEXT,
  phone         TEXT,
  email         TEXT,
  created_at    TEXT NOT NULL
);

-- A support task / call. Created by a manager (or admin) into a manager's pool
-- with status 'open'; an agent accepts it (agent_id set) and runs the call.
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  manager_id   TEXT REFERENCES agents(id),   -- pool owner (manager)
  agent_id     TEXT REFERENCES agents(id),    -- assigned agent (NULL until accepted)
  created_by   TEXT,                          -- who created the task
  status       TEXT NOT NULL CHECK (status IN ('open', 'active', 'ended', 'scheduled')) DEFAULT 'open',
  invite_token TEXT NOT NULL,
  scheduled_at TEXT,
  accepted_at  TEXT,
  created_at   TEXT NOT NULL,
  ended_at     TEXT,
  ended_by     TEXT,
  -- Agent resolution + customer feedback (captured at end of call).
  resolved          INTEGER,          -- 1 = solved, 0 = not solved, NULL = not set (agent)
  agent_notes       TEXT,
  customer_rating   INTEGER,          -- 1..5
  customer_resolved INTEGER,          -- 1 = solved, 0 = not solved (customer)
  customer_comment  TEXT,
  -- Customer self-service intake (the public request form).
  source            TEXT NOT NULL DEFAULT 'manager',  -- 'manager' | 'intake'
  requester_name    TEXT,
  requester_phone   TEXT,
  requester_email   TEXT,
  purchase_date     TEXT,             -- ISO date the product was bought
  warranty_status   TEXT,             -- customer-declared: 'yes' | 'no' | 'unsure'
  warranty_auto     INTEGER,          -- computed in-warranty flag: 1 / 0 / NULL
  bill_file_id      TEXT REFERENCES files(id),
  ref               TEXT              -- short public reference for the customer to track
);

-- A participant instance within a session (agent or customer).
CREATE TABLE IF NOT EXISTS participants (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('agent', 'customer')),
  display_name TEXT NOT NULL,
  phone        TEXT,
  email        TEXT,
  socket_id    TEXT,
  status       TEXT NOT NULL CHECK (status IN ('connected', 'disconnected', 'left')) DEFAULT 'connected',
  joined_at    TEXT NOT NULL,
  left_at      TEXT
);

-- Chat messages exchanged during a session (persisted for the session record).
CREATE TABLE IF NOT EXISTS messages (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sender_participant_id TEXT REFERENCES participants(id),
  sender_role           TEXT NOT NULL,
  sender_name           TEXT NOT NULL,
  body                  TEXT NOT NULL DEFAULT '',
  file_id               TEXT REFERENCES files(id),
  created_at            TEXT NOT NULL
);

-- Files shared in chat (bonus feature). Stored on disk; this row is the metadata.
CREATE TABLE IF NOT EXISTS files (
  id                     TEXT PRIMARY KEY,
  session_id             TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  uploader_participant_id TEXT REFERENCES participants(id),
  original_name          TEXT NOT NULL,
  stored_name            TEXT NOT NULL,
  mime                   TEXT NOT NULL,
  size                   INTEGER NOT NULL,
  created_at             TEXT NOT NULL
);

-- Session event log: powers history + admin dashboard timelines.
CREATE TABLE IF NOT EXISTS events (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type           TEXT NOT NULL,
  participant_id TEXT,
  metadata_json  TEXT,
  created_at     TEXT NOT NULL
);

-- Call recordings (bonus feature).
CREATE TABLE IF NOT EXISTS recordings (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('recording', 'processing', 'ready', 'failed')),
  file_path    TEXT,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  duration_sec INTEGER
);

CREATE INDEX IF NOT EXISTS idx_participants_session ON participants(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_files_session ON files(session_id);
CREATE INDEX IF NOT EXISTS idx_recordings_session ON recordings(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
