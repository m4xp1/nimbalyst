// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadCodexAdditionalDirectories } from '../codexAdditionalDirectories';
import { ClaudeSettingsManager } from '../../services/ClaudeSettingsManager';
const fixture = vi.hoisted(() => ({ parent: '', user: '' }));
vi.mock('../../utils/logger', () => ({ logger: { main: { warn: vi.fn(), info: vi.fn() } } }));
vi.mock('../../services/PermissionService', () => ({ resolveWorkspacePathForPermissions: async () => fixture.parent }));
vi.mock('../../utils/workspaceDetection', () => ({ resolveProjectPath: (value: string) => value }));
vi.mock('@nimbalyst/runtime/ai/server/providers/claudeCode/claudeConfigDir', () => ({ resolveClaudeConfigDir: () => fixture.user }));

describe('Codex Additional Directories settings bridge', () => {
  it('merges effective settings with automatic roots without attaching permission-only folders', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'codex-settings-roots-'));
    try {
      const automatic = path.join(root, 'attached'), configured = path.join(root, 'permissions-only');
      mkdirSync(automatic); mkdirSync(configured);
      const read = vi.fn(async () => ({ permissions: { additionalDirectories: [configured, automatic + path.sep] } }));
      expect(await loadCodexAdditionalDirectories(root, [automatic], read)).toEqual([realpathSync.native(automatic), realpathSync.native(configured)]);
      expect(read).toHaveBeenCalledWith(root);
      expect(await loadCodexAdditionalDirectories(root, [automatic], async () => ({ permissions: {} }))).toEqual([realpathSync.native(automatic)]);
      expect(await loadCodexAdditionalDirectories(root, [configured], read)).toEqual([realpathSync.native(configured), realpathSync.native(automatic)]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('reports invalid explicit paths and settings errors instead of silently widening access', async () => {
    await expect(loadCodexAdditionalDirectories(process.cwd(), [], async () => { throw Error('settings unavailable'); })).rejects.toThrow('settings unavailable');
    await expect(loadCodexAdditionalDirectories(process.cwd(), [], async () => ({ permissions: { additionalDirectories: ['\0'] } }))).rejects.toThrow('Invalid Codex');
    await expect(loadCodexAdditionalDirectories(process.cwd(), [], async () => ({ permissions: { additionalDirectories: ['missing-codex-fixture-directory'] } }))).rejects.toThrow('Cannot use Codex');
  });
});

it('uses the same inherited user/project/local settings and reports corrupt settings for Codex only', async () => {
  const root=mkdtempSync(path.join(tmpdir(),'codex-inherited-settings-'));
  fixture.parent=path.join(root,'parent');fixture.user=path.join(root,'user');
  const worktree=path.join(root,'worktree'),shared=path.join(root,'shared'),local=path.join(root,'local'),user=path.join(root,'user-access');
  try {
    for(const dir of [path.join(fixture.parent,'.claude'),fixture.user,worktree,shared,local,user])mkdirSync(dir,{recursive:true});
    const file=path.join(fixture.parent,'.claude','settings.local.json');
    const settings=(directories:string[])=>JSON.stringify({permissions:{additionalDirectories:directories}});
    writeFileSync(path.join(fixture.user,'settings.json'),settings([user]));
    writeFileSync(path.join(fixture.parent,'.claude','settings.json'),settings([shared]));
    writeFileSync(file,settings([local,shared.toUpperCase()]));
    // Upper-case aliases are valid only on Windows.
    if(process.platform!=='win32')writeFileSync(file,settings([local,shared]));
    const manager=ClaudeSettingsManager.getInstance();
    const read=(value:string)=>manager.getEffectiveSettings(value,{strict:true});
    expect(await loadCodexAdditionalDirectories(worktree,[],read)).toEqual([user,shared,local].map(value=>realpathSync.native(value)));
    writeFileSync(file,'{bad json');
    await expect(loadCodexAdditionalDirectories(worktree,[],read)).rejects.toThrow('Cannot read agent permissions');
    // Existing Claude/UI callers retain their previous lenient reading behavior.
    expect((await manager.getEffectiveSettings(worktree)).permissions.additionalDirectories).toEqual([user,shared]);
    writeFileSync(file,JSON.stringify({permissions:{additionalDirectories:'invalid'}}));
    await expect(loadCodexAdditionalDirectories(worktree,[],read)).rejects.toThrow('must be an array');
  }finally{rmSync(root,{recursive:true,force:true});}
});
