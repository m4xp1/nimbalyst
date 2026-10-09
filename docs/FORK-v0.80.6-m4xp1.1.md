# Nimbalyst 0.80.6+m4xp1.1

Windows x64 fork based on upstream v0.80.6 (749eca9a4014871d649e66d70ec49487735562aa).

The upstream main branch and features are merged without squash. This update retains the fork's editable file-backed tracker CONTENT without duplicate headers, folder navigation in the document path, root context menu in the file tree, and reveal-file behavior from the document name.

Memory retains UTF-8 additional text sources and autosaved include/exclude settings, Unicode keyword retrieval, Russian Snowball 3.1.1 exact-first keyword expansion, accurate saved-index status and session indexing reconciliation. Semantic matching follows the upstream nearest-candidate/RRF policy.

App/About version: 0.80.6+m4xp1.1. Windows FileVersion: 0.80.6.1; buildNumber: 1. The fork revision restarts at 1 for the new upstream base. Older releases remain available.

The release uses the upstream pnpm 12.9.1 lockfile/toolchain and Electron 43.7.0. Only Windows x64 is built. Upstream update notifications are retained; automatic download and installation on exit are disabled. The installer is unsigned; install fork upgrades manually.
