-- Keep delete-before-insert in one trigger. SQLite does not promise the order
-- of separate AFTER UPDATE triggers: inserting first and then deleting the
-- old row can remove the new FTS docsize entry and make ranked search fail.
DROP TRIGGER IF EXISTS ai_agent_messages_au;
DROP TRIGGER IF EXISTS ai_agent_messages_au_delete;
DROP TRIGGER IF EXISTS ai_agent_messages_au_insert;
CREATE TRIGGER ai_agent_messages_au AFTER UPDATE ON ai_agent_messages
BEGIN
  INSERT INTO ai_agent_messages_fts(ai_agent_messages_fts, rowid, searchable_text)
    SELECT 'delete', old.id, old.searchable_text WHERE old.searchable_text IS NOT NULL;
  INSERT INTO ai_agent_messages_fts(rowid, searchable_text)
    SELECT new.id, new.searchable_text WHERE new.searchable_text IS NOT NULL;
END;
-- Repair the disposable lexical index left by the old trigger ordering.
-- This reads existing searchable_text; no message rewrite or embeddings.
INSERT INTO ai_agent_messages_fts(ai_agent_messages_fts) VALUES('rebuild');
