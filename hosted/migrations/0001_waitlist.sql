-- The premium waitlist (issue #232): one row per email address, kept in the EU D1 database
-- agentic-seo-check-waitlist. A row counts once its address is confirmed; an unconfirmed one is
-- deleted within a day of its seven, by the website's daily cron trigger (src/site/waitlist.ts).
-- No IP address is kept.
CREATE TABLE waitlist (
  -- The address as typed, trimmed, with its domain in lower case.
  -- NOT NULL by hand: SQLite lets a TEXT PRIMARY KEY hold NULL, and more than one.
  email TEXT PRIMARY KEY NOT NULL,
  -- SHA-256 of the secret in the confirm and remove links, hex; the secret itself is never kept.
  token_hash TEXT NOT NULL UNIQUE,
  -- The answers: a JSON array of feature ids, and one id each for the price and who they are.
  features TEXT NOT NULL,
  price TEXT NOT NULL,
  role TEXT NOT NULL,
  -- The version of the consent text the person agreed to (CONSENT_VERSION).
  consent TEXT NOT NULL,
  -- Milliseconds since the epoch.
  created_at INTEGER NOT NULL,
  -- When the last email went to the address, so the form cannot be used to flood it.
  sent_at INTEGER NOT NULL,
  confirmed_at INTEGER
);

CREATE INDEX waitlist_unconfirmed ON waitlist (created_at) WHERE confirmed_at IS NULL;
