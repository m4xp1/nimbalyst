package com.nimbalyst.app.documents

import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.Save
import androidx.compose.material.icons.outlined.TextFormat
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nimbalyst.app.R
import com.nimbalyst.app.ui.theme.NimbalystColors
import kotlinx.coroutines.launch

private sealed interface EditorLoad {
    data object Loading : EditorLoad
    data class Loaded(val markdown: String, val syncId: String) : EditorLoad
    data object Missing : EditorLoad
    data object DecryptFailed : EditorLoad
    data class SyncFailed(val message: String) : EditorLoad
}

/**
 * Which edits a save covers. A save captures the edit revision its content
 * reflects; the editor is clean only once a completed save covers the latest
 * revision, so save A finishing while the user types B leaves B dirty.
 */
internal class EditorSaveTracker {
    private var editRevision = 0L
    private var savedRevision = 0L

    val dirty: Boolean get() = editRevision > savedRevision

    fun onEdit() {
        editRevision++
    }

    /** Call when the content to save is read; pass the result to [onSaved]. */
    fun beginSave(): Long = editRevision

    fun onSaved(revision: Long) {
        if (revision > savedRevision) savedRevision = revision
    }
}

/**
 * Edits one synced markdown file in the bundled Lexical editor, mirroring iOS
 * `DocumentEditorView`. Each user edit is saved about half a second after
 * typing stops (the bundle debounces), and Save flushes immediately. A save
 * pushes the whole encrypted file; the server keeps the last write. Offline
 * saves are queued and sent when the project's room reconnects.
 *
 * The editor holds its project's room itself: after process restore it can be
 * the first screen, with no file list to have connected the room.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DocumentEditorScreen(
    projectId: String,
    relativePath: String,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
) {
    val context = LocalContext.current
    val manager = remember { Documents.manager(context) }
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val relay = remember { EditorBridgeRelay() }

    var load by remember(projectId, relativePath) { mutableStateOf<EditorLoad>(EditorLoad.Loading) }
    var webView by remember { mutableStateOf<WebView?>(null) }
    var editorReady by remember { mutableStateOf(false) }
    var contentPushed by remember { mutableStateOf(false) }
    val tracker = remember(projectId, relativePath) { EditorSaveTracker() }
    var dirty by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var formatMenuOpen by remember { mutableStateOf(false) }
    val queued by remember(projectId) { manager.observeOutboxCount(projectId) }.collectAsStateWithLifecycle(0)
    val states by manager.states.collectAsStateWithLifecycle()
    val failures by manager.saveFailures.collectAsStateWithLifecycle()

    fun save(markdown: String) {
        val revision = tracker.beginSave()
        scope.launch {
            when (val outcome = manager.saveDocument(projectId, relativePath, markdown)) {
                SaveOutcome.Sent, SaveOutcome.Queued -> tracker.onSaved(revision)
                is SaveOutcome.Failed -> errorMessage = outcome.message
            }
            dirty = tracker.dirty
        }
    }

    /**
     * Reads the editor's current markdown and hands it to the manager, which
     * keeps it until it is on disk and reports a failure in `saveFailures`.
     * Nothing is marked clean when the editor could not be read.
     */
    fun flush(view: WebView, then: () -> Unit = {}) {
        if (!tracker.dirty) return then()
        view.evaluateJavascript(EditorCommands.GET_CONTENT) { result ->
            EditorCommands.decodeContent(result)?.let { markdown ->
                val revision = tracker.beginSave()
                manager.saveInBackground(projectId, relativePath, markdown)
                tracker.onSaved(revision)
            }
            dirty = tracker.dirty
            then()
        }
    }

    DisposableEffect(projectId) {
        val lease = manager.acquireProject(projectId)
        onDispose { lease.release() }
    }

    // Observed rather than looked up once: on a cold start the account, key,
    // and project transfer may all still be on their way.
    LaunchedEffect(projectId, relativePath) {
        manager.observeAvailability(projectId, relativePath).collect { availability ->
            if (load is EditorLoad.Loaded) return@collect
            load = when (availability) {
                DocumentAvailability.Waiting -> EditorLoad.Loading
                DocumentAvailability.Missing -> EditorLoad.Missing
                is DocumentAvailability.Failed -> EditorLoad.SyncFailed(availability.message)
                is DocumentAvailability.Available -> manager.documentContent(projectId, relativePath)
                    ?.let { EditorLoad.Loaded(it, availability.document.syncId) }
                    ?: EditorLoad.DecryptFailed
            }
        }
    }

    LaunchedEffect(editorReady, load, webView) {
        val loaded = load as? EditorLoad.Loaded ?: return@LaunchedEffect
        val view = webView ?: return@LaunchedEffect
        if (editorReady && !contentPushed) {
            contentPushed = true
            view.evaluateJavascript(EditorCommands.loadMarkdown(loaded.markdown), null)
        }
    }

    // Another device's save replaces the content unless there are local edits
    // in flight; those win on the next save (last write wins).
    LaunchedEffect(load) {
        val syncId = (load as? EditorLoad.Loaded)?.syncId ?: return@LaunchedEffect
        manager.remoteUpdates.collect { update ->
            if (update.projectId == projectId && update.syncId == syncId && !dirty && contentPushed) {
                webView?.evaluateJavascript(EditorCommands.loadMarkdown(update.markdown), null)
            }
        }
    }

    DisposableEffect(relay) {
        relay.handler = { message ->
            when (message) {
                EditorBridgeMessage.EditorReady -> editorReady = true
                is EditorBridgeMessage.Dirty -> if (message.isDirty) {
                    tracker.onEdit()
                    dirty = tracker.dirty
                }
                is EditorBridgeMessage.ContentChanged -> save(message.content)
                is EditorBridgeMessage.Error -> errorMessage = message.message
            }
        }
        onDispose { relay.handler = null }
    }

    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) webView?.let { flush(it) }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    Scaffold(
        modifier = modifier,
        containerColor = NimbalystColors.backgroundSecondary,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = NimbalystColors.background),
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.document_editor_back))
                        }
                    }
                },
                title = {
                    Text(relativePath.substringAfterLast('/'), maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 17.sp)
                },
                actions = {
                    if (dirty) {
                        Box(
                            modifier = Modifier
                                .padding(horizontal = 8.dp)
                                .size(8.dp)
                                .background(NimbalystColors.primary, CircleShape)
                        )
                    }
                    val editable = load is EditorLoad.Loaded && editorReady
                    Box {
                        IconButton(onClick = { formatMenuOpen = true }, enabled = editable) {
                            Icon(Icons.Outlined.TextFormat, contentDescription = stringResource(R.string.document_editor_format))
                        }
                        DropdownMenu(expanded = formatMenuOpen, onDismissRequest = { formatMenuOpen = false }) {
                            listOf(
                                EditorFormat.BOLD to R.string.document_editor_bold,
                                EditorFormat.ITALIC to R.string.document_editor_italic,
                                EditorFormat.CODE to R.string.document_editor_code,
                                EditorFormat.STRIKETHROUGH to R.string.document_editor_strikethrough,
                            ).forEach { (format, label) ->
                                DropdownMenuItem(
                                    text = { Text(stringResource(label)) },
                                    onClick = {
                                        formatMenuOpen = false
                                        webView?.evaluateJavascript(EditorCommands.formatText(format), null)
                                    },
                                )
                            }
                        }
                    }
                    IconButton(
                        onClick = {
                            webView?.evaluateJavascript(EditorCommands.GET_CONTENT) { result ->
                                EditorCommands.decodeContent(result)?.let(::save)
                            }
                        },
                        enabled = editable,
                    ) {
                        Icon(Icons.Outlined.Save, contentDescription = stringResource(R.string.document_editor_save))
                    }
                },
            )
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding).imePadding()) {
            when (val current = load) {
                EditorLoad.Missing -> Notice(stringResource(R.string.document_editor_missing))
                EditorLoad.DecryptFailed -> Notice(stringResource(R.string.document_editor_decrypt_failed))
                is EditorLoad.SyncFailed -> Column(
                    modifier = Modifier.fillMaxSize().padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
                ) {
                    Text(current.message, color = NimbalystColors.textMuted, textAlign = TextAlign.Center)
                    TextButton(onClick = { manager.retryProject(projectId) }) { Text(stringResource(R.string.documents_retry)) }
                }
                EditorLoad.Loading, is EditorLoad.Loaded -> {
                    Column(modifier = Modifier.fillMaxSize()) {
                        SaveFailureBanner(
                            failures = failures.filter { it.projectId == projectId && it.relativePath == relativePath },
                            onRetry = manager::retrySave,
                            onDiscard = manager::discardUnsaved,
                        )
                        // Pushes wait in the outbox until the server confirms them; only
                        // a room that is not ready means they are actually stuck here.
                        if (queued > 0 && states[projectId] != DocumentSyncState.Ready) {
                            Text(
                                stringResource(R.string.document_editor_queued),
                                fontSize = 12.sp,
                                color = NimbalystColors.textMuted,
                                modifier = Modifier.fillMaxWidth().background(NimbalystColors.background).padding(horizontal = 16.dp, vertical = 6.dp),
                            )
                        }
                        AndroidView(
                            modifier = Modifier.fillMaxSize(),
                            factory = { viewContext ->
                                createDocumentEditorWebView(viewContext, relay) { errorMessage = it }.also { webView = it }
                            },
                            onRelease = { view ->
                                // Save anything typed in the last half second, then free the renderer.
                                flush(view) { view.destroy() }
                                if (webView === view) webView = null
                            },
                        )
                    }
                    if (current == EditorLoad.Loading || !editorReady) {
                        Column(
                            modifier = Modifier.fillMaxSize().background(NimbalystColors.backgroundSecondary),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.Center,
                        ) {
                            CircularProgressIndicator(color = NimbalystColors.primary)
                            Text(
                                stringResource(R.string.document_editor_loading),
                                color = NimbalystColors.textMuted,
                                modifier = Modifier.padding(top = 12.dp),
                            )
                        }
                    }
                }
            }
            errorMessage?.let { message ->
                val title = stringResource(R.string.document_editor_error_title)
                EditorErrorCard(
                    message = message,
                    onCopy = { clipboard.setText(AnnotatedString("$title\nDocument: $relativePath\n\n$message")) },
                    onDismiss = { errorMessage = null },
                    modifier = Modifier.align(Alignment.BottomCenter),
                )
            }
        }
    }
}

@Composable
private fun Notice(text: String) {
    Box(modifier = Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Text(text, color = NimbalystColors.textMuted, textAlign = TextAlign.Center)
    }
}

@Composable
private fun EditorErrorCard(message: String, onCopy: () -> Unit, onDismiss: () -> Unit, modifier: Modifier) {
    val shape = RoundedCornerShape(16.dp)
    Column(
        modifier = modifier
            .padding(16.dp)
            .widthIn(max = 420.dp)
            .background(NimbalystColors.background, shape)
            .border(1.dp, NimbalystColors.border, shape)
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Icons.Filled.Warning, contentDescription = null, tint = NimbalystColors.warning)
        Text(stringResource(R.string.document_editor_error_title), color = NimbalystColors.text, fontSize = 16.sp)
        Text(message, color = NimbalystColors.textMuted, fontSize = 12.sp, textAlign = TextAlign.Center)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TextButton(onClick = onCopy) { Text(stringResource(R.string.document_editor_copy)) }
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.document_editor_dismiss)) }
        }
    }
}
