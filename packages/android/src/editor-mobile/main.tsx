/**
 * Mobile Lexical Editor for the Android WebView.
 *
 * Forked from packages/ios/src/editor-mobile/main.tsx. The bridge API is the
 * same; only the transport and change reporting differ.
 *
 * Bridge API:
 *   JS -> Android: window.AndroidEditorBridge.postMessage(JSON.stringify({ type, ... }))
 *     - editorReady: editor mounted and ready
 *     - dirty: { isDirty: true } on every user edit, before the debounced change
 *     - contentChanged: markdown after a user edit (debounced 500ms)
 *     - error: JS error occurred
 *
 *   Android -> JS: window.nimbalystEditor.*
 *     - loadMarkdown(content: string): load markdown into editor
 *     - setReadOnly(readonly: boolean): toggle read-only mode
 *     - getContent(): string: get current markdown content
 *     - formatText(format: string): apply text format (bold, italic, underline, strikethrough, code)
 *
 * Only user edits are reported. Content set by loadMarkdown (the initial load
 * or a remote update) becomes the new baseline, so opening a file or receiving
 * another device's save never echoes a save back to the server.
 *
 * CRITICAL: All hooks must come BEFORE any early returns. The WebView swallows
 * JS errors silently -- a hooks violation will blank the screen with no
 * diagnostic output.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom/client';

// Deep import the editor to avoid pulling in the entire runtime barrel
// (which transitively imports Excalidraw, Mermaid, etc. = ~25MB).
// The editor barrel registers built-in plugins and imports editor CSS.
import {
  NimbalystEditor,
  type EditorConfig,
  $convertToEnhancedMarkdownString,
  $convertFromEnhancedMarkdownString,
  getEditorTransformers,
} from '@nimbalyst/runtime/editor';

import { $getRoot, FORMAT_TEXT_COMMAND } from 'lexical';
import type { LexicalEditor, TextFormatType } from 'lexical';

import './styles.css';

const LOAD_TAG = 'nimbalyst-load';

// ============================================================================
// Bridge helpers
// ============================================================================

function postToNative(message: Record<string, unknown>): void {
  try {
    (window as any).AndroidEditorBridge?.postMessage(JSON.stringify(message));
  } catch {
    // Bridge may not be available (e.g., dev mode in browser)
  }
}

function postErrorToNative(error: Error | string, context?: string): void {
  const msg = error instanceof Error ? error.message : error;
  const stack = error instanceof Error ? error.stack : '';
  postToNative({
    type: 'error',
    message: context ? `${context}: ${msg}` : msg,
    stack: stack ?? '',
  });
}

function isBenignWindowErrorMessage(message: string): boolean {
  return message === 'ResizeObserver loop completed with undelivered notifications.';
}

window.onerror = (message, _source, _lineno, _colno, error) => {
  const normalizedMessage = error instanceof Error ? error.message : String(message);
  if (isBenignWindowErrorMessage(normalizedMessage)) {
    return true;
  }
  postErrorToNative(error ?? String(message), 'window.onerror');
  return false;
};

window.onunhandledrejection = (event) => {
  const reason =
    event.reason instanceof Error ? event.reason.message : String(event.reason);
  if (isBenignWindowErrorMessage(reason)) {
    event.preventDefault();
    return;
  }
  postErrorToNative(
    event.reason instanceof Error ? event.reason : String(event.reason),
    'unhandledrejection'
  );
};

// ============================================================================
// Error Boundary
// ============================================================================

class EditorErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    postErrorToNative(error, 'React render error');
    console.error('[EditorErrorBoundary]', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 20, color: '#ef4444', fontFamily: 'system-ui' }}>
          <h3>Editor Error</h3>
          <p>{this.state.error?.message ?? 'Unknown error'}</p>
          <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', color: '#999' }}>
            {this.state.error?.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// ============================================================================
// Editor App
// ============================================================================

function exportMarkdown(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => $convertToEnhancedMarkdownString(getEditorTransformers()));
}

function EditorApp(): React.ReactElement {
  // -- All hooks BEFORE any early return --
  const [content, setContent] = useState<string | null>(null);
  const editorRef = useRef<LexicalEditor | null>(null);
  // Read once at mount: flipping `editable` in the config rebuilds the editor
  // from `initialContent` and would drop unsaved edits, so later changes go
  // through editor.setEditable instead.
  const readOnlyRef = useRef(false);
  const initialEditableRef = useRef(true);
  const getContentRef = useRef<(() => string) | null>(null);
  const baselineRef = useRef<string | null>(null);
  const contentChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notifyContentChanged = useCallback((markdown: string) => {
    if (contentChangeTimerRef.current) {
      clearTimeout(contentChangeTimerRef.current);
    }
    contentChangeTimerRef.current = setTimeout(() => {
      contentChangeTimerRef.current = null;
      postToNative({ type: 'contentChanged', content: markdown });
    }, 500);
  }, []);

  useEffect(() => {
    const bridge = {
      loadMarkdown: (markdown: string) => {
        try {
          const editor = editorRef.current;
          if (editor) {
            if (contentChangeTimerRef.current) {
              clearTimeout(contentChangeTimerRef.current);
              contentChangeTimerRef.current = null;
            }
            editor.update(
              () => {
                const root = $getRoot();
                root.clear();
                $convertFromEnhancedMarkdownString(markdown, getEditorTransformers());
              },
              { tag: LOAD_TAG }
            );
          } else {
            setContent(markdown);
          }
        } catch (err) {
          postErrorToNative(err instanceof Error ? err : new Error(String(err)), 'loadMarkdown');
        }
      },

      setReadOnly: (isReadOnly: boolean) => {
        readOnlyRef.current = isReadOnly;
        if (editorRef.current) {
          editorRef.current.setEditable(!isReadOnly);
        } else {
          initialEditableRef.current = !isReadOnly;
        }
      },

      getContent: (): string => {
        if (getContentRef.current) {
          return getContentRef.current();
        }
        return editorRef.current ? exportMarkdown(editorRef.current) : '';
      },

      formatText: (format: TextFormatType) => {
        const editor = editorRef.current;
        if (editor) {
          editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
        }
      },
    };

    (window as any).nimbalystEditor = bridge;
    postToNative({ type: 'editorReady' });

    return () => {
      delete (window as any).nimbalystEditor;
    };
  }, []);

  const handleGetContent = useCallback((fn: () => string) => {
    getContentRef.current = fn;
  }, []);

  const handleEditorReady = useCallback((editor: LexicalEditor) => {
    editorRef.current = editor;
    editor.setEditable(!readOnlyRef.current);
    // initialContent is applied when the editor is created, before this
    // callback, so this export is the loaded document, not a user edit.
    baselineRef.current = exportMarkdown(editor);

    editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves, tags }) => {
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
      const markdown = editorState.read(() => $convertToEnhancedMarkdownString(getEditorTransformers()));
      if (tags.has(LOAD_TAG)) {
        baselineRef.current = markdown;
        return;
      }
      if (markdown === baselineRef.current) return;
      baselineRef.current = markdown;
      postToNative({ type: 'dirty', isDirty: true });
      notifyContentChanged(markdown);
    });
  }, [notifyContentChanged]);

  const editorConfig: EditorConfig = {
    editable: initialEditableRef.current,
    showToolbar: false,
    initialContent: content ?? undefined,
    onGetContent: handleGetContent,
    onEditorReady: handleEditorReady,
  };

  // Show placeholder until Android calls loadMarkdown
  if (content === null) {
    return (
      <div className="editor-loading">
        <span>Waiting for content...</span>
      </div>
    );
  }

  return (
    <div className="mobile-editor">
      <NimbalystEditor config={editorConfig} />
    </div>
  );
}

// ============================================================================
// Mount
// ============================================================================

const root = document.getElementById('editor-root');
if (root) {
  ReactDOM.createRoot(root).render(
    <EditorErrorBoundary>
      <EditorApp />
    </EditorErrorBoundary>
  );
} else {
  postErrorToNative(new Error('editor-root element not found'), 'mount');
}
