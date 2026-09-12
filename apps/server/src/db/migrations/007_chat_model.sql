-- Adds owner-selected model and reasoning settings to each chat conversation.
ALTER TABLE chat_conversations
  ADD COLUMN model text NOT NULL DEFAULT 'gpt-5.6-terra'
    CHECK (model IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra')),
  ADD COLUMN reasoning text NOT NULL DEFAULT 'medium'
    CHECK (reasoning IN ('low', 'medium', 'high', 'xhigh', 'max'));
