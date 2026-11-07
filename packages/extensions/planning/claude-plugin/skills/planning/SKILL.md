---
name: planning
description: Create structured plan documents and track work items using YAML frontmatter. Use when the user wants to plan a feature, track progress, log bugs/tasks/ideas, or organize project work.
---

# Planning and Tracking System

Nimbalyst uses Markdown plan documents and tracker tools. Tracker cards use the project's configured Database or Files storage mode; ordinary plan documents retain their existing workflow.

## Plan Documents

Plans live in `nimbalyst-local/plans/` with YAML frontmatter:

```yaml
---
planStatus:
  planId: plan-[unique-identifier]
  title: [Plan Title]
  status: draft
  planType: feature
  priority: medium
  owner: [owner-name]
  stakeholders: []
  tags: []
  created: "YYYY-MM-DD"
  updated: "YYYY-MM-DDTHH:MM:SS.sssZ"
  progress: 0
---
```

### Status Values

- `draft`: Initial planning phase
- `ready-for-development`: Approved and ready to start
- `in-development`: Currently being worked on
- `in-review`: Implementation complete, pending review
- `completed`: Successfully completed
- `rejected`: Plan has been rejected
- `blocked`: Progress blocked by dependencies

### Plan Types

- `feature`: New feature development
- `bug-fix`: Bug fix or issue resolution
- `refactor`: Code refactoring/improvement
- `system-design`: Architecture/design work
- `research`: Research/investigation task
- `initiative`: Large multi-feature effort
- `improvement`: Enhancement to existing feature

## Tracking Items

Create and edit cards with the tracker tools, following [the /track workflow](../../commands/track.md).

1. Call `tracker_list_types` before creating a card. It returns the effective builtin/custom schemas, allowed statuses, storage mode and per-type folders. Use the exact registered type matching the request. Builtin types do not require copied definitions in `.nimbalyst/trackers`; that directory contains project overrides and custom types.
2. Call `tracker_create`. In Files mode generate one stable portable ID and reuse it with the same draft for retries. The tool chooses the configured folder; do not pluralize a type into a filename, create an inline duplicate, or fall back to Database when a folder is missing.
3. For a new Files card, keep `description` as a short YAML summary (at most 500 characters) and put the full Markdown in `content`. Read/update using the returned local ID, portableId or key; only the portable ID belongs in Git and in a repeated create request. A local ID is scoped to its checkout.
4. Use `tracker_update` for schema fields, status, tags, relationships and body; use `tracker_add_comment` for comments. Files-mode project fields/body are in Markdown and comments in project JSONL. Session links, activity and revisions stay local. Link sessions explicitly when requested; updating a card alone does not link the session.
5. Enabling Files mode does not migrate existing Database or legacy Markdown/inline cards. Preserve their identities and use tools to edit them. When working without Nimbalyst, edit the established file format while preserving identity and unrelated YAML; do not regenerate cards for formatting.

Decisions still need judgment: if the project has a Wiki, follow its "How we write this wiki" page. Mark the decision in the page it affects; create a decision card only when no single page owns it, work depends on it, it is unsettled, or its reasons do not fit there. Without a Wiki, a decision usually belongs in its plan document.

### Plan documents and review cards

`/design` and `/implement` continue working with their existing plan documents in `nimbalyst-local/plans/`. Files storage does not move or convert those documents. A child-session plan-review notification may reuse an existing tracker for the plan or create one review card linking to the original plan in the configured plan folder. Do not create another card merely because that notification exists; the original plan is not copied into it, and its local prompt/session metadata does not travel through Git.

## When to Use

- **Creating plans**: When user wants to plan a feature, project, or initiative
- **Tracking items**: When user mentions bugs, tasks, ideas, or wants to log something
- **Progress updates**: When completing work, update plan status and progress
- **Implementation**: Use /implement to execute a plan with progress tracking
- **Board cleanup**: Use /session-cleanup to tidy the Sessions board -- fix session phases, mark finished work complete, and flag old sessions to archive
- **Getting more from Nimbalyst**: Use /planning:nimbalyst-coach to review this project and recent sessions and suggest extensions, features, and agent-instruction changes

## File Naming

- Plans: `nimbalyst-local/plans/[descriptive-name].md` (kebab-case)
- Tracker cards: use the effective folder returned by `tracker_list_types`; the tool creates the filename and stores the stable identity.

## Best Practices

- Read effective types and storage through `tracker_list_types` before creating cards
- Keep plans focused on a single objective
- Update progress regularly as work proceeds
- Use appropriate priorities (low, medium, high, critical)
- Link related plans and tracker items
- Include stakeholders who need visibility
