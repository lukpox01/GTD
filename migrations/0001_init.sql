-- GTD inbox: initial schema.
-- Timestamps are ISO-8601 UTC strings (e.g. 2026-10-15T16:30:00.000Z).

CREATE TABLE projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  outcome     TEXT,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'someday', 'done', 'dropped')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- capture
  source              TEXT NOT NULL CHECK (source IN ('text', 'voice')),
  raw_text            TEXT,              -- text message as sent (NULL for voice)
  transcript          TEXT,              -- voice transcript from the LLM
  telegram_chat_id    INTEGER,
  telegram_message_id INTEGER,
  telegram_file_id    TEXT,              -- voice file, kept so a failed note can be re-processed
  bot_message_id      INTEGER,           -- the bot's summary message (edited on button taps)

  -- GTD fields
  title               TEXT,
  next_action         TEXT,
  notes               TEXT,
  type                TEXT CHECK (type IN ('task', 'project', 'idea', 'reference', 'someday')),
  status              TEXT NOT NULL DEFAULT 'inbox'
                      CHECK (status IN ('inbox', 'next', 'waiting', 'scheduled', 'someday', 'done', 'deleted')),
  project_id          INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  context             TEXT,              -- '@pc', '@school', '@home', '@errands', ...
  time_estimate_min   INTEGER,
  energy              TEXT CHECK (energy IN ('low', 'medium', 'high')),
  steps_count         INTEGER,
  priority            TEXT CHECK (priority IN ('high', 'medium', 'low')),            -- set by the user only
  suggested_priority  TEXT CHECK (suggested_priority IN ('high', 'medium', 'low')),  -- AI suggestion
  due_date            TEXT,              -- YYYY-MM-DD, only when stated in the note

  -- AI / review metadata
  ai_confidence       REAL,
  ai_model            TEXT,
  language            TEXT,              -- 'sk' | 'en' as detected by the LLM
  needs_review        INTEGER NOT NULL DEFAULT 0,  -- 1 = AI step failed, raw note kept
  reviewed_at         TEXT,              -- NULL = not yet reviewed by the user
  pipeline_log        TEXT NOT NULL DEFAULT '[]'   -- JSON array of {step, at, detail?, error?}
);

CREATE INDEX idx_items_status ON items(status);
CREATE INDEX idx_items_unreviewed ON items(reviewed_at) WHERE reviewed_at IS NULL;
CREATE INDEX idx_items_project ON items(project_id);

-- Telegram update ids already seen, so a retried webhook delivery is processed once.
CREATE TABLE telegram_updates (
  update_id   INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
