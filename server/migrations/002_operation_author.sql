-- Who made each edit: the random id a browser tab picks for itself (its clientId).
-- After a dropped connection, the server uses it to tell a client "this edit of yours
-- WAS saved" instead of letting the client send it again and apply it twice.
-- NULL for edits saved before this column existed, and for clients that don't identify
-- themselves. It is never sent to other users.
ALTER TABLE operations ADD COLUMN author text;
