import { getClaudePluginEnabled, getExtensionEnabled } from '../../utils/store';

import { WIKI_EXTENSION_ID } from '../../../shared/wikiAvailability';

/**
 * Whether agents have the wiki skills: the extension is on (off by default in this fork,
 * matching its manifest) and its Claude plugin has not been turned off (on by default).
 */
export function isWikiSkillAvailable(): boolean {
  return getExtensionEnabled(WIKI_EXTENSION_ID, false) && (getClaudePluginEnabled(WIKI_EXTENSION_ID) ?? true);
}
