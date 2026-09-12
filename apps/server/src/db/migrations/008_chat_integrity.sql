-- Keep every chat message tied to a conversation owned by the same user.
-- Old application writes were scoped correctly; discard any hidden mismatches
-- before enforcing that invariant at the database boundary.
DELETE FROM chat_messages AS message
USING chat_conversations AS conversation
WHERE message.conversation_id = conversation.id
  AND message.owner_id <> conversation.owner_id;

ALTER TABLE chat_conversations
  ADD CONSTRAINT chat_conversations_id_owner_unique UNIQUE (id, owner_id);

ALTER TABLE chat_messages
  DROP CONSTRAINT chat_messages_conversation_id_fkey,
  ADD CONSTRAINT chat_messages_conversation_owner_fkey
    FOREIGN KEY (conversation_id, owner_id)
    REFERENCES chat_conversations(id, owner_id)
    ON DELETE CASCADE;
