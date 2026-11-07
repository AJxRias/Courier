-- Demo bots are ordinary users flagged so the UI can label them and humans
-- can't sign in as them.
ALTER TABLE users ADD COLUMN is_bot boolean NOT NULL DEFAULT false;
