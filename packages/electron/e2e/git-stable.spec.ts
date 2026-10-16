import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitSandboxEnv, assertGitSandbox, FIXTURE_AUTHOR } from '../src/main/services/testSupport/gitTestSandbox';

// Real extension loader, panel and Git. Every write stays in fresh artificial repos.
// Optional local fixture exercises the owner's installed Marketplace distribution,
// copied read-only into the isolated profile. CI uses the shipped distribution with
// its Alpha requirement restored to reproduce a Marketplace override's channel gate.
for (const marketplace of [true, false]) {
 test.describe.serial(marketplace ? 'Stable Marketplace Git' : 'Stable builtin Git', () => {
  let app: ElectronApplication, page: Page, temp: string, workspace: string, userExtensions: string;
  let selectedVersion: string;
  const root = path.resolve(__dirname, '../../..');
  const git = (args: string[], cwd = workspace) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: gitSandboxEnv(temp) }).trim();
  const invoke = (channel: string, ...args: unknown[]) => page.evaluate(({ channel, args }) => (window as any).electronAPI.invoke(channel, ...args), { channel, args });
  async function launch() {
   const main = process.env.NIMBALYST_E2E_MAIN_PATH ?? path.join(root, 'packages/electron/out/main/index.js');
   const isolate = path.join(temp, 'isolate.cjs');
   await fs.writeFile(isolate, 'const {app}=require("electron");app.setPath("userData",'+JSON.stringify(path.join(temp,'user'))+');app.setPath("appData",'+JSON.stringify(temp)+');app.setAppPath('+JSON.stringify(path.dirname(main))+');require('+JSON.stringify(main)+');');
   const { ELECTRON_RUN_AS_NODE, NODE_PATH, ELECTRON_RENDERER_URL, NIMBALYST_RELEASE_CHANNEL, ...clean } = process.env;
   for(const key of Object.keys(clean))if(key.startsWith('GIT_'))delete clean[key];
   app = await _electron.launch({ ...(process.env.NIMBALYST_E2E_APP_PATH ? {executablePath:process.env.NIMBALYST_E2E_APP_PATH} : {}),
    args: [...(process.env.NIMBALYST_E2E_APP_PATH ? ['--user-data-dir='+path.join(temp,'user')] : [isolate]), '--workspace', workspace], cwd:root,timeout:45000,
    env: {...clean,TEMP:realpathSync.native(os.tmpdir()),TMP:realpathSync.native(os.tmpdir()),GIT_CEILING_DIRECTORIES:temp,PLAYWRIGHT:'1',NIMBALYST_RELEASE_CHANNEL:'stable',NIMBALYST_CDP_PORT:'0',NIMBALYST_PERMISSION_MODE:'allow-all',NIMBALYST_USER_DATA_DIR:path.join(temp,'user'),NIMBALYST_USER_DATA_PATH:path.join(temp,'db'),NIMBALYST_E2E_EXTENSIONS_DIR:userExtensions,OPENAI_API_KEY:'',ANTHROPIC_API_KEY:''} });
   page = await app.firstWindow(); await page.getByTestId('tracker-mode-button').waitFor();
   // Windows may canonicalize the temp root to its short spelling.
   expect(realpathSync.native(await app.evaluate(({app})=>app.getPath('userData')))).toBe(realpathSync.native(path.join(temp,'user')));
   await invoke('permissions:trustWorkspace', workspace);
   await page.getByTestId('files-mode-button').click();
  }
  async function close() { if (!app) return; const timer=setTimeout(()=>app.process().kill(),5000);try{await app.close();}finally{clearTimeout(timer);} }
  async function openPanel() {
   await page.keyboard.press('Control+Shift+G');
   await expect(page.locator('.git-log-panel')).toBeVisible();
  }
  test.beforeAll(async () => {
   temp = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(),'nimbalyst-git-stable-')));
   workspace=path.join(temp,'Git artificial');userExtensions=path.join(temp,'extensions');
   await fs.mkdir(workspace);await fs.mkdir(userExtensions);await fs.mkdir(path.join(temp,'user'));
   git(['init','-b','main']);assertGitSandbox(workspace,temp);git(['config','user.name',FIXTURE_AUTHOR.name]);git(['config','user.email',FIXTURE_AUTHOR.email]);git(['config','commit.gpgsign','false']);git(['config','core.autocrlf','false']);
   for (const name of ['picked.txt','staged.txt','unstaged.txt']) await fs.writeFile(path.join(workspace,name),'original\n');
   git(['add','.']);git(['-c','core.hooksPath='+path.join(temp,'no-hooks'),'commit','-m','fixture baseline']);
   if (marketplace) {
    const source = process.env.NIMBALYST_GIT_EXTENSION_FIXTURE ?? (process.env.NIMBALYST_E2E_APP_PATH ? path.join(path.dirname(process.env.NIMBALYST_E2E_APP_PATH),'resources/extensions/git') : path.join(root,'packages/extensions/git'));
    const destination=path.join(userExtensions,'com.nimbalyst.git');await fs.mkdir(destination);
    await fs.copyFile(path.join(source,'manifest.json'),path.join(destination,'manifest.json'));
    await fs.cp(path.join(source,'dist'),path.join(destination,'dist'),{recursive:true});
    const manifest=JSON.parse(await fs.readFile(path.join(destination,'manifest.json'),'utf8'));expect(manifest.id).toBe('com.nimbalyst.git');selectedVersion=manifest.version;
    manifest.requiredReleaseChannel='alpha';await fs.writeFile(path.join(destination,'manifest.json'),JSON.stringify(manifest));
   }
   // A valid, different Alpha extension must still be excluded.
   const other=path.join(userExtensions,'other-alpha');await fs.mkdir(other);
   await fs.writeFile(path.join(other,'manifest.json'),JSON.stringify({id:'com.example.alpha',name:'Other Alpha',version:'1.0.0',main:'index.js',requiredReleaseChannel:'alpha'}));
   await fs.writeFile(path.join(other,'index.js'),'export function activate() {}');
   await launch();
  },60000);
  test.afterAll(close);
  test('registers exactly one Git, opens from menu and shortcut, survives restart and explicit disable', async () => {
   const installed=await invoke('extensions:list-installed');
   // list-installed returns the extension array directly.
   const entries=Array.isArray(installed)?installed:installed.data;
   const copies=entries.filter((entry:any)=>entry.id==='com.nimbalyst.git');
   expect(copies).toHaveLength(1);expect(copies[0].isBuiltin).toBe(!marketplace);
   if(marketplace)expect(copies[0].manifest.version).toBe(selectedVersion);
   expect(entries.some((entry:any)=>entry.id==='com.example.alpha')).toBe(false);
   await expect(page.getByTestId('window-top-bar-git-status')).toBeVisible();
   await page.getByTestId('window-top-bar-git-status').click();
   const open=page.getByRole('menuitem',{name:/Open Git Log/});await expect(open).toBeEnabled();await open.click();
   await expect(page.locator('.git-log-panel')).toBeVisible();await expect(page.locator('.git-log-panel')).toHaveCount(1);
   await page.keyboard.press('Escape');await page.keyboard.press('Control+Shift+G');await expect(page.locator('.git-log-panel')).not.toBeVisible();await openPanel();
   await close();await launch();await openPanel();
   await invoke('extensions:set-enabled','com.nimbalyst.git',false);await close();await launch();
   await page.getByTestId('window-top-bar-git-status').click();await expect(page.getByRole('menuitem',{name:/Open Git Log/})).toBeDisabled();await page.keyboard.press('Escape');
   await invoke('extensions:set-enabled','com.nimbalyst.git',true);await close();await launch();await openPanel();
  },180000);
  test('panel commits exactly the selection and reports hook failure without losing other edits', async () => {
   const panel=page.locator('.git-log-panel');if(!await panel.isVisible())await openPanel();await panel.getByRole('button',{name:/^Changes/}).click();
   await fs.writeFile(path.join(workspace,'staged.txt'),'keep staged\n');git(['add','staged.txt']);
   await fs.writeFile(path.join(workspace,'unstaged.txt'),'keep unstaged\n');await fs.writeFile(path.join(workspace,'picked.txt'),'selected change\n');
   await panel.getByTitle('Refresh',{exact:true}).click();
   await panel.getByRole('checkbox',{name:'picked.txt',exact:true}).check();
   await panel.getByPlaceholder('Summary (required)').fill('fixture selected commit');
   await panel.getByRole('button',{name:'Commit (1)',exact:true}).click();
   await expect.poll(()=>git(['log','-1','--format=%s'])).toBe('fixture selected commit');
   expect(git(['diff-tree','--no-commit-id','--name-only','-r','HEAD'])).toBe('picked.txt');
   expect(git(['diff','--cached','--name-only'])).toBe('staged.txt');expect(git(['diff','--name-only'])).toBe('unstaged.txt');
   const before=git(['rev-parse','HEAD']);const hooks=path.join(temp,'reject-hooks');await fs.mkdir(hooks);
   await fs.writeFile(path.join(hooks,'pre-commit'),'#!/bin/sh\necho GITFIXTURE_HOOK_REJECT >&2\nexit 1\n',{mode:0o755});git(['config','core.hooksPath',hooks]);
   await fs.writeFile(path.join(workspace,'picked.txt'),'hook must reject\n');await panel.getByTitle('Refresh',{exact:true}).click();
   const checkbox=panel.getByRole('checkbox',{name:'picked.txt',exact:true});await checkbox.check();await panel.getByPlaceholder('Summary (required)').fill('must not commit');
   await panel.getByRole('button',{name:'Commit (1)',exact:true}).click();
   await expect(panel).toContainText(/Failed \(exit 1\)|GITFIXTURE_HOOK_REJECT/);
   await panel.getByRole('button',{name:/^Output/}).click();await expect(panel).toContainText('GITFIXTURE_HOOK_REJECT');expect(git(['rev-parse','HEAD'])).toBe(before);
   expect(await fs.readFile(path.join(workspace,'picked.txt'),'utf8')).toBe('hook must reject\n');expect(git(['diff','--cached','--name-only'])).toBe('staged.txt');
   git(['config','--unset','core.hooksPath']);
  },60000);
 });
}
