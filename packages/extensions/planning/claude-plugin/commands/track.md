---
description: Track bugs, tasks, ideas, and other work items
---

# /track Command

Create one tracker item through the project's configured storage mode.

## Usage

`/track [type] [description]`

1. Call `tracker_list_types` for the effective builtin/custom schemas, status defaults, storage mode and per-type directories. Do not infer paths by pluralizing a type name or require copies of builtin schemas in `.nimbalyst/trackers`.
2. Select the exact registered type matching the request. Respect its creatable flag, schema roles, allowed statuses and required fields. If Files mode has no directory for the type, ask the user to configure Tracker settings; do not choose another location or fall back to the database.
3. Generate one portable stable ID (letters, digits, underscore or hyphen, 4–101 characters). Call `tracker_create` once with this ID. If the call needs retrying, reuse the same ID and draft; a changed draft with that ID is a conflict, not permission to create another card.
4. In Files mode, `description` is a short YAML summary of at most 500 characters; put the full Markdown in `content`. The tool writes the Markdown card and updates the derived index. In Database mode, retain the normal tool behavior.
5. Do not also write an inline tracker or a second Markdown card after calling the tool. Existing database and legacy file cards retain their storage; enabling Files mode does not migrate them.
6. Use `tracker_update` for fields, tags and additional type tags. For new Files cards, `content` changes the body and `description` changes the summary. Comments use `tracker_add_comment`; project comments are kept in their companion file, while session links and local activity stay machine-local.
7. Session linking is opt-in (`linkSession: true` or `tracker_link_session`). Do not assume a session link makes its conversation portable in Git.
8. For updates and reads use the returned workspace-local ID, portableId, or key. A local ID belongs only to its checkout; retry creation with the original portableId, not the returned local ID. Confirm the returned ID/key and file path when present. A write conflict or unavailable file is an error to resolve, never a reason to create a replacement database card.

Prefer these same tools for later edits so schema validation, relationships and file persistence remain consistent. A Git-only agent may edit the existing card's project fields and Markdown using the documented format, preserving its ID, trackerFormat, trackerStatus and unrelated fields. Never regenerate an existing card merely to normalize formatting.
