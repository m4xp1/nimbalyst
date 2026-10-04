package com.nimbalyst.app.documents

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class DocumentEditorBridgeTest {
    @Test
    fun theEditorWebViewCannotReachFilesOrContentProviders() {
        val settings = createDocumentEditorWebView(ApplicationProvider.getApplicationContext(), EditorBridgeRelay()) {}.settings
        assertFalse(settings.allowFileAccess)
        assertFalse(settings.allowContentAccess)
        @Suppress("DEPRECATION")
        assertFalse(settings.allowFileAccessFromFileURLs)
        @Suppress("DEPRECATION")
        assertFalse(settings.allowUniversalAccessFromFileURLs)
    }

    @Test
    fun anOlderSaveCompletingDoesNotMarkNewerTypingClean() {
        val tracker = EditorSaveTracker()
        tracker.onEdit()
        val saveA = tracker.beginSave()
        tracker.onEdit() // the user types B while A is in flight
        tracker.onSaved(saveA)
        assertTrue("B is still unsaved", tracker.dirty)

        val saveB = tracker.beginSave()
        tracker.onSaved(saveB)
        tracker.onSaved(saveA) // a late completion never moves backwards
        assertFalse(tracker.dirty)
    }

    @Test
    fun onlyTheBundledEditorLoadsInTheWebView() {
        assertEquals(EditorLinkAction.ALLOW_IN_WEBVIEW, DocumentEditorLinks.classify(DocumentEditorLinks.EDITOR_URL))
        assertEquals(EditorLinkAction.ALLOW_IN_WEBVIEW, DocumentEditorLinks.classify("file:///android_asset/editor-dist/assets/editor.js"))
        for (blocked in listOf(
            "file:///android_asset/editor-dist/../transcript-dist/transcript.html",
            "file:///android_asset/editor-dist/%2e%2e/x",
            "file:///data/data/com.nimbalyst.app/databases/documents.db",
            "file://host/android_asset/editor-dist/editor.html",
            "content://com.example/file",
            "javascript:alert(1)",
            "intent://x#Intent;end",
            null,
        )) {
            assertEquals(blocked, EditorLinkAction.BLOCK, DocumentEditorLinks.classify(blocked))
        }
        assertEquals(EditorLinkAction.OPEN_EXTERNALLY, DocumentEditorLinks.classify("https://example.com"))
        assertEquals(EditorLinkAction.OPEN_EXTERNALLY, DocumentEditorLinks.classify("mailto:a@b.c"))
    }

    @Test
    fun bridgeMessagesParseAndBenignErrorsAreDropped() {
        assertEquals(EditorBridgeMessage.EditorReady, EditorBridgeMessage.parse("""{"type":"editorReady"}"""))
        assertEquals(EditorBridgeMessage.ContentChanged("# Hi"), EditorBridgeMessage.parse("""{"type":"contentChanged","content":"# Hi"}"""))
        assertEquals(EditorBridgeMessage.Dirty(true), EditorBridgeMessage.parse("""{"type":"dirty","isDirty":true}"""))
        assertEquals(EditorBridgeMessage.Error("boom"), EditorBridgeMessage.parse("""{"type":"error","message":"boom"}"""))
        assertNull(EditorBridgeMessage.parse("""{"type":"error","message":"window.onerror: ResizeObserver loop completed with undelivered notifications."}"""))
        assertNull(EditorBridgeMessage.parse("""{"type":"contentChanged"}"""))
        assertNull(EditorBridgeMessage.parse("not json"))
    }

    @Test
    fun markdownIsPassedToJavascriptAsAStringLiteral() {
        val markdown = "a \"quote\" \\ back\nline </script>  "
        val js = EditorCommands.loadMarkdown(markdown)
        val literal = js.substringAfter("loadMarkdown(").removeSuffix(")")
        assertEquals(markdown, EditorCommands.decodeContent(literal))
        assertEquals(false, "</script>" in js)
        assertNull(EditorCommands.decodeContent("null"))
    }

    @Test
    fun openFilePathsResolveOnlyInsideTheProject() {
        assertEquals("docs/a.md", relativePathInProject("/Users/me/ws", "/Users/me/ws/docs/a.md"))
        assertEquals("docs/a.md", relativePathInProject("/Users/me/ws/", "/Users/me/ws/docs/a.md"))
        assertNull(relativePathInProject("/Users/me/ws", "/Users/me/ws-other/a.md"))
        assertNull(relativePathInProject("/Users/me/ws", "/Users/me/ws/"))
    }
}
