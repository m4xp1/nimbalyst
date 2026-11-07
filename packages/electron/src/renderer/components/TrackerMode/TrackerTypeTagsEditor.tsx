/**
 * Inline editor for an item's secondary type tags, shown in the tracker detail
 * pane under the metadata chips.
 */

import React, { useEffect, useRef, useState } from 'react';
import { NEUTRAL_SWATCH, TYPE_COLORS } from '@nimbalyst/collab-client/trackers-ui';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

/** Inline editor for adding/removing secondary type tags */
export const TypeTagsEditor: React.FC<{
  typeTags: string[];
  primaryType: string;
  onUpdate: (tags: string[]) => void | Promise<void>;
}> = ({ typeTags, primaryType, onUpdate }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [models, setModels] = useState(() => globalRegistry.getListed());
  const [pending, setPending] = useState(false);
  const updatePending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => globalRegistry.onChange(() => setModels(globalRegistry.getListed())), []);
  const allModels = models.filter(m => m.primaryCapable !== false && m.creatable !== false);
  const secondaryTags = typeTags.filter(t => t !== primaryType);
  const availableTypes = allModels.filter(m => m.type !== primaryType && !typeTags.includes(m.type));
  const update = async (tags: string[]) => {
    if (updatePending.current) return;
    updatePending.current = true;
    setPending(true);
    setError(null);
    try { await onUpdate(tags); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { updatePending.current = false; setPending(false); }
  };

  return (
    <div className="tracker-type-tags-editor space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-nim-faint font-medium uppercase tracking-wider">Type Tags</span>
        <button
          className="text-[10px] text-nim-muted hover:text-nim px-1 py-0.5 rounded hover:bg-nim-tertiary"
          onClick={() => setIsOpen(!isOpen)}
          aria-expanded={isOpen}
          title="Add another tracker type and its fields to this card"
        >
          {isOpen ? 'Close' : '+ Add'}
        </button>
      </div>
      {secondaryTags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {secondaryTags.map(tag => {
            const tagModel = globalRegistry.get(tag);
            const tagColor = TYPE_COLORS[tag] || NEUTRAL_SWATCH;
            return (
              <button
                type="button"
                key={tag}
                className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded cursor-pointer group"
                style={{ color: tagColor, backgroundColor: `${tagColor}15`, border: `1px solid ${tagColor}30` }}
                onClick={() => void update(typeTags.filter(t => t !== tag))}
                disabled={pending}
                aria-label={`Remove ${tagModel?.displayName || tag} type`}
                title={`Remove ${tagModel?.displayName || tag} tag`}
              >
                {tagModel?.displayName || tag}
                <span className="opacity-0 group-hover:opacity-100 text-[9px]">&times;</span>
              </button>
            );
          })}
        </div>
      )}
      {isOpen && <p className="text-[11px] text-nim-faint">{availableTypes.length ? 'Add another type to make its fields available on this card.' : 'No additional creatable types are available for this card.'}</p>}
      {error && <p role="alert" className="text-xs text-nim-error">{error}</p>}
      {isOpen && availableTypes.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {availableTypes.map(m => {
            const tagColor = TYPE_COLORS[m.type] || NEUTRAL_SWATCH;
            return (
              <button
                key={m.type}
                className="text-[10px] font-medium px-1.5 py-0.5 rounded hover:opacity-80"
                style={{ color: tagColor, backgroundColor: `${tagColor}10`, border: `1px dashed ${tagColor}40` }}
                disabled={pending}
                onClick={() => {
                  void update([...typeTags, m.type]);
                }}
              >
                + {m.displayName}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
