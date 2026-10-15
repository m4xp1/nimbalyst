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
  await fs.writeFile(path.join(wiki,'Интерфейс.md'),'---\nid: wiki-form\n---\n😀 Прие\u0308мка на русском языке. Ёлки. WIKIPROBE624\n');
  await fs.writeFile(path.join(wiki,'Наблюдение.md'),'---\nid: wiki-exact\n---\nинтерфейсами языками ёлками WIKIPROBE624\n');
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
  await expect.poll(async()=>{tools=(await client.listTools()).tools;return tools.some(t=>t.name.endsWith('searchPages'));},{timeout:30000}).toBe(true);
 },60000);
 test.afterEach(async({},info)=>{if(page&&info.status!==info.expectedStatus)await page.screenshot({path:info.outputPath('wiki-search-failure.png')});});
 test.afterAll(async()=>{await client?.close();if(app){const timer=setTimeout(()=>app.process().kill(),5000);try{await app.close();}finally{clearTimeout(timer);}}});
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
});
