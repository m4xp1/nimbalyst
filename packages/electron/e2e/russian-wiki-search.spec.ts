import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
// Built UI and real MCP, artificial files/profile only, no AI provider.
test.describe.serial('Built Local Wiki Russian search', () => {
 let app: ElectronApplication, page: Page, client: Client, temp: string, workspace: string;
 let tools: {name:string}[] = [];
 const root=path.resolve(__dirname,'../../..');
 async function invoke(channel:string,...args:any[]) {return page.evaluate(({channel,args})=>(window as any).electronAPI.invoke(channel,...args),{channel,args});}
 async function call(suffix:string,args:any) {
  const name=tools.find(t=>t.name.endsWith(suffix))?.name; expect(name).toBeTruthy();
  const r=await client.callTool({name:name!,arguments:args}); if(r.isError)throw new Error(JSON.stringify(r.content));
  const text=(r.content as any)[0].text; return suffix === 'readCollabDoc' ? text : JSON.parse(text);
 }
 test.beforeAll(async()=>{
  temp=await fs.mkdtemp(path.join(os.tmpdir(),'nimbalyst-wiki-search-'));workspace=path.join(temp,'Wiki Russian'); console.log('Artificial Wiki fixture: '+workspace);
  const wiki=path.join(workspace,'nimbalyst-local/wiki'); await fs.mkdir(wiki,{recursive:true}); await fs.mkdir(path.join(temp,'user'));
  execFileSync('git',['init',workspace],{stdio:'ignore',windowsHide:true});
  await fs.writeFile(path.join(wiki,'.nimbalyst-wiki.yaml'),'formatVersion: 1\n');
  await fs.writeFile(path.join(wiki,'Интерфейс.md'),'---\nid: wiki-form\nstatus: draft\n---\n😀 Прие\u0308мка на русском языке. Ёлки. WIKIPROBE624\n');
  await fs.writeFile(path.join(wiki,'Наблюдение.md'),'---\nid: wiki-exact\nstatus: done\n---\nинтерфейсами языками ёлками WIKIPROBE624\n');
  const mainPath=process.env.NIMBALYST_E2E_MAIN_PATH??path.join(root,'packages/electron/out/main/index.js'),isolate=path.join(temp,'isolate.cjs');
  await fs.writeFile(isolate,'const {app}=require("electron");app.setPath("userData",'+JSON.stringify(path.join(temp,'user'))+');app.setPath("appData",'+JSON.stringify(temp)+');app.setAppPath('+JSON.stringify(path.dirname(mainPath))+');require('+JSON.stringify(mainPath)+');');
  const {ELECTRON_RUN_AS_NODE,NODE_PATH,ELECTRON_RENDERER_URL,...clean}=process.env;
  app=await _electron.launch({...(process.env.NIMBALYST_E2E_APP_PATH?{executablePath:process.env.NIMBALYST_E2E_APP_PATH}:{}),args:[...(process.env.NIMBALYST_E2E_APP_PATH?['--user-data-dir='+path.join(temp,'user')]:[isolate]),'--workspace',workspace],cwd:root,timeout:45000,
   env:{...clean,PLAYWRIGHT:'1',NIMBALYST_CDP_PORT:'0',NIMBALYST_PERMISSION_MODE:'allow-all',NIMBALYST_USER_DATA_DIR:path.join(temp,'user'),NIMBALYST_USER_DATA_PATH:path.join(temp,'db'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:''}});
  page=await app.firstWindow(); await page.getByTestId('tracker-mode-button').waitFor();
  expect(await app.evaluate(({app})=>app.getPath('userData'))).toBe(path.join(temp,'user'));
  await app.evaluate(({session})=>{(globalThis as any).__wikiOpenAI=0;session.defaultSession.webRequest.onBeforeRequest({urls:['*://*.openai.com/*','*://openai.com/*']},(_d,cb)=>{(globalThis as any).__wikiOpenAI++;cb({cancel:true});});});
  await invoke('permissions:trustWorkspace',workspace);
  const {port}=await invoke('mcp:get-server-port'),{token}=await invoke('mcp:get-auth-token');
  client=new Client({name:'fake-wiki-search-agent',version:'1'},{capabilities:{}});
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+port+'/mcp/situational?workspacePath='+encodeURIComponent(workspace)),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  tools=(await client.listTools()).tools;
 },60000);
 test.afterEach(async({},info)=>{if(page&&info.status!==info.expectedStatus)await page.screenshot({path:info.outputPath('wiki-search-failure.png')});});
 test.afterAll(async()=>{await client?.close();if(app){const timer=setTimeout(()=>app.process().kill(),5000);try{await app.close();}finally{clearTimeout(timer);}}});
 test('disabled Wiki hides search/read/write tools and navigation before explicit opt-in',async()=>{
  expect(await invoke('extensions:get-enabled','com.nimbalyst.knowledge',false)).toBe(false);
  expect(tools.some(t=>t.name.endsWith('searchPages'))).toBe(false);
  await expect(page.getByTestId('collab-mode-button')).toHaveCount(0);
  const denied=await client.callTool({name:'searchPages',arguments:{section:'personal',query:'WIKIPROBE624'}});
  expect(denied.isError).toBe(true);expect(JSON.stringify(denied.content)).toContain('Wiki is disabled');
  await invoke('extensions:set-enabled','com.nimbalyst.knowledge',true);
  await expect.poll(async()=>{tools=(await client.listTools()).tools;return tools.some(t=>t.name.endsWith('searchPages'));}).toBe(true);
  await expect(page.getByTestId('collab-mode-button')).toBeVisible();
 });
 test('real MCP returns exact before forms and reads the matched current file',async()=>{
  const found=await call('searchPages',{section:'personal',query:'ёлками языками интерфейсами WIKIPROBE624'});
  expect(found.results.map((h:any)=>[h.id,h.keywordMatch])).toEqual([['wiki-exact','exact'],['wiki-form','stem']]);
  const hit=found.results[1];expect(hit.highlights.map((r:any)=>hit.snippet.slice(r.start,r.end))).toContain('языке');
  const read=await call('readCollabDoc',{filePath:hit.uri});expect(JSON.stringify(read)).toContain('WIKIPROBE624');
 });
 test('Wiki UI: forms, NFC, mixed marker, original highlighting and opening',async()=>{
  const button=page.getByTestId('collab-mode-button');await button.click();
  const sidebar=page.getByTestId('collab-sidebar-personal');await sidebar.waitFor();
  await sidebar.getByText('Search',{exact:true}).click();
  const view=page.getByTestId('pages-search-view');await view.waitFor();
  const input=view.getByPlaceholder('Search pages, or type a field name to filter');
  await input.fill('ёлками языками интерфейсами WIKIPROBE624');
  const rows=view.locator('tbody tr');await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Наблюдение');
  const row=view.locator('tr[data-row-id="wiki-form"]');await expect(row.locator('mark')).toContainText(['языке','Ёлки','WIKIPROBE624']);
  await input.fill('ПРИЕМКА');await expect(rows).toHaveCount(1);await expect(rows.first().locator('mark')).toContainText('Прие\u0308мка');
  await input.fill('WIKIPROBE624 языками интерфейсами ёлками');await expect(rows).toHaveCount(2);
  await input.press('Escape');await page.mouse.move(1,1);await row.click();
  await expect(page.locator('[contenteditable=true]').filter({visible:true}).filter({hasText:'WIKIPROBE624'}).first()).toBeVisible();
  expect(await app.evaluate(()=>(globalThis as any).__wikiOpenAI)).toBe(0);
 });
 test('Wiki FILTER BY FIELD: pointer and keyboard choices retain clauses, text and clear',async()=>{
  const button=page.getByTestId('collab-mode-button'); if(await button.getAttribute('aria-pressed')!=='true')await button.click();
  await page.getByTestId('collab-sidebar-personal').getByText('Search',{exact:true}).click();
  const view=page.getByTestId('pages-search-view'),input=view.getByTestId('tracker-filter-omnibox-input'),rows=view.locator('tbody tr');
  await input.fill('');await input.focus();
  await page.getByTestId('tracker-filter-omnibox-option-field:status').click();
  await expect(input).toHaveValue('status:');
  await page.getByTestId('tracker-filter-omnibox-option-value:draft').click();
  await expect(view.getByTestId('tracker-filter-omnibox-pill-0')).toBeVisible();
  await expect(rows).toHaveCount(1);await expect(rows.first()).toHaveAttribute('data-row-id','wiki-form');
  await input.fill('WIKIPROBE624');await expect(rows).toHaveCount(1);await input.press('Escape');
  await view.getByRole('button',{name:'Remove Status filter',exact:true}).click();
  await expect(rows).toHaveCount(2);await expect(input).toHaveValue('WIKIPROBE624');
  await input.fill('WIKIPROBE624 status:done');await input.press('Enter');
  await expect(rows).toHaveCount(1);await expect(rows.first()).toHaveAttribute('data-row-id','wiki-exact');
  await expect(view.getByTestId('tracker-filter-omnibox-pill-0')).toBeVisible();
  await view.getByTestId('tracker-filter-omnibox-clear').click();
  await expect(rows).toHaveCount(2);await expect(input).toHaveValue('');
  await expect(view.getByTestId('tracker-filter-omnibox-pill-0')).toHaveCount(0);
 });

 test('disabling Wiki refreshes the connected client, denies cached tools and preserves files',async()=>{
  const names=['listPages','searchPages','readCollabDoc','applyCollabDocEdit','createSharedDoc','createSharedFolder','importFileToPages','renameSharedItem','moveSharedItem','deleteSharedItem','setPageFields','setPageType','readCollabDocComments','createCollabDocComment','replyToCollabDocComment'];
  let notifications=0;const {ToolListChangedNotificationSchema}=await import('@modelcontextprotocol/sdk/types.js');
  client.setNotificationHandler(ToolListChangedNotificationSchema,()=>{notifications++;});
  await invoke('extensions:set-enabled','com.nimbalyst.knowledge',false);
  await expect.poll(()=>notifications).toBeGreaterThan(0);
  for(const name of names){
   const denied=await client.callTool({name,arguments:{section:'personal',query:'WIKIPROBE624',filePath:'personal://wiki-form'}});
   expect(denied.isError,name).toBe(true);expect(JSON.stringify(denied.content),name).toContain('Wiki is disabled');
  }
  tools=(await client.listTools()).tools;
  expect(tools.filter(t=>names.includes(t.name))).toEqual([]);
  await expect(page.getByTestId('collab-mode-button')).toHaveCount(0);
  await page.reload();await page.getByTestId('tracker-mode-button').waitFor();
  await expect(page.getByTestId('collab-mode-button')).toHaveCount(0);
  // Settings-agent route writes the same persisted setting as the UI toggle.
  const {port}=await invoke('mcp:get-server-port'),{token}=await invoke('mcp:get-auth-token');
  const host=new Client({name:'fake-wiki-settings-agent',version:'1'},{capabilities:{}});
  try{
   await host.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+port+'/mcp/host?workspacePath='+encodeURIComponent(workspace)),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
   const name=(await host.listTools()).tools.find(t=>t.name.endsWith('extension_set_enabled'))!.name;
   const enabled=await host.callTool({name,arguments:{extensionId:'com.nimbalyst.knowledge',enabled:true}});expect(enabled.isError).not.toBe(true);
   await expect(page.getByTestId('collab-mode-button')).toBeVisible();
   await expect.poll(async()=>{tools=(await client.listTools()).tools;return tools.some(t=>t.name==='searchPages');}).toBe(true);
   const found=await call('searchPages',{section:'personal',query:'WIKIPROBE624'});expect(found.results).toHaveLength(2);
   await host.callTool({name,arguments:{extensionId:'com.nimbalyst.knowledge',enabled:false}});
   await expect(page.getByTestId('collab-mode-button')).toHaveCount(0);
   expect((await client.listTools()).tools.some(t=>t.name==='searchPages')).toBe(false);
  }finally{await host.close();}
  expect(await fs.readFile(path.join(workspace,'nimbalyst-local/wiki/Интерфейс.md'),'utf8')).toContain('WIKIPROBE624');
 });

});
