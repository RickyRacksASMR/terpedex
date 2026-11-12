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
