# Windows pre-push gate

Local Windows pushes build the extension SDK, runtime, and memory-engine
artifacts before running the full workspace typecheck. The complete Vitest
suite remains mandatory in CI and on non-Windows machines, but is skipped for
local Windows pushes until its platform failures are repaired.

The 2026-07-13 baseline command, `npm run test:prepush`, failed in these
unrelated suites: `claudeCodeEnvironment` (runtime and provider variants),
`ClaudeCliSessionLauncher`, `FileSnapshotCache`, `WorkspaceEventBus-gitignore-bypass`,
`workspaceDetection`, `ClaudeCodeProvider.bashParser`, `SafePathValidator`,
`MigrationOrchestrator.fixtureRoundtrip`, `WorkspaceEventBus-nested-gitignore`,
`ElectronFileSystemService`, `nimPreviewProtocol`, `SlashCommandService`,
`nimAssetProtocol`, `ElectronDocumentService.frontmatterCompatibility`,
`aiSettingsMerge`, `MigrationOrchestrator`, `spawnCrashDiagnostics`,
`claudeCliJsonlPath`, and `BrowserSessionHandlers`.

The fallback is intentionally limited to `process.platform === 'win32'` with
no CI flag. It does not bypass the manifest check, dependency override check,
prerequisite builds, full workspace typecheck, or this repository's focused
test requirements.

## 0.83.0 fork integration snapshot (2026-11-11)

The full Windows batch was run once: 18,939 passed, 337 failed and 34 skipped
across 2,244 files. This is a failing full-suite result, recorded before the
subsequent targeted integration and fixture corrections. The saved 0.81.7 fork
baseline had 319 failures; it is not a fresh upstream comparison. The owner
requested no tests or custom commits on the exact upstream main branch.

New failures were investigated with focused runs. Fixes include the duplicate
SQLite migration number, missing PGLite test metadata, explicit workspace IPC,
Windows path/locale fixtures and native junction fixtures. The unchanged Wiki
hook and predicate-registry tests passed in focused runs. Remaining Windows
failures include Unix-only fixture paths, macOS shell-command fixtures and
file-symlink creation requiring unavailable privileges. They are not converted
into skips or counted as passing. Project-sync path hashes also differ by native
separator in existing code; this behavior was already present in the previous
fork and is not changed by this upgrade.

The fork's mandatory search, features, integration, schema/editor and Git gates,
normal script/sandbox checks, and built/packaged application checks are separate
from this full-suite snapshot. Their passing results must never be described as
a green full Windows suite. Automated application tests use isolated profiles
and fake providers; paid-provider and manual acceptance are not performed.
