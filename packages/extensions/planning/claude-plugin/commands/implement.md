---
description: Execute a plan document with progress tracking
---

# /implement [plan-file-path]

Implement a plan and keep its checklist current as you go. A bare filename means `nimbalyst-local/plans/<name>`.

Files storage does not move or convert an existing plan document. Keep its checklist and format. If the supplied file is already a portable tracker card, use `tracker_list_types` for its effective fields/statuses and `tracker_update` for metadata or `content` changes; preserve its stable identity instead of rewriting it as a legacy plan.

## Steps

1. **Read the whole plan.** Missing file: ask for the path. No frontmatter: warn it isn't a plan. Already complete or `blocked`: ask before proceeding.

2. **Link the session.** For an existing portable card (`trackerFormat: 1`), call `tracker_get` with its YAML `id`; for an ordinary plan document use `fm:plan:<workspace-relative-path>`. Then call `tracker_link_session` with the returned id. A child-session review card may already link to the original plan: reuse the existing item and do not create a duplicate. Linking is local to this Nimbalyst profile.

3. **Checklist.** Reuse an existing `## Implementation checklist` (or legacy `## Implementation Progress`); add missing deliverables to it. Otherwise create one under the intro: one `- [ ]` per phase, sub-items for deliverables. Don't otherwise restructure the plan.

4. **Frontmatter, before any code** (even if the checklist already existed): `status: in-development`, `startDate` if unset, `updated` to now (ISO), `progress` to the checked fraction.

5. **Implement, ticking as you go.** When a phase or deliverable lands, edit the plan in the same turn, before starting the next item: tick the box, set `progress` (checked / total boxes in the checklist, rounded) and `updated`. If you're about to report a phase done without having just edited the plan, edit it first. Never batch ticks to the end. On a blocker, set `status: blocked` and note why.

6. **Finish.** Check each box against what actually shipped; leave unfinished items unchecked and say why. Then `status: in-review`, `progress: 100`. Fix failing tests, never skip them. If the project keeps a feature inventory, update it for notable capabilities added or removed, or report "No inventory impact". Don't commit unless asked.
