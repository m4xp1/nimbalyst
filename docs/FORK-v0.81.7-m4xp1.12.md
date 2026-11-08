# Windows fork 0.81.7+m4xp1.12

This release fixes Codex model discovery and account-bound usage reporting. Direct OpenAI API models have explicit API labels in the menu and selected-model chip. Codex and API provider IDs and credentials remain separate; choosing a transport does not select billing. An explicit API-key login in Codex remains API usage.

Codex and its SDK are pinned to 0.167.0-alpha.3.2. The offline native gate uses an artificial home, loopback model responses and a synthetic tool to check the real binary's catalog/skills, tool round-trip, continuation, cancellation and legacy SDK. It does not use a personal login or prove operating-system sandbox enforcement.

Quota refresh reads the current native managed session/user/workspace through a short-lived reader, independently of the persistent login/sandbox and agent processes. The next existing refresh detects an external personal/workspace switch without restarting Nimbalyst or forcing login/token refresh. Overlapping reads are coalesced; old-generation and startup IPC replies cannot overwrite newer state. Unattributed historical session percentages are no longer used as an error fallback. No additional polling loop or Memory embedding calls are introduced.

Validation is automated: mandatory search, feature and Git/schema gates; all-workspace typecheck; real-native offline contract; built and packaged Electron scenarios, including usage on SQLite and PGLite. Real account switching, real model inference and manual acceptance are not part of this release acceptance. Existing nonportable Windows full-suite failures are recorded separately in WINDOWS_PREPUSH_GATE.md; focused success is not a green full-suite claim.

About 0.81.7+m4xp1.12; Windows FileVersion 0.81.7.12; buildNumber 12. Windows x64 EXE is packaged in GitHub CI and its public download must match the published checksum and GitHub digest. Previous releases, upstream notifications and disabled automatic download/install remain unchanged. No inventory impact: corrections to existing catalogs and usage indicators.
