# Nimbalyst 0.80.6+m4xp1.2

Windows x64 fork on upstream v0.80.6. The seven changes in this revision are independently committed in features:

- Coverage uses sky blue (#38bdf8) for sessions, distinct from custom sources.
- Local database tracker CONTENT opens after reading its body, without the previous 15.5-second team lookup retry. Authentication restoration, team identity and lookup failures remain distinct; known team content is not treated as local.
- Files, In Files, Sessions (titles and messages), Prompts and Projects support Russian case/NFC/е–ё normalization and additional Snowball word forms. Exact matches retain priority within the text branch. UTF-8 ripgrep offsets are mapped to original UTF-16 highlights. Memory keeps its existing model, semantic nearest-candidate policy, RRF weights and recall behavior.
- Modified physical keys work across keyboard layouts in application commands and editors. Plain text, composition and AltGr are left native.
- File tree focus and ordinary selection follow the same current item. Explicit Ctrl/Shift multiple selection remains available.
- File-backed Wiki tracker pages use the shared file editor and write attributes to the original frontmatter; database-backed pages retain their existing storage route.
- Copy Relative Path copies a slash-separated path under the owning project root, or . for the root itself.

Windows release CI requires lexical integration tests (real ripgrep, SQLite and PGLite) and six-pane search E2E against the built Electron application. CI uses fake embeddings and no OpenAI key. Third-party Snowball 3.1.1 sources/runtime/BSD license remain shipped.

App/About: 0.80.6+m4xp1.2. Windows FileVersion: 0.80.6.2; buildNumber: 2. Tooling uses the owner's pnpm 12.11.2 and the pinned Electron 43.7.0. Older tags and releases remain available.

Only Windows x64 is released. Upstream update notifications remain available; autoDownload=false and autoInstallOnAppQuit=false. The fork installer is unsigned and upgrades are installed manually.
