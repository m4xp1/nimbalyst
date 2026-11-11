import { useEffect, useState } from 'react';
import { atom, useAtom, useStore } from 'jotai';
import {
  clampEffortLevel, getAvailableEffortLevels, parseEffortLevel, type EffortLevel,
} from '@nimbalyst/runtime/ai/server/effortLevels';
import type { AgentModelOption } from './AgentModelPicker';

interface SmartCommitSettings {
  model: string;
  effort: EffortLevel;
  temporary: boolean;
}

const settingsKey = 'smartCommitOptions';
const settingsAtom = atom<SmartCommitSettings | null>(null);
const defaultSettings: SmartCommitSettings = { model: '', effort: 'high', temporary: false };
let pendingWrite: Promise<unknown> = Promise.resolve();

function restoreSettings(value: unknown): SmartCommitSettings {
  if (!value || typeof value !== 'object') return defaultSettings;
  const stored = value as Partial<SmartCommitSettings>;
  return {
    model: typeof stored.model === 'string' ? stored.model : '',
    effort: parseEffortLevel(stored.effort),
    temporary: stored.temporary === true,
  };
}

export function useSmartCommitOptions() {
  const [stored, setStored] = useAtom(settingsAtom);
  const store = useStore();
  const [settingsError, setSettingsError] = useState<string | null>(null);
  useEffect(() => window.electronAPI?.onAppSettingsChanged?.(({ key, value }) => {
    if (key === settingsKey) setStored(restoreSettings(value));
  }), [setStored]);
  useEffect(() => {
    if (stored !== null || !window.electronAPI) return;
    let live = true;
    void window.electronAPI.invoke('app-settings:get', settingsKey).then(value => {
      if (live) setStored(current => current ?? restoreSettings(value));
    }).catch(() => {
      if (live) {
        setSettingsError('Smart Commit preferences could not be loaded.');
        setStored(current => current ?? defaultSettings);
      }
    });
    return () => { live = false; };
  }, [stored, setStored]);

  const update = (changes: Partial<SmartCommitSettings>) => {
    const next = { ...(store.get(settingsAtom) ?? defaultSettings), ...changes };
    setStored(next);
    setSettingsError(null);
    pendingWrite = pendingWrite.catch(() => {}).then(() => window.electronAPI.invoke('app-settings:set', settingsKey, next));
    void pendingWrite.catch(() => setSettingsError('Smart Commit preferences could not be saved.'));
  };
  return { settings: stored ?? defaultSettings, isLoading: stored === null, settingsError, update };
}

export function SmartCommitOptions({
  value, models, onChange, disabled, settingsError,
}: {
  value: SmartCommitSettings;
  models: AgentModelOption[];
  onChange: (changes: Partial<SmartCommitSettings>) => void;
  disabled: boolean;
  settingsError: string | null;
}) {
  const modelAvailable = models.some(model => model.id === value.model);
  const effort = clampEffortLevel(value.effort, value.model);
  const fieldClass = 'min-w-0 border border-nim rounded bg-nim text-nim text-xs px-2 py-1.5';
  return (
    <div className="smart-commit-options flex flex-col gap-2 text-xs text-nim">
      <div className="grid grid-cols-2 gap-2">
        <label className="flex min-w-0 flex-col gap-1">
          Model
          <select className={fieldClass} value={modelAvailable ? value.model : ''} disabled={disabled}
            onChange={event => onChange({ model: event.target.value, effort: clampEffortLevel(value.effort, event.target.value) })}>
            <option value="">{value.temporary ? 'Select Codex model' : 'Current session model'}</option>
            {models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          Effort
          <select className={fieldClass} value={effort} disabled={disabled || !modelAvailable}
            onChange={event => onChange({ effort: parseEffortLevel(event.target.value) })}>
            {getAvailableEffortLevels(value.model).map(level => <option key={level.key} value={level.key}>{level.label}</option>)}
          </select>
        </label>
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={value.temporary} disabled={disabled}
          onChange={event => onChange({ temporary: event.target.checked })} />
        Run in a temporary Codex session
      </label>
      {settingsError && <div role="alert" className="text-nim-error">{settingsError}</div>}
    </div>
  );
}
