-- Shared rate-limit counters so limits hold across several API instances.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX rate_limits_window_idx ON rate_limits (window_start);
