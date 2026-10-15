import { atom } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { WIKI_EXTENSION_ID, WIKI_AVAILABILITY_CHANNEL } from '../../../shared/wikiAvailability';

export const wikiEnabledAtom = atom(false);
let initialization: Promise<void> | undefined;
let unsubscribe: (() => void) | undefined;
/** Load persisted opt-in before rendering; other windows and agents update it live. */
export function initWikiAvailability(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    if (typeof window === 'undefined' || !window.electronAPI) return;
    let updated = false;
    unsubscribe = window.electronAPI.on(WIKI_AVAILABILITY_CHANNEL, (enabled: boolean) => {
      updated = true;
      store.set(wikiEnabledAtom, enabled === true);
    });
    try {
      const enabled = await window.electronAPI.invoke('extensions:get-enabled', WIKI_EXTENSION_ID, false);
      if (!updated) store.set(wikiEnabledAtom, enabled === true);
    } catch (error) { console.error('[Wiki] Could not read extension enablement:', error); }
  })();
  return initialization;
}
if (import.meta.hot) import.meta.hot.dispose(() => unsubscribe?.());
