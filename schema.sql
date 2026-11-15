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

-- Bytes ever written to the donation bucket. A cost cap, not a statistic: R2's free allowance is 10 GB,
-- and Cloudflare's spending limit does not cover R2, so this counter is the only hard stop there is.
-- One row, never more. Objects age out after 24 months, so stored bytes stay below this number.
CREATE TABLE IF NOT EXISTS budget (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  bytes INTEGER NOT NULL
);

-- A reported problem that the reporter can follow. The code is the whole credential: it is what the
-- app stores, what the reporter types back after a new install, and what withdraws the report. It is
-- therefore long enough not to be guessed, and it is the ONLY thing tying a device to a report. The
-- device key never appears here, so this table cannot say which reports came from the same person.
CREATE TABLE IF NOT EXISTS reports (
  code   TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  lang   TEXT NOT NULL,
  at     INTEGER NOT NULL
);

-- An announced log upload, between the announcement and the bytes. Dies with the upload, or ages out.
CREATE TABLE IF NOT EXISTS report_uploads (
  token TEXT PRIMARY KEY,
  code  TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  at    INTEGER NOT NULL
);

-- Bytes ever written to the report logs, the same hard stop as `budget` but counted apart, so a busy
-- week of bug reports cannot eat the allowance the donations live on, nor the other way round.
CREATE TABLE IF NOT EXISTS log_budget (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  bytes INTEGER NOT NULL
);
