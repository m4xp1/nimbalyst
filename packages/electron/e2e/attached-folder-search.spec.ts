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
  await fs.writeFile(path.join(workspace,'docs','Приёмка.md'),'# Primary\nОсновнойПоисковыйМаркер');
  await fs.writeFile(path.join(attached,'docs','Приёмка.md'),'# Attached\nРусский интерфейс. ПодключеннаяПапкаМаркер');
  await fs.writeFile(path.join(attached,'archive','archive.md'),'# Archive\nАрхивПодключеннойПапкиМаркер');
  await fs.mkdir(path.join(temp,'db'));
  if(database==='pglite')await fs.writeFile(path.join(temp,'db','database-backend.json'),JSON.stringify({backend:'pglite',setAt:new Date().toISOString(),setBy:'rollback'}));
  const mainPath=process.env.NIMBALYST_E2E_MAIN_PATH??path.join(root,'packages/electron/out/main/index.js'),isolate=path.join(temp,'isolate.cjs');
  await fs.writeFile(isolate,'const {app}=require("electron");app.setPath("userData",'+JSON.stringify(path.join(temp,'user'))+');app.setPath("appData",'+JSON.stringify(temp)+');app.setAppPath('+JSON.stringify(path.dirname(mainPath))+');require('+JSON.stringify(mainPath)+');');
  const {ELECTRON_RUN_AS_NODE,NODE_PATH,ELECTRON_RENDERER_URL,...clean}=process.env;
  app=await _electron.launch({...(process.env.NIMBALYST_E2E_APP_PATH?{executablePath:process.env.NIMBALYST_E2E_APP_PATH}:{}),args:[...(process.env.NIMBALYST_E2E_APP_PATH?['--user-data-dir='+path.join(temp,'user')]:[isolate]),'--workspace',workspace],cwd:root,timeout:45000,
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
  expect(await app.evaluate(()=>(globalThis as any).__attachedOpenAI)).toBe(0);
 },120000);
});
