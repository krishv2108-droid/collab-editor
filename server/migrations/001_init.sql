-- One row per document. The text is stored as a SNAPSHOT: the full text as it was at
-- `snapshot_revision`. Anything newer lives in the operations table below.
CREATE TABLE documents (
  id                text PRIMARY KEY,
  snapshot_text     text        NOT NULL DEFAULT '',
  snapshot_revision integer     NOT NULL DEFAULT 0,
  -- The latest revision recorded for this document. Appending an operation moves it
  -- forward by exactly one, which is how the database rejects duplicates and gaps.
  head_revision     integer     NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT revisions_not_negative CHECK (snapshot_revision >= 0 AND head_revision >= 0),
  CONSTRAINT snapshot_not_ahead_of_head CHECK (snapshot_revision <= head_revision)
);

-- The append-only log of every accepted edit. `revision` is the revision this edit
-- PRODUCES: the edit with revision 5 turned revision 4 into revision 5.
CREATE TABLE operations (
  doc_id     text        NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  revision   integer     NOT NULL CHECK (revision >= 1),
  op         jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Two different edits can never claim the same revision of the same document.
  PRIMARY KEY (doc_id, revision)
);
