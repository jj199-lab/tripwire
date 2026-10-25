CREATE TABLE IF NOT EXISTS troves (
  chat_id     INTEGER NOT NULL,
  addr_lc     TEXT    NOT NULL,
  address     TEXT    NOT NULL,
  tier        TEXT,
  redeem_zone INTEGER NOT NULL DEFAULT 0,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (chat_id, addr_lc)
);
CREATE INDEX IF NOT EXISTS idx_troves_added ON troves (added_at);
