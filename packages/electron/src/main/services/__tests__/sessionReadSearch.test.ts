// @vitest-environment node
import {describe,it,expect,vi} from 'vitest';
vi.mock('../../utils/store',()=>({getAppSetting:()=>true}));
import {MemorySessionReader} from '../MemorySessionReader';
describe('current session retrieval after Memory search',()=>{
 it('pages all Unicode dialogue from a stable snapshot while a fresh read sees newer messages',async()=>{
  let text='## User\n\n'+('Русский😀маркер '.repeat(4000))+'\n\n## Assistant\n\nОтвет';
  const original=text;
  const reader=new MemorySessionReader({enabled:()=>true,list:async(ws)=>ws==='one'?[{id:'s',parentSessionId:'p'} as any]:[],read:async()=>({text,parentSessionId:'p'}),now:()=>0});
  let page=await reader.read('one',{sessionId:'s',maxChars:1001});const version=page.snapshotVersion;
  let joined=page.text;text+='\nНоваяРеплика';
  await expect(reader.read('other',{sessionId:'s',cursor:page.nextCursor!})).rejects.toThrow();
  while(page.hasMore){
   expect(page.text).not.toMatch(/[\uD800-\uDBFF]$/);
   page=await reader.read('one',{sessionId:'s',cursor:page.nextCursor!,maxChars:1001});
   expect(page.snapshotVersion).toBe(version);joined+=page.text;
  }
  expect(joined).toBe(original);expect(page.parentSessionId).toBe('p');
  expect((await reader.read('one',{sessionId:'s',maxChars:24000})).snapshotVersion).not.toBe(version);
 });
 it('rejects disabled, archived, deleted, expired, wrong-session and revoked cursors, and propagates read errors',async()=>{
  let enabled=true,now=0,metas:any[]=[{id:'s'}];
  const read=vi.fn(async()=>({text:'x'.repeat(25000),parentSessionId:null}));
  const reader=new MemorySessionReader({enabled:()=>enabled,list:async()=>metas,read,now:()=>now});
  const request={sessionId:'s',maxChars:1000};
  const page=await reader.read('one',request);const cursor=page.nextCursor!;
  await expect(reader.read('one',{sessionId:'different',cursor})).rejects.toThrow();
  await expect(reader.read('one',{sessionId:'s',cursor:'invalid'})).rejects.toThrow();
  now=600001;await expect(reader.read('one',{sessionId:'s',cursor})).rejects.toThrow(/expired/i);
  now=0;const fresh=await reader.read('one',request);enabled=false;
  await expect(reader.read('one',{sessionId:'s',cursor:fresh.nextCursor!})).rejects.toThrow(/disabled/i);enabled=true;
  metas[0].isArchived=true;await expect(reader.read('one',request)).rejects.toThrow();
  metas=[];await expect(reader.read('one',request)).rejects.toThrow();metas=[{id:'s'}];
  reader.invalidate('one');await expect(reader.read('one',{sessionId:'s',cursor:fresh.nextCursor!})).rejects.toThrow();
  read.mockRejectedValueOnce(new Error('reader failed'));await expect(reader.read('one',request)).rejects.toThrow(/reader failed/);
  for(const maxChars of [999,24001,NaN,1.5])await expect(reader.read('one',{sessionId:'s',maxChars})).rejects.toThrow();
 });
});
