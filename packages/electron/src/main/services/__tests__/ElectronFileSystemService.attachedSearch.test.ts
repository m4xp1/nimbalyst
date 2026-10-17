// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const state=vi.hoisted(()=>({roots:[] as string[]}));
vi.mock('../../utils/logger',()=>({logger:{ai:{info:vi.fn(),debug:vi.fn(),warn:vi.fn(),error:vi.fn()}}}));
vi.mock('electron',()=>({app:{isPackaged:false}}));
vi.mock('../../utils/store',()=>({getWorkspaceRoots:()=>state.roots}));
import { ElectronFileSystemService } from '../ElectronFileSystemService';
import { dispatchDevAgentTool } from '../../mcp/devAgentTools';

describe('attached folder agent search',()=>{
 it('searches all roots, preserves distinct files, limits globally, and removes detached results',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'attached-search-'));
  const primary=path.join(root,'main'),attached=path.join(root,'link');
  fs.mkdirSync(primary);fs.mkdirSync(attached);fs.writeFileSync(path.join(primary,'same.md'),'ПодключенныйМаркер');fs.writeFileSync(path.join(attached,'same.md'),'ПодключенныйМаркер');
  state.roots=[primary,attached,attached+path.sep];const service=new ElectronFileSystemService(primary);
  try {
   const found=await service.searchFiles('ПодключенныйМаркер');expect(found.success).toBe(true);expect(found.results).toHaveLength(2);
   expect(found.results!.map(r=>r.file)).toContain(path.join(attached,'same.md'));
   expect(await dispatchDevAgentTool('read_file',primary,{path:path.join(attached,'same.md')})).toContain('ПодключенныйМаркер');
   expect(await dispatchDevAgentTool('write_file',primary,{path:path.join(attached,'same.md'),content:'BLOCKED'})).toMatch(/Error/);
   expect((await service.searchFiles('ПодключенныйМаркер',{maxResults:1})).results).toHaveLength(1);
   state.roots=[primary];expect((await service.searchFiles('ПодключенныйМаркер')).results).toHaveLength(1);
   fs.writeFileSync(path.join(primary,'same.md'),'NewMarker');expect((await service.searchFiles('ПодключенныйМаркер')).results).toEqual([]);
  }finally{service.destroy();fs.rmSync(root,{recursive:true,force:true});}
 });
});
