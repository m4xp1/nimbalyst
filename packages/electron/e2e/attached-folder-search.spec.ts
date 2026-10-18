import {test,expect,_electron,type ElectronApplication,type Page} from '@playwright/test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

// Real host broker, utility backend, MCP and UI; artificial files and no provider keys.
for(const database of ['sqlite','pglite'] as const) test.describe.serial('Attached workspace search ('+database+')',()=>{
 let app:ElectronApplication,page:Page,client:Client,temp:string,workspace:string,attached:string,permissionOnly:string;
 let tools:{name:string}[]=[];
 const root=path.resolve(__dirname,'../../..');
 const invoke=(channel:string,...args:any[])=>page.evaluate(({channel,args})=>(window as any).electronAPI.invoke(channel,...args),{channel,args});
 const panel=(name:string,args:any={})=>invoke('extensions:ai-call-backend-tool',{workspacePath:workspace,callerExtensionId:'com.nimbalyst.memory',toolName:'memory.'+name,args});
 async function call(suffix:string,args:any={}) {
  const name=tools.find(tool=>tool.name.endsWith(suffix))?.name;expect(name).toBeTruthy();
  const result=await client.callTool({name:name!,arguments:args});
  if(result.isError)throw Error(JSON.stringify(result.content));
  return JSON.parse((result.content as any)[0].text);
 }
 async function search(tab:string,query:string) {
  if(!await page.getByTestId('unified-quick-open-search').isVisible())await page.keyboard.press('Control+o');
  await page.locator('.unified-quick-open-tab').getByText(tab,{exact:true}).click();
  await page.getByTestId('unified-quick-open-search').fill(query);
 }
 test.beforeAll(async()=>{
  temp=await fs.mkdtemp(path.join(os.tmpdir(),'nimbalyst-attached-e2e-'));
  workspace=path.join(temp,'main');attached=path.join(temp,'link');permissionOnly=path.join(temp,'permissions-only');
  for(const dir of [workspace,attached,permissionOnly]){await fs.mkdir(path.join(dir,'docs'),{recursive:true});execFileSync('git',['init',dir],{stdio:'ignore',windowsHide:true});}
  await fs.mkdir(path.join(attached,'archive'));await fs.mkdir(path.join(temp,'user'));await fs.mkdir(path.join(temp,'tmp'));
  await fs.mkdir(path.join(workspace,'ignored'));
  await fs.writeFile(path.join(workspace,'.gitignore'),'ignored/\n');
  await fs.writeFile(path.join(workspace,'ignored','Скрытый.md'),'СкрытыйКонтентМаркер');
  await fs.writeFile(path.join(workspace,'docs','Приёмка.md'),'# Primary\nОсновнойПоисковыйМаркер');
  await fs.writeFile(path.join(attached,'docs','Приёмка.md'),'# Attached\nРусский интерфейс. ПодключеннаяПапкаМаркер');
  await fs.writeFile(path.join(attached,'archive','archive.md'),'# Archive\nАрхивПодключеннойПапкиМаркер');
  await fs.mkdir(path.join(temp,'db'));
  if(database==='pglite')await fs.writeFile(path.join(temp,'db','database-backend.json'),JSON.stringify({backend:'pglite',setAt:new Date().toISOString(),setBy:'rollback'}));
  const mainPath=process.env.NIMBALYST_E2E_MAIN_PATH??path.join(root,'packages/electron/out/main/index.js'),isolate=path.join(temp,'isolate.cjs');
  await fs.writeFile(isolate,'const {app}=require("electron");app.setPath("userData",'+JSON.stringify(path.join(temp,'user'))+');app.setPath("appData",'+JSON.stringify(temp)+');app.setAppPath('+JSON.stringify(path.dirname(mainPath))+');require('+JSON.stringify(mainPath)+');');
  const {ELECTRON_RUN_AS_NODE,NODE_PATH,ELECTRON_RENDERER_URL,...clean}=process.env;
  app=await _electron.launch({...(process.env.NIMBALYST_E2E_RECORD_VIDEO==='1'?{recordVideo:{dir:path.join(root,'e2e_test_output/search-results/attached-videos'),size:{width:1280,height:720}}}:{}),...(process.env.NIMBALYST_E2E_APP_PATH?{executablePath:process.env.NIMBALYST_E2E_APP_PATH}:{}),args:[...(process.env.NIMBALYST_E2E_APP_PATH?['--user-data-dir='+path.join(temp,'user')]:[isolate]),'--workspace',workspace],cwd:root,timeout:45000,
   env:{...clean,PLAYWRIGHT:'1',NIMBALYST_CDP_PORT:'0',NIMBALYST_PERMISSION_MODE:'allow-all',NIMBALYST_USER_DATA_DIR:path.join(temp,'user'),NIMBALYST_USER_DATA_PATH:path.join(temp,'db'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',TEMP:path.join(temp,'tmp'),TMP:path.join(temp,'tmp')}});
  page=await app.firstWindow();await page.getByTestId('tracker-mode-button').waitFor();
  expect(realpathSync.native(await app.evaluate(({app})=>app.getPath('userData')))).toBe(realpathSync.native(path.join(temp,'user')));
  await app.evaluate(({session,dialog})=>{
   (globalThis as any).__attachedOpenAI=0;
   session.defaultSession.webRequest.onBeforeRequest({urls:['*://*.openai.com/*','*://openai.com/*']},(_details,cb)=>{(globalThis as any).__attachedOpenAI++;cb({cancel:true});});
   (dialog as any).showMessageBox=async()=>({response:0,checkboxChecked:false});
  });
  expect((await invoke('test:insert-session',{id:'attached-search-agent',workspaceId:workspace,provider:'openai-codex',title:'Attached search probe'})).success).toBe(true);
  expect((await invoke('db:migration:get-status')).activeBackend).toBe(database);
  await invoke('permissions:trustWorkspace',workspace);
  await invoke('extensions:list-installed');await invoke('extensions:set-enabled','com.nimbalyst.memory',true);
  const {port}=await invoke('mcp:get-server-port'),{token}=await invoke('mcp:get-auth-token');
  client=new Client({name:'attached-search-probe',version:'1'},{capabilities:{}});
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+port+'/mcp/ext/memory?workspacePath='+encodeURIComponent(workspace)+'&sessionId=attached-search-agent'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  await invoke('extensions:set-enabled','com.nimbalyst.memory',true);
  await expect.poll(async()=>{tools=(await client.listTools()).tools;return tools.some(tool=>tool.name.endsWith('search_project_knowledge'));},{timeout:30000}).toBe(true);
  // IPC enablement starts the backend; reload lets normal renderer discovery load its settings contribution.
  await page.reload();await page.getByTestId('files-mode-button').waitFor();
 },90000);
 test.afterEach(async({},info)=>{if(page&&info.status!==info.expectedStatus)await page.screenshot({path:info.outputPath('attached-search-failure.png')});});
 test.afterAll(async()=>{await client?.close();if(app){const timer=setTimeout(()=>app.process().kill(),5000);try{await app.close();}finally{clearTimeout(timer);}}});
 test('keeps permission-only directories separate and searches/opens attached files through UI and Memory',async()=>{
  await invoke('permissions:addAdditionalDirectory',workspace,permissionOnly,false);
  expect((await invoke('workspace:get-folders',{workspacePath:workspace})).folders).not.toContain(permissionOnly);
  expect((await invoke('workspace:attach-folder',{workspacePath:workspace,folderPath:attached})).success).toBe(true);
  const roots=await panel('get_source_roots'),link=roots.find((entry:any)=>realpathSync.native(entry.path)===realpathSync.native(attached));expect(link.id).toMatch(/^attached-/);
  await expect.poll(async()=>(await call('search_project_knowledge',{query:'ПодключеннаяПапкаМаркер'})).chunks.length).toBe(1);
  const hit=(await call('search_project_knowledge',{query:'ПодключеннаяПапкаМаркер'})).chunks[0];
  expect(hit.rootLabel).toBe('link');expect(realpathSync.native(hit.refId)).toBe(realpathSync.native(path.join(attached,'docs','Приёмка.md')));
  expect(JSON.stringify(await call('read_doc',{path:hit.sourcePath}))).toContain('ПодключеннаяПапкаМаркер');
  expect((await call('search_project_knowledge',{query:'АрхивПодключеннойПапкиМаркер'})).chunks).toEqual([]);
  await panel('set_sources',{rootId:link.id,include:['archive/**'],exclude:[]});
  expect((await panel('get_sources')).include).toEqual([]);
  expect((await call('search_project_knowledge',{query:'АрхивПодключеннойПапкиМаркер'})).chunks).toHaveLength(1);
  await search('Files','ПРИЕМКА');await expect(page.locator('.files-pane .unified-quick-open-item').filter({hasText:'Приёмка.md'})).toHaveCount(2);
  await search('In Files','русскими интерфейсами');const fileRow=page.locator('.in-files-pane .unified-quick-open-item').filter({hasText:'ПодключеннаяПапкаМаркер'});
  await expect(fileRow).toHaveCount(1);await expect(fileRow.locator('mark')).toContainText('Русский интерфейс');
  await page.mouse.move(1,1);await fileRow.click();await expect(page.locator('.file-tabs-container [contenteditable=true]').filter({visible:true}).first()).toContainText('ПодключеннаяПапкаМаркер');
  await search('Memory','АрхивПодключеннойПапкиМаркер');const memoryRow=page.locator('.memory-search-pane .unified-quick-open-item').filter({hasText:'АрхивПодключеннойПапкиМаркер'});
  await expect(memoryRow).toHaveCount(1);await expect(memoryRow).toContainText('link');await page.mouse.move(2,2);await memoryRow.click();
  await expect(page.locator('.file-tabs-container [contenteditable=true]').filter({visible:true}).first()).toContainText('АрхивПодключеннойПапкиМаркер');
  expect((await invoke('workspace:detach-folder',{workspacePath:workspace,folderPath:attached})).success).toBe(true);
  expect((await call('search_project_knowledge',{query:'АрхивПодключеннойПапкиМаркер'})).chunks).toEqual([]);
  await search('Memory','АрхивПодключеннойПапкиМаркер');await expect(memoryRow).toHaveCount(0);
  // An attached subfolder cannot create a second entity for a primary file.
  expect((await invoke('workspace:attach-folder',{workspacePath:workspace,folderPath:path.join(workspace,'docs')})).success).toBe(true);
  await search('Files','ПРИЕМКА');await expect(page.locator('.files-pane .unified-quick-open-item').filter({hasText:'Приёмка.md'})).toHaveCount(1);
  expect((await call('search_project_knowledge',{query:'ОсновнойПоисковыйМаркер'})).chunks).toHaveLength(1);
  expect((await invoke('workspace:attach-folder',{workspacePath:workspace,folderPath:path.join(workspace,'ignored')})).success).toBe(true);
  await search('Files','Скрытый');await expect(page.locator('.files-pane .unified-quick-open-item').filter({hasText:'Скрытый.md'})).toHaveCount(0);
  await search('In Files','СкрытыйКонтентМаркер');await expect(page.locator('.in-files-pane .unified-quick-open-item')).toHaveCount(0);
  expect(await app.evaluate(()=>(globalThis as any).__attachedOpenAI)).toBe(0);
 },120000);
 test('controls Memory rules from Files and scopes Coverage to an attached folder',async()=>{
  await page.keyboard.press('Escape');
  await fs.writeFile(path.join(workspace,'docs','TreeProbe.md'),'# Tree\nТочечноеДеревоМаркер');
  await fs.writeFile(path.join(workspace,'docs','Neighbor.md'),'# Neighbor\nИсключенныйСоседМаркер');
  await fs.writeFile(path.join(workspace,'CLAUDE.md'),'# Instructions\nСтандартныйИсточникМаркер');
  expect((await invoke('workspace:attach-folder',{workspacePath:workspace,folderPath:attached})).success).toBe(true);
  const link=(await panel('get_source_roots')).find((entry:any)=>realpathSync.native(entry.path)===realpathSync.native(attached));
  await page.getByTestId('files-mode-button').click();
  const showFiles=page.getByRole('button',{name:'Show Files sidebar',exact:true});if(await showFiles.isVisible())await showFiles.click();
  const primaryTreeRoot=page.locator('.file-tree-directory.workspace-root').first();
  if(await primaryTreeRoot.getAttribute('aria-expanded')!=='true')await primaryTreeRoot.click();
  const docs=page.locator('.file-tree-directory').filter({has:page.locator('.file-tree-name',{hasText:/^docs$/})}).first();
  await expect(docs).toBeVisible();
  await expect(docs.locator('.file-tree-icon')).toHaveAttribute('data-memory-index','included');
  await docs.click({button:'right'});await page.getByRole('button',{name:'Exclude from Memory index',exact:true}).click();
  await expect.poll(async()=>(await call('search_project_knowledge',{query:'ТочечноеДеревоМаркер'})).chunks.length).toBe(0);
  const file=page.locator('.file-tree-file').filter({hasText:'TreeProbe.md'}).first();
  if(!await file.isVisible())await docs.click();await expect(file).toBeVisible();
  await file.click({button:'right'});await page.getByRole('button',{name:'Include in Memory index',exact:true}).click();
  await expect.poll(async()=>(await call('search_project_knowledge',{query:'ТочечноеДеревоМаркер'})).chunks.length).toBe(1);
  expect((await call('search_project_knowledge',{query:'ИсключенныйСоседМаркер'})).chunks).toEqual([]);
  await expect(file.locator('.file-tree-icon')).toHaveAttribute('data-memory-index','included');
  const standard=page.locator('.file-tree-file').filter({hasText:'CLAUDE.md'}).first();
  await expect(standard.locator('.file-tree-icon')).toHaveAttribute('data-memory-index','included');
  await search('Memory','ТочечноеДеревоМаркер');await expect(page.locator('.memory-search-pane .unified-quick-open-item').filter({hasText:'ТочечноеДеревоМаркер'})).toHaveCount(1);await page.keyboard.press('Escape');
  await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows().find(window=>!window.isDestroyed())!.webContents.send('open-settings-command',{category:'ext:com.nimbalyst.memory:memory',scope:'project',timestamp:Date.now()});});
  await page.getByTestId('settings-route-ext:com.nimbalyst.memory:memory').click();
  const coverage=page.locator('.nimbalyst-memory-coverage');await expect(coverage).toBeVisible();
  const select=coverage.getByRole('combobox',{name:'Coverage source folder'});await expect(select).toHaveValue('__all__');
  await select.selectOption(link.id);const linked=await panel('status',{rootId:link.id});
  await expect(coverage.getByText('saved chunks',{exact:true}).locator('..')).toContainText(String(linked.chunks));
  await expect(coverage.getByText('Index size',{exact:true})).toHaveCount(0);
  await expect(page.getByText('docs/TreeProbe.md',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Remove include override for docs/TreeProbe.md'}).click();
  await expect.poll(async()=>(await call('search_project_knowledge',{query:'ТочечноеДеревоМаркер'})).chunks.length).toBe(0);
  for(const folder of (await invoke('workspace:get-folders',{workspacePath:workspace})).folders.slice(1))expect((await invoke('workspace:detach-folder',{workspacePath:workspace,folderPath:folder})).success).toBe(true);
  await expect(select).toHaveCount(0);await expect(page.getByRole('combobox',{name:'Source folder',exact:true})).toHaveCount(0);
  await expect(coverage.getByText('Index size',{exact:true})).toBeVisible();
  await page.screenshot({path:test.info().outputPath('memory-coverage-and-overrides.png')});
  await invoke('extensions:set-enabled','com.nimbalyst.memory',false);await page.getByTestId('files-mode-button').click();
  if(await showFiles.isVisible())await showFiles.click();
  await expect(page.locator('.file-tree-icon[data-memory-index="included"]')).toHaveCount(0);
  await docs.click({button:'right'});await expect(page.getByRole('button',{name:'Include in Memory index',exact:true})).toHaveCount(0);await page.keyboard.press('Escape');
  expect(await app.evaluate(()=>(globalThis as any).__attachedOpenAI)).toBe(0);
 },120000);

});
