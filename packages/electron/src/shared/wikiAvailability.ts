/** Wiki is opt-in, independently of its optional Claude skills/plugin. */
export const WIKI_EXTENSION_ID = 'com.nimbalyst.knowledge';
export const WIKI_AVAILABILITY_CHANNEL = 'wiki:availability-changed';
export const WIKI_TOOL_NAMES: ReadonlySet<string> = new Set([
 'listPages','searchPages','readCollabDoc','applyCollabDocEdit',
 'createSharedDoc','createSharedFolder','importFileToPages','renameSharedItem','moveSharedItem','deleteSharedItem',
 'setPageFields','setPageType','readCollabDocComments','createCollabDocComment','replyToCollabDocComment',
]);
