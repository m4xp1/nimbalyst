import { useMemo } from 'react';
import { MarkdownEditor } from '@nimbalyst/runtime/editors';
import { useTheme } from '../../hooks/useTheme';
import { createReadOnlyEditorHost } from '../editors/createReadOnlyEditorHost';

const previewConfig = { editable: false, showToolbar: false } as const;

/** Render a file-backed tracker body without mounting a second writable tab. */
export function TrackerFileBackedPreview({ filePath, content }: {
  filePath: string;
  content: string;
}) {
  const { theme } = useTheme();
  const host = useMemo(() => createReadOnlyEditorHost({
    filePath,
    fileName: filePath.split(/[\\/]/).pop() || filePath,
    theme: theme || 'light',
    content,
  }), [filePath, theme, content]);

  return (
    <div
      className="tracker-file-backed-document-preview min-h-[200px] max-h-[60vh] overflow-auto border border-nim rounded bg-nim"
      data-testid="tracker-file-backed-document-preview"
    >
      <MarkdownEditor host={host} config={previewConfig} />
    </div>
  );
}
