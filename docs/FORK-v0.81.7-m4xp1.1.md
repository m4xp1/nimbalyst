# Nimbalyst 0.81.7+m4xp1.1

Windows x64 fork based strictly on upstream tag v0.81.7 (a4ac2e3377c74360c94395db5c357d4fe8d4786c). Main is updated separately to upstream/main e2e0186ca; its five post-tag commits are not part of this release.

Upstream release: https://github.com/nimbalyst/nimbalyst/releases/tag/v0.81.7

All prior features commits remain in history without squash. The fork retains Russian Quick Open and Local Wiki search; Markdown as the source for file-backed tracker bodies; one file-tracker entity in Memory; current normalized session indexing and paginated memory_read_session; tool-selection guidance; distinct Coverage colors; Wiki opt-in with tool/navigation disablement; and Git on Stable with Marketplace precedence. Upstream editor, CSV, session, worktree, nested-repository and Git status improvements are included.

Wiki remains off by default in this fork; explicit enablement/disablement and existing data are preserved. Upstream enables Wiki by default, so the manifest and skill fallback are kept aligned with fork policy. Git builtin is now upstream 1.0.3; user-installed Git still takes precedence. Other channel/permission policies remain as before.

## Merge conflicts

Nine files conflicted: CHANGELOG.md (both release histories retained); FEATURE_INVENTORY.md (new upstream capabilities plus fork Wiki opt-in); CLI MCP tests (Russian search and all new upstream tests); generated TrackerFilterOmnibox declaration (both parameter sets); PagesSearchView (atomic state update plus inline pills); Electron package version; TabEditor (Page info plus embedded header handling); fileTree atoms (active repository plus normalized selection); Memory engine dependencies (upstream MCP SDK plus shared search-text).

The inline-filter test locators follow upstream’s new pills. One new upstream CLI test compares canonical Windows directories instead of slash spelling. No Git operations or model/RRF/recall policy were replaced during conflict resolution.

About 0.81.7+m4xp1.1; Windows FileVersion 0.81.7.1; buildNumber 1. Release packaging and complete dependency validation run in GitHub CI. EXE packaging remains in CI. The owner later authorized local dependency installation; see the verification report for actual environment attempts, checks and limitations.
