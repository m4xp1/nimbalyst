# Files tracker mode

The Windows fork can store new tracker cards as project Markdown files. In **Project settings → Trackers → Card storage**, select **Markdown files**, set a relative folder for each type you use, and save. UI actions and the agent's tracker tools use the same storage choice. A type without a configured folder cannot create a new file card.

The setting applies to new cards only. Existing database cards and existing Markdown cards keep their original storage and format; enabling Files mode does not migrate or rewrite them. Switching back to Application database changes future creation only. Changing a type's folder does not move its existing cards.

## Project configuration

Settings write the compact `.nimbalyst/tracker-storage.yaml` file:

```yaml
version: 1
mode: files
directories:
  task: docs/work/tasks
  bug: docs/work/bugs
  plan: docs/work/plans
```

All ten built-in types use this storage route: `bug`, `capture`, `citation`, `decision`, `idea`, `milestone`, `plan`, `release`, `source`, and `task`. Their own field definitions and workflows still apply. For example, fields supported by a release differ from those of a task. Files mode does not copy the built-in schemas into `.nimbalyst/trackers/`. Keep only actual project overrides or custom types there. An explicit `creatable: false` override still prohibits creation; Files mode does not silently remove it.

Additional Type tags contribute their schema fields to the card. When two types declare the same field name, the primary type wins. File persistence, tool validation and inverse relationship fields use this same combined schema, including workspace overrides; changing Type tags does not change the primary type.

Directories must use portable paths relative to the current project, with `/` separators. Absolute paths, `..`, `.git` components, symlink escapes and special-file destinations are rejected. Files are named `<stable-id>.md`. Their source path comes from settings at creation; afterwards the card's current source remains its edit target.

In a Git repository, saving Files mode appends a narrow managed `.gitignore` block for the storage configuration, tracker YAML definitions and comments JSONL. It verifies these paths are not still ignored by other rules. It neither stages nor commits files. Include the configured card folders and any linked project assets in your normal Git commits as well. A non-Git project can use Files mode, but copying/sharing its files is the user's responsibility.

## What travels with the repository

| Data | Storage |
| --- | --- |
| Format version, stable ID, primary type, creation retry identity | Card YAML: `trackerFormat`, `id`, `trackerStatus.type`, `creationHash` |
| Title, short description, status, priority, owner, tags, type tags, issue key, schema-defined fields | The same YAML header |
| Created/updated timestamps, authorship, archive state, project relationships and supported external references | The same YAML header |
| Full card description/content, tables, code and links | Markdown body |
| Comments, including author, timestamps and edit/deletion state | `.nimbalyst/tracker-comments/<stable-id>.jsonl`, one comment object per line |
| Type folders and the new-card storage choice | `.nimbalyst/tracker-storage.yaml` |
| Actual custom type definitions or built-in deltas | `.nimbalyst/trackers/` |

There is one YAML header per card; fields are not split among sidecars. It is bounded to 16 KiB of UTF-8. `description` is a short summary of at most 500 Unicode characters; put detailed work, acceptance criteria and discussion context in the body. Reading the file preserves date strings rather than converting date-only values into timestamps. New cards receive precise created/updated timestamps, and an actual card edit updates `updated`.

`creationHash` is an internal retry check, not an editable project field. Preserve it, `id`, `trackerFormat` and `trackerStatus.type` when editing through GitHub or another editor. Do not copy the same ID into another card. Invalid YAML, invalid dates, duplicate IDs or unsupported format versions require repair rather than silent conversion.

Comments are project data, but activity history and revision snapshots are local application history. Session links, running-agent associations, saved board positions, personal views, favorites, unread state and other local preferences remain in the application database. Session contents are not copied by sharing a card. The database also holds rebuildable metadata and relationship projections; the Markdown body is read from its source.

## Tools, retries and links

In Files mode, `tracker_create` requires a stable `id`. Generate it once, then reuse the same ID and draft if a response is lost or creation is retried. An identical retry returns the existing card. Reusing that ID for a different draft fails instead of creating another card. Update an existing card with `tracker_update` and use the ID returned by read/list/create; tool results also expose its portable file ID.

The current workspace resolves portable IDs, issue keys and references. Two local worktrees may contain the same committed portable IDs; their database projections use different workspace-local IDs so updating one checkout cannot update the other's card. Schema-defined relationship fields serialize portable IDs for file-card targets. Prose can use normal relative Markdown links; supported `nimbalyst://` tracker references resolve within the active workspace. A link to a database-only card does not make that target portable. Changing a card's primary type is not supported through `tracker_update`; type tags remain a separate field.

Updates save the file before updating the local projection. Concurrent edits are checked against the version read by the application. A failed write is reported, with no database-only replacement of the intended project change. Comments use their own JSONL write; update comments separately from card fields/content. External comment changes use the shared workspace watcher and update the local projection without rewriting the card body.

## Restoring on another computer

Commit the Markdown cards, storage configuration, needed type overrides and comments JSONL, plus any assets referenced by the cards. Open that checkout as a project in a fork version that supports `trackerFormat: 1`. Its file discovery reconstructs the tracker projection and project relationships. **Resync from files** in the type settings reloads type definitions; it is not a command to migrate database cards.

Local sessions, application history, personal UI state and database-only relationship targets are not restored from these files. Files mode does not enable team-room synchronization or turn the cards into hosted pages; publication is rejected to preserve their file storage. Git is the transport and version history for project files. Existing database/team cards retain their existing routes.

Built-in Rename Project and Move Project currently refuse projects containing indexed Files cards before changing any files or settings. Their workspace-local IDs also appear in local session links, history and personal page state, which the existing project move does not migrate together. You may close the project, move or clone its repository yourself, and open the new path to restore card files and comments. This does not transfer local session links or UI state. Native and legacy-file projects retain their existing Rename/Move behavior.

Automated coverage includes service creation/edit/archive/restore for all ten built-ins, stable-ID retries, both database backends for workspace-isolated projections, relationship resolution, comment observation and disposal. These checks use synthetic projects. They do not establish that every combination of a custom schema and UI field has been exercised. Built/packaged application acceptance belongs to the release checks.
