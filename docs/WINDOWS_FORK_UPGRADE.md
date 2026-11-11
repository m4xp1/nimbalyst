# Windows fork: upgrading to 0.83.0+m4xp1.1

The upstream runtime base is tag `v0.83.0` (`980bb9d1c7641bfab5e9b1d44bab9c76da9b1a20`). The merged upstream main snapshot is `28492d00f7d00378fa93dd7c3c9846934c286646`; its only change beyond the tag is `PUBLIC_RELEASE_NOTES.md`. Fork main remains exactly that upstream snapshot. Customizations and Windows portability fixes belong to features and release.

This update includes upstream 0.82.x and 0.83.0 features. The fork retains Files tracker storage, Additional Directories, attached search roots, Russian matching, source-scoped Memory, unavailable-index retention, credential isolation and explicit update downloads. The model and embedding input used by Memory are unchanged by this merge. Automated release tests use artificial projects and fake providers; they do not use the working profile or paid OpenAI credentials.

## Database and history changes inherited from upstream

Upstream now automatically converts eligible PGLite stores up to 1 GiB to SQLite at startup. Larger stores require the existing consent flow. The migration uses the cutover journal and preserves the prior store as a recovery artifact. This is a database transition, not just a replacement of the application binary. Both backends remain supported.

Background storage maintenance can discard eligible tool-result payloads older than 30 days while retaining the tool card and result status. User prompts, assistant text, tool calls/arguments, question answers and active sessions are protected by the existing retention rules. Tracker body cache maintenance retains the original, latest and current referenced body versions rather than every intermediate copy. Binary document snapshots are omitted from document history. Repository files remain the source of truth for portable tracker cards; application-local caches and history do not replace them.

The previous fork and upstream both used SQLite migration number 53 for different changes. Migration 56 converges their indexes and installs the atomic delete-before-insert FTS update trigger without renaming applied ledger entries or rebuilding all transcript indexes at startup. A transcript FTS index already damaged by the former upstream trigger is not automatically repaired; repair requires a separately verified database-maintenance procedure. Memory Rebuild does not repair transcript FTS. This limitation does not describe Memory embeddings, which use a separate index.

## Codex and usage

SDK and bundled native Codex are pinned to stable 0.167.0. The app-server and legacy SDK offline contracts are tested with an artificial home and a localhost fake model. Passing the policy contract is not proof of Windows sandbox enforcement.

Weekly usage history is stored under a hash of the native account/workspace identity. Switching accounts changes the history scope. Replies from a superseded account cannot update current counters or history. Historical samples without a verified identity are not assigned to a newly signed-in account. API and subscription providers remain separate.

## Files, search and updates

File content search retains upstream streaming and per-file result bounds together with Russian matching, UTF-16 highlights and attached-root ownership. Canonical paths and match spans are cached within a search invocation. Mixed review decisions preserve the untouched source layout while keeping generation and concurrent-write guards.

Upstream release discovery and notifications remain enabled. Automatic installer downloading and installation on quit are disabled. Download and install require an explicit user action. This update does not install or restart an already running working application.
