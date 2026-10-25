-- Latest full read of the protocol (all troves, price, stability pool), refreshed every few minutes.
CREATE TABLE IF NOT EXISTS system_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One BTC price per minute from Mezo's own oracle. Used for charts and a realised-volatility estimate.
CREATE TABLE IF NOT EXISTS price_history (
  ts    INTEGER PRIMARY KEY,
  price REAL NOT NULL
);
