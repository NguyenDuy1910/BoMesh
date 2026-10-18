-- The server owns conversation history. A retry or edit supersedes the
-- replaced user turn and every later message instead of deleting them, and
-- only active messages reach model context or conversation references.
ALTER TABLE messages ADD COLUMN status varchar(16) NOT NULL DEFAULT 'active';
ALTER TABLE messages ADD COLUMN superseded_at timestamptz;

ALTER TABLE messages
    ADD CONSTRAINT ck_messages_message_status_is_valid
    CHECK (
        (status = 'active' AND superseded_at IS NULL)
        OR (status = 'superseded' AND superseded_at IS NOT NULL)
    );

CREATE INDEX ix_messages_conversation_id_status_sequence_number
    ON messages (conversation_id, status, sequence_number);
