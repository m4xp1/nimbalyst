---
title: Agent permissions
key: settings/permissions
area: Settings
kind: page
lifecycle: existing
platform: desktop
parent: settings
captureStatus: historical-staged
---

# Agent permissions

Navigation: Application / Settings / Agent permissions.

[Implementation entry point](../../../packages/electron/src/renderer/components/Settings/settingsRoutes.ts). This is a discovery pointer, not proof that every visual state has been verified.

Pilot image: `settings-permissions.png`, from the existing marketing capture set. Staged data; capture time and code revision are unknown. It must be recaptured before treating it as current UX. The local pilot canvas embeds the image; no canonical screenshot is checked in with this record.

## Additional Directories (Windows fork)

Additional Directories controls agent access under the selected permission mode. Claude Code retains its native settings route; Codex now reads the same effective user/project/local settings and inherits parent-project settings for worktrees. Codex combines these paths with its existing automatic directories. Adding or removing an entry takes effect on the next turn; an active turn continues.

This setting does not attach a folder to the explorer or search. Use **Attach Folder To Workspace** for that, then choose the source folder in Memory's **Additional text sources** to customize indexing. An empty Additional Directories list does not prevent reading outside the project. Entries permit writing within the active sandbox policy; there is no read-only switch. Removing one entry does not revoke a path still provided by another source.

Unreadable settings and invalid explicit directory paths stop Codex startup/resume with an error rather than widening its sandbox. This release leaves Permission Mode, Computer Use and the shared Codex configuration unchanged.

[Parent: Settings](../settings.md)
