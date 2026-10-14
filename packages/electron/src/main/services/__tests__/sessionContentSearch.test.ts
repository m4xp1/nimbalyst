// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../extensions/PrivilegedExtensionHost',()=>({getPrivilegedExtensionHost:()=>({})}));
vi.mock('../../window/WindowManager',()=>({documentServices:new Map()}));
vi.mock('../../utils/store',()=>({getAppSetting:()=>true,setAppSetting:()=>{}}));
import { TranscriptRuntime } from '@nimbalyst/runtime/ai/server/transcript/TranscriptRuntime';
import { TranscriptMigrationRepository } from '@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import type { RawMessage } from '@nimbalyst/runtime/ai/server/transcript/TranscriptTransformer';
import { readMemorySessionContent } from '../sessionMemoryContent';

afterEach(() => { TranscriptMigrationRepository.clearService(); AgentMessagesRepository.clearStore(); });
function setup(provider = 'openai-codex') {
  const rows: RawMessage[] = [];
  AgentMessagesRepository.setStore({create:async()=>{},list:async(_id,opts)=>rows.filter(r=>!r.hidden).slice(opts?.offset??0,(opts?.offset??0)+(opts?.limit??rows.length))});
  const runtime = new TranscriptRuntime({ getMessages: async (_id, after = 0) => rows.filter(r => r.id > after) });
  TranscriptMigrationRepository.setService(runtime as any);
  const append = (content: unknown, direction: 'input' | 'output', hidden = false) => rows.push({
    id: rows.length + 1, sessionId: 's1', source: provider, direction,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    createdAt: new Date(1700000000000 + rows.length), hidden,
    metadata: provider === 'openai-codex' ? {transport: 'app-server'} : {},
  });
  return {append, meta: {id:'s1',title:'Chat',provider,parentSessionId:'parent'} as any};
}
describe('normalized session content for Memory search', () => {
  it('includes Codex replies once and reads newly persisted messages after an empty snapshot', async () => {
    const {append,meta} = setup();
    expect((await readMemorySessionContent(meta)).text).toBe('');
    append({prompt:'РусскийМаркерНачало'},'input');
    append({method:'item/completed',params:{item:{id:'a1',type:'agentMessage',text:'ОтветМаркерКонец'}}},'output');
    append({method:'item/completed',params:{item:{id:'tool1',type:'commandExecution',command:'СлужебныйМаркер'}}},'output');
    append({prompt:'СкрытыйМаркер'},'input',true);
    const result = await readMemorySessionContent(meta);
    expect(result.text).toContain('РусскийМаркерНачало');
    expect(result.text.match(/ОтветМаркерКонец/g)).toHaveLength(1);
    expect(result.text).not.toMatch(/СлужебныйМаркер|СкрытыйМаркер/);
    expect(result.parentSessionId).toBe('parent');
  });
  it('does not cut the beginning, middle or end of histories beyond former raw-row and text caps', async () => {
    const {append,meta} = setup('claude-code');
    append({prompt:'НачалоДиалога'},'input');
    for(let i=0;i<75;i++) append({prompt:`${i} ${'я'.repeat(2100)} ${i===40?'СерединаДиалога':''}`},'input');
    append({type:'assistant',message:{content:[{type:'text',text:'КонецДиалога'}]}},'output');
    const {text}=await readMemorySessionContent(meta);
    expect(text.length).toBeGreaterThan(150000);
    for(const marker of ['НачалоДиалога','СерединаДиалога','КонецДиалога']) expect(text).toContain(marker);
  });
});
