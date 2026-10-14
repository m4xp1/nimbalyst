// @vitest-environment node
import {describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {SQLiteDatabase} from '../../database/sqlite/SQLiteDatabase';
import {createSQLiteStoreAdapter} from '../../database/sqlite/SQLiteStoreAdapter';
import {MemoryEngine} from '../../../../../extensions/nimbalyst-memory/engine/src/engine';
import {FakeEmbedder} from '../../../../../extensions/nimbalyst-memory/engine/src/__tests__/fakeEmbedder';
import {TranscriptRuntime} from '@nimbalyst/runtime/ai/server/transcript/TranscriptRuntime';
import {TranscriptMigrationRepository} from '@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository';
const h=vi.hoisted(()=>({db:null as any}));
vi.mock('../../database/PGLiteDatabaseWorker',()=>({database:{isInitialized:()=>true,query:(sql:string,params:any[])=>h.db.query(sql,params)}}));
import {createRawMessageStoreAdapter} from '../TranscriptMigrationAdapters';
import {createPGLiteAgentMessagesStore} from '../PGLiteAgentMessagesStore';
import {readMemorySessionContent} from '../sessionMemoryContent';
import {watchSessionMemoryChanges} from '../sessionMemoryEvents';
import {ExternalSessionPersistence} from '../externalSessions/ExternalSessionPersistence';
import {runTransactionStatements} from '../../database/transactionStatements';

describe('persisted session dialogue → actual search on both databases',()=>{
  it.each(['sqlite','pglite'])('reads all keyset pages, excludes hidden text, and preserves a rebuilt %s index after restart',async(kind)=>{
    const root=mkdtempSync(path.join(tmpdir(),'session-sql-search-'));
    let close:()=>Promise<void>,engine:MemoryEngine|undefined;
    let notices=0;const unsubscribe=watchSessionMemoryChanges(()=>notices++);
    try {
      if(kind==='sqlite') {
        const db=new SQLiteDatabase({dbDir:path.join(root,'db'),schemaDir:path.resolve(__dirname,'../../database/sqlite/schemas'),log:()=>{}});
        await db.initialize();h.db=createSQLiteStoreAdapter(db);close=()=>db.close();
      } else {
        const db=new PGlite();await db.exec(`CREATE TABLE ai_sessions(id TEXT PRIMARY KEY,workspace_id TEXT,title TEXT,provider TEXT,provider_session_id TEXT,updated_at TIMESTAMPTZ,is_archived BOOLEAN DEFAULT FALSE);
          CREATE TABLE external_session_cursors(provider TEXT,external_id TEXT,file_path TEXT,workspace_path TEXT,session_id TEXT,cursor TEXT,PRIMARY KEY(provider,external_id,file_path));
          CREATE TABLE ai_agent_messages(id SERIAL PRIMARY KEY,session_id TEXT,source TEXT,direction TEXT,content TEXT,metadata JSONB,hidden BOOLEAN,created_at TIMESTAMPTZ,provider_message_id TEXT,searchable BOOLEAN,searchable_text TEXT,message_kind TEXT);`);
        h.db={query:(sql:string,params:any[])=>db.query(sql,params),runTransaction:(statements:any[])=>db.transaction(tx=>runTransactionStatements(tx,statements))};close=()=>db.close();
      }
      await h.db.query('INSERT INTO ai_sessions(id,workspace_id,title,provider) VALUES($1,$2,$3,$4)',['sql',root,'SQL dialogue','openai-codex']);
      const store=createPGLiteAgentMessagesStore(h.db);
      const messages=Array.from({length:502},(_,i)=>({sessionId:'sql',source:'openai-codex',direction:'input' as const,
        content:JSON.stringify({prompt:i===0?'ПервыйМаркер':i===250?'СреднийМаркер':i===500?'ПоследнийМаркер':'Обычная реплика '+i}),
        hidden:i===501,metadata:{transport:'app-server'},createdAt:new Date(1700000000000+i)}));
      messages[501].content=JSON.stringify({prompt:'СкрытыйМаркер'});
      await store.createMany!(messages);expect(notices).toBe(1);
      const runtime=new TranscriptRuntime(createRawMessageStoreAdapter());
      const {text}=await readMemorySessionContent({id:'sql',provider:'openai-codex'} as any,runtime);
      expect(text).not.toContain('СкрытыйМаркер');
      const config={root,dbPath:path.join(root,'memory.db'),factsDir:'facts',sources:[]};
      engine=MemoryEngine.create(config,new FakeEmbedder());
      await engine.ingestRecords([{id:'session:sql',refId:'sql',refType:'session',sourceClass:'sessions',text}]);
      engine.completeSessionProjection(2,{'session:sql':null});
      for(const marker of ['ПервыйМаркер','СреднийМаркер','ПоследнийМаркер']) {
        expect((await engine.search(marker,50)).filter(h=>h.signals?.sparse).map(h=>h.refId)).toEqual(['sql']);
      }
      await engine.close();engine=MemoryEngine.create(config,new FakeEmbedder());
      expect(engine.expand('session:sql',[])?.text).toContain('ПоследнийМаркер');
      await new ExternalSessionPersistence(h.db).appendAndAdvance({sessionId:'sql',ref:{providerId:'openai-codex',externalId:'sql',workspacePath:root,filePath:'/synthetic/rollout.jsonl'},expectedCursor:null,cursor:{byteOffset:1,fileSize:1,inode:1,lastEntryUuid:'import1'},messages:[{source:'openai-codex',direction:'output',content:JSON.stringify({method:'item/completed',params:{item:{id:'import1',type:'agentMessage',text:'ИмпортОтветМаркер'}}}),providerMessageId:'import1',metadata:{transport:'app-server'},createdAt:new Date()}]});
      expect(notices).toBe(2);
      const updated=await readMemorySessionContent({id:'sql',provider:'openai-codex'} as any,runtime);
      await engine.ingestRecords([{id:'session:sql',refId:'sql',refType:'session',sourceClass:'sessions',text:updated.text}]);
      expect((await engine.search('ИмпортОтветМаркер',50)).filter(hit=>hit.signals?.sparse)).toHaveLength(1);
    } finally {unsubscribe();TranscriptMigrationRepository.clearService();await engine?.close();await close!?.();rmSync(root,{recursive:true,force:true});}
  },30000);
});
