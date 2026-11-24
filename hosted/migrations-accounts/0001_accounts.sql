-- The premium accounts (issue #229): one row per email address, kept in the EU D1 database
-- agentic-seo-check-accounts. An account keeps no record of audits and no sites; the only thing
-- that names a site is the Durable Object's day-scoped count, as keyed hashes (src/state.ts).
CREATE TABLE accounts (
  -- "acc_" and 22 random base64url characters. Named in the session cookie and in Stripe's
  -- client_reference_id and subscription metadata, so it is no secret and not the email.
  id TEXT PRIMARY KEY NOT NULL,
  -- The address as typed, trimmed, with its domain in lower case (normalEmail). What the sign-in
  -- code goes to, and the one way an account is found again.
  email TEXT NOT NULL UNIQUE,
  -- Stripe's customer id (cus_...), set when the first checkout starts; null until then.
  stripe_customer_id TEXT UNIQUE,
  -- Stripe's subscription id (sub_...) and its status (active, past_due, canceled...), as the
  -- last accepted webhook said; null before a first subscription.
  subscription_id TEXT,
  subscription_status TEXT,
  -- When the paid period ends, in seconds since the epoch, as Stripe sends it.
  current_period_end INTEGER,
  -- When Stripe made the event last applied, in seconds, so an older event arriving late
  -- cannot undo a newer one.
  stripe_event_at INTEGER,
  -- Milliseconds since the epoch.
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The sign-in codes: one live code per address, replaced when a new one goes out, and the
-- address's wrong guesses of the day, which a new code keeps.
CREATE TABLE sign_in_codes (
  -- The address the code went to, as in accounts.email.
  -- NOT NULL by hand: SQLite lets a TEXT PRIMARY KEY hold NULL, and more than one.
  email TEXT PRIMARY KEY NOT NULL,
  -- SHA-256 of the six digits, hex; the code itself is never kept.
  code_hash TEXT NOT NULL,
  -- Wrong guesses so far; the code dies at five.
  attempts INTEGER NOT NULL DEFAULT 0,
  -- Milliseconds since the epoch: when the code stops working, and when it was sent (so a new
  -- one cannot follow within a minute and the form cannot flood the address).
  expires_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  -- The UTC day (days since the epoch) of the last wrong guess, and the wrong guesses that day,
  -- across every code the address got: a new code does not reset them, so asking for one a
  -- minute gives a guesser no more than twenty tries a day (FAILURES_A_DAY in codes.ts).
  failed_day INTEGER NOT NULL DEFAULT 0,
  failed_today INTEGER NOT NULL DEFAULT 0
);
