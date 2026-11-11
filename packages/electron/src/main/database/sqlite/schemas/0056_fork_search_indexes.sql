-- Converge both deployed version-53 ledgers without renumbering history.
-- .12 already applied the FTS trigger repair as53; upstream used53 for index hygiene.
-- Every DDL statement is idempotent. No transcript rows are rewritten and no
-- unbounded FTS rebuild runs on the startup critical path. A previously corrupt
-- upstream FTS index needs a separately verified database repair, not Memory Rebuild.

-- ----------------------------------------------------------------------------
-- 0053_index_hygiene
--
-- One index added, seven dropped. No row is rewritten or removed.
--
-- Added: idx_ai_agent_messages_latest_assistant_text serves the tray snippet
-- query (tray/sessionSnippets.ts latestAssistantTextSql), which reads MAX(id)
-- per session over assistant rows with text. With only (session_id, id) or the
-- user-prompts index to choose from, SQLite walked every tool row of each
-- session (or every assistant row in the database) through the table; it ran on
-- every session state change while the island was open. The partial predicate
-- repeats the query's three filters, so the index is covering and holds only
-- the rows the query can return.
--
-- Dropped, each a leading prefix of a surviving index on the same table (so
-- every reader can seek the longer one), or with no reader:
--   idx_session_files_session      prefix of idx_session_files_unique
--   idx_session_files_workspace    prefix of idx_session_files_workspace_file
--   idx_session_files_type         no query filters on link_type alone; without
--                                  stats the planner chose it for the
--                                  per-session edited lookup and walked every
--                                  edited row in the database
--   idx_queued_prompts_session     prefix of idx_queued_prompts_session_status
--   idx_tracker_workspace          prefix of idx_tracker_workspace_sync_id and
--                                  idx_tracker_kanban_sort
--   idx_ai_sessions_created_by     the partial idx_ai_sessions_created_by_workspace
--                                  serves every `created_by_session_id = ?`
--                                  (equality implies IS NOT NULL)
--   idx_history_file_content_hash  no query filters on baseMarkdownHash; the
--                                  dedupe compares it in JS after a
--                                  file_path/timestamp lookup
--
-- Plans are pinned in __tests__/indexHygienePlans.test.ts.
--
-- PGLite mirror: worker.js, "Mirror of SQLite migration 0053". It runs on every
-- launch, which is safe because every statement is IF [NOT] EXISTS.
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_latest_assistant_text
  ON ai_agent_messages(session_id, id DESC)
  WHERE message_kind = 'assistant'
    AND searchable_text IS NOT NULL
    AND searchable_text <> '';

DROP INDEX IF EXISTS idx_session_files_session;
DROP INDEX IF EXISTS idx_session_files_workspace;
DROP INDEX IF EXISTS idx_session_files_type;
DROP INDEX IF EXISTS idx_queued_prompts_session;
DROP INDEX IF EXISTS idx_tracker_workspace;
DROP INDEX IF EXISTS idx_ai_sessions_created_by;
DROP INDEX IF EXISTS idx_history_file_content_hash;

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
