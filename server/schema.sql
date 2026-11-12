-- One row per strain name anyone has reported.
CREATE TABLE IF NOT EXISTS strains (
  key        TEXT PRIMARY KEY,          -- normalized name: uppercase letters/digits, single spaces
  name       TEXT NOT NULL,             -- display spelling from the first report
  created_by TEXT NOT NULL,             -- anonymous device id of the first reporter
  created_at INTEGER NOT NULL
);

-- One row per device per strain: "this device has this strain".
CREATE TABLE IF NOT EXISTS reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL REFERENCES strains (key),
  device     TEXT NOT NULL,             -- random id made by the app; not tied to a person
  state      TEXT NOT NULL,             -- US state (or country) seen at the network edge
  lane       TEXT NOT NULL,             -- FLOWER / CONCENTRATES / TOPICALS / EDIBLES
  thc        REAL,                      -- THC % read off the label, if any
  type       TEXT,                      -- Indica / Sativa / Hybrid as printed on the label, if the user answered
  terp       TEXT,                      -- top terpene printed on the label, if the user answered
  feel       TEXT,                      -- how the user says it hit them, if they rated it
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (key, device)
);

CREATE INDEX IF NOT EXISTS reports_device ON reports (device, updated_at);
CREATE INDEX IF NOT EXISTS strains_creator ON strains (created_by, created_at);

-- Reference notes for a strain, written once by a Workers AI model and reused by everyone.
-- `known` = 0 records that the model did not recognise the name (data is then "null").
CREATE TABLE IF NOT EXISTS notes (
  key        TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  known      INTEGER NOT NULL,
  data       TEXT NOT NULL,             -- JSON: type, leaning, lineage, effects, overall, flavors, summary
  model      TEXT NOT NULL,
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_created ON notes (created_at);

-- Rate-limit counters. `bucket` names what is counted and for whom (a daily-salted address
-- hash, a device id, or "all"); `win` is the day or minute number the count belongs to.
CREATE TABLE IF NOT EXISTS limits (
  bucket TEXT NOT NULL,
  win    INTEGER NOT NULL,
  n      INTEGER NOT NULL,
  PRIMARY KEY (bucket, win)
);

-- Private server settings, such as the random salt for address hashes. Never sent out.
CREATE TABLE IF NOT EXISTS config (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
