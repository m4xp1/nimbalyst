import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitSandboxEnv, assertGitSandbox } from '../src/main/services/testSupport/gitTestSandbox';
const root=path.resolve(__dirname,'../../..');
let app:ElectronApplication|undefined,page:Page,temp:string,repo:string,bare:string,external:string,releaseMarker:string|undefined;
const git=(args:string[],cwd=repo)=>{if(!['init','clone'].includes(args[0])&&cwd!==temp&&cwd!==bare)assertGitSandbox(cwd,temp);return execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true,env:gitSandboxEnv(temp)}).trim();};
const invoke=(channel:string,...args:unknown[])=>page.evaluate(({channel,args})=>(window as any).electronAPI.invoke(channel,...args),{channel,args});
async function commit(content:string,cwd=repo){await fs.writeFile(path.join(cwd,'fixture.txt'),content);git(['add','fixture.txt'],cwd);git(['-c','user.name=Test User','-c','user.email=test@example.com','-c','commit.gpgsign=false','commit','-qm',content],cwd);}
async function close(){if(!app)return;const current=app;app=undefined;const timer=setTimeout(()=>current.process().kill(),5000);try{await current.close();}finally{clearTimeout(timer);}}
async function launch(){
 const main=process.env.NIMBALYST_E2E_MAIN_PATH??path.join(root,'packages/electron/out/main/index.js');
 const isolate=path.join(temp,'isolate.cjs'),user=path.join(temp,'profile'),processTemp=path.join(temp,'process-temp');await fs.mkdir(processTemp,{recursive:true});const extensions=path.join(processTemp,'nimbalyst-test-extensions','extensions');await fs.mkdir(extensions,{recursive:true});
 await fs.writeFile(isolate,'const {app}=require("electron");app.setPath("userData",'+JSON.stringify(user)+');app.setPath("appData",'+JSON.stringify(temp)+');app.setAppPath('+JSON.stringify(path.dirname(main))+');require('+JSON.stringify(main)+');');
 const {ELECTRON_RUN_AS_NODE,NODE_PATH,ELECTRON_RENDERER_URL,NIMBALYST_RELEASE_CHANNEL,...env}=process.env;for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key];
 app=await _electron.launch({...(process.env.NIMBALYST_E2E_APP_PATH?{executablePath:process.env.NIMBALYST_E2E_APP_PATH}:{}),args:[...(process.env.NIMBALYST_E2E_APP_PATH?['--user-data-dir='+user]:[isolate]),'--workspace',repo],cwd:root,timeout:45000,
 env:{...env,TEMP:processTemp,TMP:processTemp,GIT_CONFIG_GLOBAL:path.join(temp,'absent-global'),GIT_CONFIG_SYSTEM:path.join(temp,'absent-system'),GIT_CEILING_DIRECTORIES:temp,PLAYWRIGHT:'1',NIMBALYST_RELEASE_CHANNEL:'stable',NIMBALYST_CDP_PORT:'0',NIMBALYST_PERMISSION_MODE:'allow-all',NIMBALYST_USER_DATA_DIR:user,NIMBALYST_USER_DATA_PATH:path.join(temp,'db'),NIMBALYST_E2E_EXTENSIONS_DIR:extensions,OPENAI_API_KEY:'',ANTHROPIC_API_KEY:''}});
 if(process.env.NIMBALYST_E2E_APP_PATH)expect(await app.evaluate(({app})=>app.getVersion())).toBe(JSON.parse(await fs.readFile(path.join(root,'packages/electron/package.json'),'utf8')).version);
 page=await app.firstWindow();await page.getByTestId('tracker-mode-button').waitFor();expect(realpathSync.native(await app.evaluate(({app})=>app.getPath('userData')))).toBe(realpathSync.native(user));await invoke('permissions:trustWorkspace',repo);await page.getByTestId('files-mode-button').click();
}
test.afterAll(async()=>{if(releaseMarker)await fs.writeFile(releaseMarker,'release on teardown').catch(()=>undefined);await close();});
test('two aliases: Push clears ahead, concurrent new commit remains ahead, startup fetch discovers behind without Pull',async()=>{
 test.setTimeout(180000);temp=realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(),'nim-git-sync-e2e-')));repo=path.join(temp,'repo');bare=path.join(temp,'remote.git');external=path.join(temp,'external');await fs.mkdir(repo);await fs.mkdir(path.join(temp,'extensions'));
 git(['init','--bare',bare],temp);git(['init','-b','main']);await commit('baseline');git(['remote','add','origin',bare]);git(['remote','add','helper',bare]);git(['push','-u','helper','main']);git(['fetch','origin']);git(['clone','-b','main',bare,external],temp);await commit('first local');
 await launch();const top=()=>page.getByTestId('window-top-bar-git-status');await expect(top().getByLabel('1 ahead',{exact:true})).toBeVisible();
 await top().click();await expect(page.getByTestId('git-sync-details')).toContainText('Push: helper/main');await page.getByRole('menuitem',{name:/Push$/}).click();
 await expect(page.getByRole('menuitem',{name:/Push$/})).toBeEnabled();await expect(top().getByLabel('1 ahead',{exact:true})).toHaveCount(0);expect((await invoke('git:status',repo)).ahead).toBe(0);expect(git(['rev-parse','HEAD'])).toBe(git(['rev-parse','refs/heads/main'],bare));await page.keyboard.press('Escape');
 const hooks=path.join(temp,'hooks'),marker=path.join(temp,'push-started').replace(/\\/g,'/'),release=path.join(temp,'push-release').replace(/\\/g,'/');releaseMarker=release;await fs.mkdir(hooks);await fs.writeFile(path.join(hooks,'pre-push'),'#!/bin/sh\necho started > "'+marker+'"\nwhile [ ! -f "'+release+'" ]; do sleep 0.1; done\n',{mode:0o755});git(['config','core.hooksPath',hooks]);await commit('sent during push');
 await expect(top().getByLabel('1 ahead',{exact:true})).toBeVisible();await top().click();await page.getByRole('menuitem',{name:/Push$/}).click();await expect.poll(()=>existsSync(marker)).toBe(true);const sent=git(['rev-parse','HEAD']);await commit('new during push');await fs.writeFile(release,'release');
 await expect(page.getByRole('menuitem',{name:/Push$/})).toBeEnabled();await expect(top().getByLabel('1 ahead',{exact:true})).toBeVisible();expect(git(['rev-parse','refs/heads/main'],bare)).toBe(sent);expect((await invoke('git:status',repo)).ahead).toBe(1);
 git(['config','--unset','core.hooksPath']);await page.getByRole('menuitem',{name:/Push$/}).click();await expect(top().getByLabel('1 ahead',{exact:true})).toHaveCount(0);await close();
 git(['pull','--ff-only'],external);await commit('external remote change',external);git(['push'],external);const unchanged=git(['rev-parse','HEAD']);await launch();await expect(top().getByLabel('1 behind',{exact:true})).toBeVisible();expect(git(['rev-parse','HEAD'])).toBe(unchanged);
 await top().click();await expect(page.getByTestId('git-sync-details')).toContainText('Pull: helper/main');await page.keyboard.press('Escape');await page.keyboard.press('Control+Shift+G');await expect(page.locator('.git-log-remote-status').first()).toHaveText('↑0 ↓1');
});
