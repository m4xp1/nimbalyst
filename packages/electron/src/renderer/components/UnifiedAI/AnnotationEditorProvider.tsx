import React from 'react';
import { Provider, type Atom } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { AnnotationSessionContext } from './chatAnnotationDraft';

/** TabContent creates separate roots, so its parent context must be bridged explicitly. */
export function AnnotationEditorProvider({ target, children }: {
  target: Atom<string | null> | null;
  children: React.ReactNode;
}) {
  return (
    <Provider store={store}>
      <AnnotationSessionContext.Provider value={target}>{children}</AnnotationSessionContext.Provider>
    </Provider>
  );
}
