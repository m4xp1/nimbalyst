/** Offline native Codex contract check. Uses only a synthetic home, HTTP model and tool. */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import assert from 'node:assert/strict';
const version = '0.167.0';
const platforms = {
  'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
};
const target = `${process.platform}-${process.arch}`;
const binaryArg = process.argv.indexOf('--binary');
const binary = binaryArg >= 0 ? path.resolve(process.argv[binaryArg + 1]) : path.resolve(`node_modules/@openai/codex-${target}/vendor/${platforms[target]}/bin/codex${process.platform === 'win32' ? '.exe' : ''}`);
const root = await mkdtemp(path.join(tmpdir(), 'nimbalyst-codex-contract-'));
const env = {};
for (const [key, value] of Object.entries(process.env)) if (['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS'].includes(key.toUpperCase())) env[key] = value;
for (const key of ['HOME','USERPROFILE','CODEX_HOME','TMP','TEMP','APPDATA','LOCALAPPDATA']) env[key] = root;
// Any incidental native outbound traffic is blocked; only the synthetic HTTP server bypasses it.
Object.assign(env, { HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' });
let child, server, timer;
let requestCount = 0, toolCalls = 0;
let holdNextResponse = false, heldRequest = false;
const pending = new Map(), notifications = [];
let nextId = 1;
function outputItem(item) {
  const response = { id: `resp_${requestCount}`, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } };
  return `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`;
}
try {
  assert.equal(execFileSync(binary, ['--version'], { env, encoding: 'utf8', timeout: 15000 }).trim(), `codex-cli ${version}`);
  server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    if (!req.url?.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
    const body = JSON.parse(raw); requestCount++;
    assert.equal(body.model, 'fixture-model');
    if (holdNextResponse) { heldRequest = true; return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const item = requestCount === 1
      ? { type: 'function_call', id: 'fc_probe', call_id: 'call_probe', name: 'synthetic_probe', arguments: '{"value":"offline"}' }
      : { type: 'message', id: `msg_${requestCount}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Offline native tool complete.', annotations: [] }] };
    res.end(outputItem(item));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const extra = path.join(root, 'allowed-extra'); await mkdir(extra);
  const skill = path.join(workspace, '.agents/skills/synthetic'); await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: synthetic\ndescription: Offline native skill fixture\n---\nUse the synthetic fixture only.\n');
  await writeFile(path.join(root, 'config.toml'), `model = "fixture-model"\nmodel_provider = "fixture"\nmodel_context_window = 32768\ncli_auth_credentials_store = "file"\n[windows]\nsandbox = "unelevated"\n[model_providers.fixture]\nname = "Offline fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[analytics]\nenabled = false\n`);
  child = spawn(binary, ['app-server','--listen','stdio://'], { env, cwd: workspace, stdio: ['pipe','pipe','pipe'] });
  let diagnostic = ''; child.stderr.on('data', data => { diagnostic = (diagnostic + data.toString()).slice(-3000); });
  const write = data => child.stdin.write(JSON.stringify(data) + '\n');
  const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); write({ jsonrpc: '2.0', id, method, params }); });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id != null) {
      if (msg.method === 'item/tool/call') {
        toolCalls++; assert.equal(msg.params.tool, 'synthetic_probe');
        write({ jsonrpc: '2.0', id: msg.id, result: { success: true, contentItems: [{ type: 'inputText', text: 'Synthetic tool result.' }] } });
      } else write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unsupported fixture request' } });
    } else if (msg.id != null) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(JSON.stringify(msg.error))); else p?.resolve(msg.result);
    } else notifications.push(msg);
  });
  const failed = new Promise((_, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Native child exited ${code}: ${diagnostic}`)));
    timer = setTimeout(() => reject(new Error(`Native contract timeout: ${diagnostic}`)), 45000);
  });
  const run = async () => {
    const identityStarted = performance.now();
    await request('initialize', { clientInfo: { name: 'nimbalyst-offline-contract', version: '1' }, capabilities: { experimentalApi: true } });
    write({ method: 'initialized', params: {} });
    const accounts = await request('accountSession/list', { refreshWorkspaceMetadata: false });
    assert.equal(accounts.activeSessionId, null); assert.deepEqual(accounts.sessions, []);
    const identityReadMs = Math.round(performance.now() - identityStarted);
    const skills = await request('skills/list', { cwds: [workspace], forceReload: true });
    assert.ok(skills.data.some(entry => entry.skills.some(skill => skill.name === 'synthetic')));
    const models = await request('model/list', { limit: 100, includeHidden: false });
    assert.ok(Array.isArray(models.data));
    if (process.platform === 'win32') {
      const readiness = await request('windowsSandbox/readiness', {});
      assert.ok(['ready', 'notConfigured', 'updateRequired'].includes(readiness.status));
      await request('configRequirements/read', {});
    }
    const reviewed = await request('thread/start', { cwd: workspace, model: 'fixture-model', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' });
    assert.equal(reviewed.sandbox.type, 'workspaceWrite');
    const unrestricted = await request('thread/start', { cwd: workspace, model: 'fixture-model', approvalPolicy: 'never', sandbox: 'danger-full-access' });
    assert.equal(unrestricted.sandbox.type, 'dangerFullAccess');
    const start = await request('thread/start', { config: { 'sandbox_workspace_write.writable_roots': [extra] }, cwd: workspace, model: 'fixture-model', approvalPolicy: 'never', sandbox: 'workspace-write', dynamicTools: [{ name: 'synthetic_probe', description: 'Offline fixture tool', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }] });
    assert.ok(start.thread.id);
    assert.equal(start.sandbox.type, 'workspaceWrite');
    assert.ok(start.sandbox.writableRoots.some(p => path.normalize(p).toLowerCase() === path.normalize(extra).toLowerCase()));
    const turn = await request('turn/start', { threadId: start.thread.id, input: [{ type: 'text', text: 'Run the offline tool.', text_elements: [] }] });
    while (!notifications.some(n => n.method === 'turn/completed' && n.params?.turn?.id === turn.turn.id)) await new Promise(r => setTimeout(r, 20));
    const done = notifications.find(n => n.method === 'turn/completed' && n.params?.turn?.id === turn.turn.id);
    assert.equal(done.params.turn.status, 'completed', JSON.stringify(done.params.turn.error));
    assert.equal(toolCalls, 1); assert.equal(requestCount, 2);
    const resumed = await request('thread/resume', { threadId: start.thread.id, cwd: workspace, model: 'fixture-model', approvalPolicy: 'never', sandbox: 'workspace-write' });
    assert.equal(resumed.thread.id, start.thread.id);
    holdNextResponse = true;
    const interrupted = await request('turn/start', { threadId: start.thread.id, input: [{ type: 'text', text: 'Offline cancellation fixture.', text_elements: [] }] });
    while (!heldRequest) await new Promise(r => setTimeout(r, 20));
    await request('turn/interrupt', { threadId: start.thread.id, turnId: interrupted.turn.id });
    while (!notifications.some(n => n.method === 'turn/completed' && n.params?.turn?.id === interrupted.turn.id)) await new Promise(r => setTimeout(r, 20));
    assert.equal(notifications.find(n => n.method === 'turn/completed' && n.params?.turn?.id === interrupted.turn.id).params.turn.status, 'interrupted');
    holdNextResponse = false;
    const { Codex } = await import('@openai/codex-sdk');
    const sdk = new Codex({ codexPathOverride: binary, env });
    const legacy = sdk.startThread({ workingDirectory: workspace, skipGitRepoCheck: true, model: 'fixture-model', approvalPolicy: 'never', sandboxMode: 'workspace-write' });
    const sdkTurn = await legacy.run('Offline legacy SDK fixture.');
    assert.equal(sdkTurn.finalResponse, 'Offline native tool complete.');
    return { version, target, initialized: true, emptyNativeAccount: true, identityReadMs, sandboxPolicyAccepted: true, skillDiscovered: true, modelCatalogRead: true, toolCalls, localModelRequests: requestCount, turnCompleted: true, resumed: true, interrupted: true, legacySdkCompleted: true, paidRequests: 0, workingProfileRead: false };
  };
  console.log(JSON.stringify(await Promise.race([run(), failed]), null, 2));
} finally {
  clearTimeout(timer);
  child?.stdin?.end(); if (child && !child.killed) child.kill();
  for (const p of pending.values()) p.reject(new Error('fixture closed'));
  server?.closeAllConnections(); if (server?.listening) await new Promise(resolve => server.close(resolve));
  // Only the directory returned by mkdtemp is removed; no user profile path is accepted.
  assert.equal(path.dirname(root), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('nimbalyst-codex-contract-'));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
