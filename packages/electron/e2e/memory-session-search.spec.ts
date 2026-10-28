import {test,expect,_electron,type ElectronApplication,type Page} from '@playwright/test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {execFileSync} from 'node:child_process';

// Real built host/utility/MCP routes, fresh profile, synthetic dialogue, no provider keys.
test.describe.serial('Built Memory session search and current dialogue',()=>{
 let app:ElectronApplication,page:Page,client:Client,workspace:string,temp:string;
 let tools:{name:string}[]=[];
 const root=path.resolve(__dirname,'../../..'),sid='memory-dialogue-parent',child='memory-dialogue-child';
 async function invoke(channel:string,...args:any[]) {return page.evaluate(({channel,args})=>(window as any).electronAPI.invoke(channel,...args),{channel,args});}
 async function call(suffix:string,args:any={}) {
  const name=tools.find(t=>t.name.endsWith(suffix))?.name;expect(name).toBeTruthy();
  const result=await client.callTool({name:name!,arguments:args});
  if(result.isError)throw new Error(JSON.stringify(result.content));
  return JSON.parse((result.content as any)[0].text);
 }
 async function append(id:string,text:string,direction:'input'|'output') {
  const content=JSON.stringify(direction==='input'?{prompt:text}:{method:'item/completed',params:{item:{id:'reply-'+text.slice(0,15),type:'agentMessage',text}}});
  expect((await invoke('test:insert-message',{sessionId:id,direction,source:'openai-codex',metadata:{transport:'app-server'},content})).success).toBe(true);
 }
 test.beforeAll(async()=>{
  temp=await fs.mkdtemp(path.join(os.tmpdir(),'nimbalyst-session-search-'));workspace=path.join(temp,'Memory dialogue');await fs.mkdir(workspace);await fs.mkdir(path.join(temp,'user'));
  execFileSync('git',['init',workspace],{stdio:'ignore',windowsHide:true});
  await fs.mkdir(path.join(workspace,'docs'));
  await fs.writeFile(path.join(workspace,'docs','CHECKPOINT.md'),'---\ntitle: Состояние искусственного проекта\ndescription: Точка продолжения проверки\ndoc_kind: checkpoint\n---\n# Продолжение сценария\n## Следующий шаг\nОткрыть METADATA_OPEN_TARGET.');
  await fs.writeFile(path.join(workspace,'docs','quote.md'),'# Отчёт\nПроверяли запрос: состояние искусственного проекта.');

  const mainPath=process.env.NIMBALYST_E2E_MAIN_PATH??path.join(root,'packages/electron/out/main/index.js'),isolate=path.join(temp,'isolate.cjs');
  await fs.writeFile(isolate,`const {app}=require('electron');app.setPath('userData',${JSON.stringify(path.join(temp,'user'))});app.setPath('appData',${JSON.stringify(temp)});app.setAppPath(${JSON.stringify(path.dirname(mainPath))});require(${JSON.stringify(mainPath)});`);
  const {ELECTRON_RUN_AS_NODE,NODE_PATH,ELECTRON_RENDERER_URL,...clean}=process.env;
  app=await _electron.launch({...(process.env.NIMBALYST_E2E_APP_PATH?{executablePath:process.env.NIMBALYST_E2E_APP_PATH}:{}),args:[...(process.env.NIMBALYST_E2E_APP_PATH?[`--user-data-dir=${path.join(temp,'user')}`]:[isolate]),'--workspace',workspace],cwd:root,timeout:45000,
   env:{...clean,PLAYWRIGHT:'1',NIMBALYST_PERMISSION_MODE:'allow-all',NIMBALYST_CDP_PORT:'0',NIMBALYST_USER_DATA_DIR:path.join(temp,'user'),NIMBALYST_USER_DATA_PATH:path.join(temp,'db'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:''}});
  page=await app.firstWindow();await page.getByTestId('tracker-mode-button').waitFor();
  expect(await app.evaluate(({app})=>app.getPath('userData'))).toBe(path.join(temp,'user'));
  await app.evaluate(({session})=>{(globalThis as any).__sessionOpenAI=0;session.defaultSession.webRequest.onBeforeRequest({urls:['*://*.openai.com/*','*://openai.com/*']},(_d,cb)=>{(globalThis as any).__sessionOpenAI++;cb({cancel:true});});});
  expect((await invoke('test:insert-session',{id:sid,workspaceId:workspace,provider:'openai-codex',title:'Родительский диалог'})).success).toBe(true);
  expect((await invoke('test:insert-session',{id:child,workspaceId:workspace,provider:'openai-codex',title:'Дочерний диалог',parentSessionId:sid})).success).toBe(true);
  // Synthetic persisted credential exercises the real host broker denial in built and packaged apps.
  const savedKey=await invoke('provider-credentials:set','openai','synthetic-not-an-openai-key');
  expect(savedKey.credentials.some((key:any)=>key.name==='openai'&&key.configured)).toBe(true);
  await invoke('permissions:trustWorkspace',workspace);
  await invoke('extensions:set-enabled','com.nimbalyst.memory',true);await invoke('semantic-search:set-index-sessions',true);
  const {port}=await invoke('mcp:get-server-port'),{token}=await invoke('mcp:get-auth-token');
  client=new Client({name:'fake-session-search-agent',version:'1'},{capabilities:{}});
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/ext/memory?workspacePath=${encodeURIComponent(workspace)}&sessionId=${sid}`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  // The first MCP connection registers the window's routing workspace.
  await invoke('extensions:set-enabled','com.nimbalyst.memory',true);
  await expect.poll(async()=>{tools=(await client.listTools()).tools;return tools.some(t=>t.name.endsWith('read_session'));},{timeout:30000}).toBe(true);
 },60000);
 test.afterEach(async({},info)=>{if(page&&info.status!==info.expectedStatus)await page.screenshot({path:info.outputPath('session-search-failure.png')});});
 test.afterAll(async()=>{await client?.close();if(app){const timer=setTimeout(()=>app.process().kill(),5000);try{await app.close();}finally{clearTimeout(timer);}}});
 test('withholds a saved OpenAI key from the real Memory utility process',async()=>{
  const status=await call('local_embeddings_status',{});expect(status.activeMode).toBe('sparse');
  expect(tools.some((tool:any)=>tool.name.includes('get_embedding_usage')||tool.name.includes('set_embedding_logging'))).toBe(false);
  const snapshot=await invoke('provider-credentials:list');expect(snapshot.credentials.some((key:any)=>key.name==='openai'&&key.configured)).toBe(true);
 });
 test('finds persisted user and assistant markers, reads pages, and opens the actual child',async()=>{
  await append(sid,'РусскийПользовательМаркер '+('Текст😀 '.repeat(4000)),'input');await append(sid,'РусскийАссистентМаркер','output');await append(child,'МаркерДочернегоДиалога','input');
  await expect.poll(async()=>{const hits=await call('search_project_knowledge',{query:'РусскийАссистентМаркер',k:10});return hits.chunks.some((h:any)=>h.refId===sid&&h.text.includes('РусскийАссистентМаркер'));},{timeout:10000}).toBe(true);
  const search=await call('search_project_knowledge',{query:'РусскийАссистентМаркер',k:10});
  expect(search.sessionReadHint).toEqual(expect.any(String));
  const hit=search.chunks.find((h:any)=>h.refId===sid);expect(hit.sourcePath).toBe('session:'+sid);
  expect((await call('expand',{sourcePath:hit.sourcePath,headingPath:hit.headingPath})).text).toContain('РусскийАссистентМаркер');
  let result=await call('read_session',{sessionId:sid,maxChars:1000}),text=result.text;const version=result.snapshotVersion;
  await append(sid,'ОтветПослеСнимкаМаркер','output');
  while(result.hasMore){result=await call('read_session',{sessionId:sid,cursor:result.nextCursor,maxChars:1000});expect(result.snapshotVersion).toBe(version);text+=result.text;}
  expect(text).toContain('## User');expect(text).toContain('## Assistant');expect(text).toContain('РусскийПользовательМаркер');expect(text.match(/РусскийАссистентМаркер/g)).toHaveLength(1);expect(text).not.toContain('МаркерДочернегоДиалога');
  expect(text).not.toContain('ОтветПослеСнимкаМаркер');expect((await call('read_session',{sessionId:sid})).snapshotVersion).not.toBe(version);
  const childText=await call('read_session',{sessionId:child});expect(childText.parentSessionId).toBe(sid);expect(childText.text).toContain('МаркерДочернегоДиалога');
  await page.keyboard.press('Control+o');await page.locator('.unified-quick-open-tab').getByText('Sessions',{exact:true}).click();
  await page.getByTestId('unified-quick-open-search').fill('РусскийПользовательМаркер');
  await page.getByRole('button',{name:'Search contents'}).click();
  const sessionRow=page.locator('.sessions-pane .unified-quick-open-item').filter({hasText:'Родительский диалог'});
  await expect(sessionRow).toBeVisible();await page.getByTestId('unified-quick-open-search').fill('РусскийАссистентМаркер');
  await page.getByRole('button',{name:'Search contents'}).click();await expect(sessionRow).toBeVisible();
  await page.locator('.unified-quick-open-tab').getByText('Prompts',{exact:true}).click();await page.getByTestId('unified-quick-open-search').fill('РусскийПользовательМаркер');
  const promptRow=page.locator('.prompts-pane .unified-quick-open-item').filter({hasText:'РусскийПользовательМаркер'});await expect(promptRow).toBeVisible();
  await page.getByTestId('unified-quick-open-search').fill('РусскийАссистентМаркер');await expect(page.locator('.prompts-pane .unified-quick-open-item')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+o');await page.locator('.unified-quick-open-tab').getByText('Memory',{exact:true}).click();await page.getByTestId('unified-quick-open-search').fill('МаркерДочернегоДиалога');
  const row=page.locator('.memory-search-pane .unified-quick-open-item').filter({hasText:'Дочерний диалог'});await expect(row).toBeVisible();await page.mouse.move(1,1);await row.click();
  await expect(page.getByText('Дочерний диалог',{exact:true}).first()).toBeVisible();
  const open=await call('read_session',{sessionId:sid,maxChars:1000});await invoke('semantic-search:set-index-sessions',false);
  await expect(call('read_session',{sessionId:sid,cursor:open.nextCursor})).rejects.toThrow(/disabled/);
  expect(await app.evaluate(()=>(globalThis as any).__sessionOpenAI)).toBe(0);
 });
 test('uses the same metadata ranking in MCP and Memory, then opens the original file',async()=>{
  const query='состояние искусственного проекта';
  const result=await call('search_project_knowledge',{query,k:5});expect(result.chunks[0].sourcePath).toBe('docs/CHECKPOINT.md');expect(result.chunks[0].matchedFields).toEqual(expect.arrayContaining([expect.objectContaining({field:'title',value:'Состояние искусственного проекта'})]));
  expect((await call('search_project_knowledge',{query:'checkpoint'})).chunks[0].sourcePath).toBe('docs/CHECKPOINT.md');
  const doc=await call('read_doc',{path:'docs/CHECKPOINT.md'});expect(doc.content).toContain('doc_kind: checkpoint');
  await page.keyboard.press('Control+o');await page.locator('.unified-quick-open-tab').getByText('Memory',{exact:true}).click();await page.getByTestId('unified-quick-open-search').fill(query);
  const row=page.locator('.memory-search-pane .unified-quick-open-item').first();await expect(row).toContainText('Matched title: Состояние искусственного проекта');await page.mouse.move(1,1);await row.click();
  await expect(page.locator('.file-tabs-container [contenteditable=true]').filter({visible:true}).first()).toContainText('METADATA_OPEN_TARGET');
  expect(await app.evaluate(()=>(globalThis as any).__sessionOpenAI)).toBe(0);
 });

});
