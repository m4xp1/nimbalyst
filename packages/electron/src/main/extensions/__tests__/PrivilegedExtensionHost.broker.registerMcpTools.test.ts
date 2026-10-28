/**
 * OBSERVED integration test for the privileged broker `registerMcpTools` path.
 *
 * Drives the REAL PrivilegedExtensionHost.handleBrokerRequest -> REAL
 * assertPermission gate -> REAL dispatchBrokerMethod 'registerMcpTools' branch
 * -> REAL backendToolRegistry. Confirms the fan-out the stub used to skip:
 * registered tools land in the registry keyed by the module's workspace, the
 * gate requires `mcp-server-register`, and a denied grant registers nothing.
 *
 * Run from repo root:
 *   npx vitest --run packages/electron/src/main/extensions/__tests__/PrivilegedExtensionHost.broker.registerMcpTools.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fuller `electron` mock (importing the host transitively loads WindowManager,
// which touches app.on at module load). Mirrors the logRaw broker test.
vi.mock('electron', async () => {
  const noop = () => {};
  return {
    app: {
      on: vi.fn(),
      once: vi.fn(),
      whenReady: vi.fn(() => Promise.resolve()),
      getPath: (await import('../../../../test-stubs/privateUserData')).testApp.getPath,
      getName: vi.fn(() => 'test-app'),
      getVersion: vi.fn(() => '1.0.0'),
      setName: vi.fn(),
      setPath: vi.fn(),
      quit: vi.fn(),
      requestSingleInstanceLock: vi.fn(() => true),
      commandLine: { appendSwitch: vi.fn() },
    },
    BrowserWindow: class FakeBrowserWindow {
      static fromWebContents = vi.fn(() => null);
      static getFocusedWindow = vi.fn(() => null);
      static getAllWindows = vi.fn(() => []);
      on = noop;
    },
    ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
    ipcRenderer: { send: vi.fn(), on: vi.fn(), invoke: vi.fn() },
    dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
    screen: { getPrimaryDisplay: vi.fn(() => ({ workAreaSize: { width: 1920, height: 1080 } })), on: vi.fn() },
    nativeTheme: { on: vi.fn(), shouldUseDarkColors: false },
    nativeImage: { createFromPath: vi.fn(() => ({})), createEmpty: vi.fn(() => ({})) },
    Menu: class FakeMenu { static setApplicationMenu = vi.fn(); static buildFromTemplate = vi.fn(); },
    shell: { openExternal: vi.fn() },
    utilityProcess: { fork: vi.fn() },
  };
});

// Control ONLY the grant lookup; assertPermission stays real.
vi.mock('../permissionGrantStore', async (orig) => {
  const actual = await orig<typeof import('../permissionGrantStore')>();
  return { ...actual, isPermissionGranted: vi.fn() };
});

vi.mock('../../services/extensionSessions/extensionSessionsService', () => ({
  dispatchExtensionSessionsOp: vi.fn(async () => ({ sessionId: 's-1' })),
  setOwnedSessionEventSink: vi.fn(),
}));

vi.mock('../backendPanelBadges', () => ({
  setBackendPanelGutterBadge: vi.fn(async () => {}),
  registerBackendPanelBadgeHandlers: vi.fn(),
  clearBackendPanelGutterBadgesForModule: vi.fn(),
}));

import { PrivilegedExtensionHost } from '../PrivilegedExtensionHost';
import {
  clearBackendPanelGutterBadgesForModule,
  setBackendPanelGutterBadge,
} from '../backendPanelBadges';
import {
  dispatchExtensionSessionsOp,
  setOwnedSessionEventSink,
} from '../../services/extensionSessions/extensionSessionsService';
import { isPermissionGranted } from '../permissionGrantStore';
import {
  getBackendTools,
  getVoiceEnabledBackendTools,
  _resetBackendToolRegistry,
} from '../../mcp/backendToolRegistry';

const grantMock = isPermissionGranted as unknown as ReturnType<typeof vi.fn>;

const ctx = {
  extensionId: 'com.nimbalyst.memory',
  moduleId: 'memory-engine',
  workspacePath: '/ws',
  grantedPermissions: ['mcp-server-register'],
  entryFilePath: '/x/entry.js',
  extensionPath: '/x',
  dataDir: '/x/data',
} as const;

function makeManaged(send: (m: unknown) => void) {
  return {
    args: {
      extensionId: 'com.nimbalyst.memory',
      extensionName: 'Nimbalyst Memory',
      extensionPath: '/x',
      module: { id: 'memory-engine' },
      workspacePath: '/ws',
    },
    state: { status: 'running', startedAt: 0, methods: [] },
    grantedPermissions: ['mcp-server-register'],
    runtime: { send, kill: async () => {}, isAlive: () => true },
    pending: new Map(),
    nextRpcId: 1,
  } as unknown as Parameters<any>[0];
}

function drive(
  host: PrivilegedExtensionHost,
  managed: unknown,
  payload: unknown,
  method = 'registerMcpTools'
): Promise<void> {
  return (host as unknown as {
    handleBrokerRequest: (
      m: unknown, c: unknown, r: string, method: string, p: unknown, l: string,
    ) => Promise<void>;
  }).handleBrokerRequest(managed, ctx, 'req-1', method, payload, 'test');
}

describe('PrivilegedExtensionHost broker registerMcpTools', () => {
  let host: PrivilegedExtensionHost;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetBackendToolRegistry();
    host = new PrivilegedExtensionHost();
  });

  afterEach(() => {
    _resetBackendToolRegistry();
  });

  it('granted registerMcpTools fans tools into the registry keyed by the module workspace', async () => {
    grantMock.mockReturnValue(true);
    const sent: Array<Record<string, unknown>> = [];
    const managed = makeManaged((m) => sent.push(m as Record<string, unknown>));

    const payload = {
      tools: [
        {
          name: 'search_project_knowledge',
          description: 'hybrid search',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          voiceAgent: true,
        },
        { name: 'status', description: 'index status' },
      ],
    };

    await drive(host, managed, payload);

    // Tools landed in the registry for the module's workspace, namespaced.
    const tools = getBackendTools('/ws');
    expect(tools.map((t) => t.name).sort()).toEqual([
      'memory.search_project_knowledge',
      'memory.status',
    ]);
    expect(getVoiceEnabledBackendTools('/ws').map((t) => t.method)).toEqual([
      'search_project_knowledge',
    ]);

    // The gate queried the HOST-authoritative permission for this method.
    expect(grantMock).toHaveBeenCalledWith(
      'com.nimbalyst.memory',
      'memory-engine',
      'mcp-server-register',
      '/ws',
    );

    // The host replied with the registered (namespaced) names.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: 'broker-response',
      requestId: 'req-1',
      result: { registered: ['memory.search_project_knowledge', 'memory.status'] },
    });
  });

  it('denied grant registers nothing and replies broker-error (defense-in-depth gate)', async () => {
    grantMock.mockReturnValue(false);
    const sent: Array<Record<string, unknown>> = [];
    const managed = makeManaged((m) => sent.push(m as Record<string, unknown>));

    await drive(host, managed, { tools: [{ name: 'search' }] });

    expect(getBackendTools('/ws')).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('broker-error');
    const error = sent[0].error as { name?: string; message?: string };
    expect(error.name).toBe('CapabilityDeniedError');
    expect(error.message).toContain('mcp-server-register');
  });
});

describe('PrivilegedExtensionHost broker sessions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scopes every sessions op to the runtime\'s own extension and workspace, behind ai-sessions', async () => {
    const host = new PrivilegedExtensionHost();
    const sent: Array<Record<string, unknown>> = [];
    const managed = makeManaged((m) => sent.push(m as Record<string, unknown>));
    const forged = { op: 'create', args: { ownerKey: 'ada', extensionId: 'com.other' }, extensionId: 'com.other', workspacePath: '/elsewhere' };

    grantMock.mockReturnValue(false);
    await drive(host, managed, forged, 'sessions');
    expect(dispatchExtensionSessionsOp).not.toHaveBeenCalled();
    expect(sent[0].kind).toBe('broker-error');
    expect(grantMock).toHaveBeenCalledWith('com.nimbalyst.memory', 'memory-engine', 'ai-sessions', '/ws');

    grantMock.mockReturnValue(true);
    await drive(host, managed, forged, 'sessions');
    expect(dispatchExtensionSessionsOp).toHaveBeenCalledWith(
      { extensionId: 'com.nimbalyst.memory', workspacePath: '/ws' },
      'create',
      forged.args
    );
    expect(sent[1]).toMatchObject({ kind: 'broker-response', result: { result: { sessionId: 's-1' } } });
  });

  it('delivers owned-session settles only to running modules of the owning extension holding ai-sessions', () => {
    const host = new PrivilegedExtensionHost();
    const sink = vi.mocked(setOwnedSessionEventSink).mock.calls.at(-1)![0]!;
    const modules = (host as unknown as { modules: Map<string, unknown> }).modules;
    const inbox: Record<string, unknown[]> = { owner: [], activating: [], noGrant: [], other: [], otherWs: [], crashed: [] };
    const add = (name: string, extensionId: string, workspacePath: string, granted: string[], status = 'running') => {
      const m = makeManaged((msg) => inbox[name].push(msg)) as any;
      m.args = { ...m.args, extensionId, workspacePath, module: { id: name } };
      m.grantedPermissions = granted;
      m.state = { status };
      modules.set(name, m);
    };
    expect(sink.hasListeners()).toBe(false);
    add('owner', 'com.example.owner', '/ws', ['ai-sessions']);
    add('noGrant', 'com.example.owner', '/ws', []);
    add('other', 'com.other', '/ws', ['ai-sessions']);
    add('otherWs', 'com.example.owner', '/ws2', ['ai-sessions']);
    // Still inside activate(): it may already have subscribed and started a session.
    add('activating', 'com.example.owner', '/ws', ['ai-sessions'], 'starting');
    add('crashed', 'com.example.owner', '/ws', ['ai-sessions'], 'crashed');
    expect(sink.hasListeners()).toBe(true);

    const event = { sessionId: 's', ownerKey: 'ada', outcome: 'completed' } as any;
    sink.emit('com.example.owner', '/ws', event);
    expect(inbox.owner).toEqual([{ kind: 'broker-event', event: 'sessions:settled', payload: event }]);
    expect(inbox.activating).toEqual(inbox.owner);
    expect([inbox.noGrant, inbox.other, inbox.otherWs, inbox.crashed]).toEqual([[], [], [], []]);
  });
});

describe('PrivilegedExtensionHost broker panels', () => {
  beforeEach(() => vi.clearAllMocks());

  it('needs no grant, scopes the badge to the runtime context, and still gates unknown methods', async () => {
    const host = new PrivilegedExtensionHost();
    const sent: Array<Record<string, unknown>> = [];
    const managed = makeManaged((m) => sent.push(m as Record<string, unknown>));
    grantMock.mockReturnValue(false);

    await drive(host, managed, { panelId: 'desk', value: 2, tone: 'warning', extensionId: 'com.other' }, 'panels');
    expect(grantMock).not.toHaveBeenCalled();
    expect(setBackendPanelGutterBadge).toHaveBeenCalledWith(ctx, 'desk', 2, 'warning');
    expect(sent[0]).toMatchObject({ kind: 'broker-response', result: {} });

    await drive(host, managed, {}, 'notARealMethod');
    expect(sent[1].kind).toBe('broker-error');
  });

  it('clears a module\'s backend badges when it stops or crashes', () => {
    const host = new PrivilegedExtensionHost();
    const managed = makeManaged(() => {}) as any;
    (host as any).setState(managed, { status: 'running', startedAt: 0, methods: [] });
    expect(clearBackendPanelGutterBadgesForModule).not.toHaveBeenCalled();
    (host as any).setState(managed, { status: 'crashed', exitCode: 1, crashedAt: 0 });
    expect(clearBackendPanelGutterBadgesForModule).toHaveBeenCalledWith('com.nimbalyst.memory', 'memory-engine', '/ws');
  });
});

describe('Memory search-root broker boundary', () => {
  it('returns a newly attached folder on its first read while keeping repeated reads cached',async()=>{
    const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
    const {memorySourceRoots}=await import('../../utils/memorySourceRoots');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'search-root-attach-')),main=path.join(dir,'main'),attached=path.join(dir,'link');fs.mkdirSync(main);fs.mkdirSync(attached);
    try{
      expect((await memorySourceRoots(main,[main])).map(root=>root.id)).toEqual([null]);
      const roots=await memorySourceRoots(main,[main,attached]);expect(roots).toHaveLength(2);expect(roots[1]).toMatchObject({path:fs.realpathSync.native(attached),available:true});
      expect(await memorySourceRoots(main,[main,attached])).toEqual(roots);
      expect((await memorySourceRoots(main,[main])).map(root=>root.id)).toEqual([null]);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });

  it('derives roots from the bound workspace and ignores a forged workspace payload',async()=>{
    const {dispatchBrokerMethod}=await import('../extensionBrokerDispatch');
    const roots=await dispatchBrokerMethod('memorySourceRoots',{workspacePath:'/unrelated'},{...ctx,grantedPermissions:[...ctx.grantedPermissions]}) as Array<{path:string}>;
    const path=await import('node:path');
    expect(roots[0].path).toBe(path.resolve('/ws'));
    expect(roots.some(root=>root.path===path.resolve('/unrelated'))).toBe(false);
  });
  it('does not expose the roots capability to another extension or module',async()=>{
    const {dispatchBrokerMethod}=await import('../extensionBrokerDispatch');
    await expect(dispatchBrokerMethod('memorySourceRoots',{}, {...ctx,grantedPermissions:[...ctx.grantedPermissions],extensionId:'com.other'})).rejects.toThrow(/denied/);
    await expect(dispatchBrokerMethod('memorySourceRoots',{}, {...ctx,grantedPermissions:[...ctx.grantedPermissions],moduleId:'other'})).rejects.toThrow(/denied/);
  });
});

it('does not grant embedding diagnostic control to another extension',async()=>{
 const {dispatchBrokerMethod}=await import('../extensionBrokerDispatch');
 await expect(dispatchBrokerMethod('embeddingDiagnostics',{op:'get'},{...ctx,extensionId:'com.other'} as any)).rejects.toThrow(/denied/);
 await expect(dispatchBrokerMethod('embeddingDiagnostics',{op:'set',enabled:true},ctx as any)).rejects.toThrow(/Developer mode/);
});
