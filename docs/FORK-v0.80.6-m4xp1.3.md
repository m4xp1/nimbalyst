# Nimbalyst 0.80.6+m4xp1.3

Windows x64 fork on upstream v0.80.6. Changes remain independently committed in features:

- Builtin registration preserves project tracker schemas across editor access and workspace changes.
- File-backed cards use the original Markdown for body and frontmatter writes. Agents and dependent tools read the current file; the database retains metadata, not a second body. Verified legacy copies are cleared after recovery backup when needed. Missing files and conflicting edits fail explicitly.
- Memory represents each file card as one TRACKER entity, honoring exclusions and reconciling changes without a manual Rebuild. Standalone database and published team cards retain their routes; the embedding model, semantic policy, RRF and recall are unchanged.
- Windows separators resolve to one public file-card identity while retaining existing row IDs and links.
- Coverage assigns distinct, softer category colors with matching bar and legend, including orange trackers.

Windows release CI requires search tests and built/packaged Electron search E2E with fake providers, without OpenAI credentials or calls. New permanent tests cover search only.

App/About: 0.80.6+m4xp1.3. Windows FileVersion: 0.80.6.3; buildNumber: 3. Only Windows x64 is released. Older releases and upstream update notices remain; automatic downloading and installation on quit remain disabled. The installer is unsigned and upgrades are installed manually.
