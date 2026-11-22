-- Text boxes MCP agents wrote before objects carried payload.author were placed at the agent
-- z-index (100000) and read back as the user's. Tag them as the agent's.
UPDATE canvas_objects
SET payload = payload || '{"author": "agent"}'::jsonb
WHERE kind = 'rich-text' AND z_index = 100000 AND NOT payload ? 'author';
