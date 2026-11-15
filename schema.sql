-- One row per (item, device). The count is a COUNT(*), never a number we increment, so a retry or a
-- double tap cannot inflate it.
CREATE TABLE IF NOT EXISTS votes (
  item TEXT NOT NULL,
  key  TEXT NOT NULL,
  at   INTEGER NOT NULL,
  PRIMARY KEY (item, key)
);
CREATE INDEX IF NOT EXISTS votes_item ON votes(item);

-- Rate limiting, per device key and per hour. Nothing else about the caller is stored.
CREATE TABLE IF NOT EXISTS calls (
  key  TEXT NOT NULL,
  hour INTEGER NOT NULL,
  n    INTEGER NOT NULL,
  PRIMARY KEY (key, hour)
);

-- A donation that has been announced but not yet uploaded. The row dies with the upload, or ages out;
-- it holds the recording's metadata, never anything about the person who made it.
CREATE TABLE IF NOT EXISTS donations (
  token TEXT PRIMARY KEY,
  code  TEXT NOT NULL,
  sport TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  meta  TEXT NOT NULL,
  at    INTEGER NOT NULL
);
