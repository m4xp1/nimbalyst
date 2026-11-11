---
title: Markdown editor
key: files/markdown
area: Files
kind: editor
lifecycle: existing
platform: desktop
parent: files
captureStatus: historical-staged
---

# Markdown editor

Opening a Markdown file leaves its source on disk as written. If a rich-text edit exceeds the formatting preservation budget, choose **Open Source Mode** to review the recovered draft, then **Save recovered text** to write it. Changes such as table cell edits can use whole-file Keep and Revert when the editor cannot show them inline.

Navigation: Application / Files / Markdown editor.

[Implementation entry point](../../../packages/electron/src/renderer/components/NavigationGutter/NavigationGutter.tsx). This is a discovery pointer, not proof that every visual state has been verified.

Pilot image: `editor-markdown.png`, from the existing marketing capture set. Staged data; capture time and code revision are unknown. It must be recaptured before treating it as current UX. The local pilot canvas embeds the image; no canonical screenshot is checked in with this record.

[Parent: Files](../files.md)
