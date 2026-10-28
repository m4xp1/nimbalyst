// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { openAIAccessAllowed } from '../../../shared/openaiAccessPolicy';
describe('OpenAI access policy', () => {
    it('allows an ordinary installed release but denies unpackaged and automated launches', () => {
        expect(openAIAccessAllowed({ packaged: true, env: {} })).toBe(true);
        for (const env of [{ VITEST: 'true' }, { PLAYWRIGHT: '1' }, { PLAYWRIGHT_TEST: '1' }, { NODE_ENV: 'test' }, { CI: 'true' }])
            expect(openAIAccessAllowed({ packaged: true, env })).toBe(false);
        expect(openAIAccessAllowed({ packaged: false, env: {} })).toBe(false);
    });
    it('requires explicit per-run opt-in and treats malformed values as denial', () => {
        expect(openAIAccessAllowed({ packaged: false, env: { NIMBALYST_ALLOW_OPENAI_API: '1', VITEST: 'true' } })).toBe(true);
        for (const value of ['0', 'yes', 'true', ''])
            expect(openAIAccessAllowed({ packaged: true, env: { NIMBALYST_ALLOW_OPENAI_API: value } })).toBe(false);
    });
});

it('withholds stored global and project keys without changing encrypted bytes', async () => {
    const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
    const { ProviderCredentialVault } = await import('../credentials/ProviderCredentialVault');
    const { createCipheriv, createDecipheriv, randomBytes } = await import('node:crypto');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-policy-')), key = randomBytes(32);
    const encryption = { available: () => true,
        encrypt(value: string) { const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv); const bytes=Buffer.concat([cipher.update(value),cipher.final()]); return Buffer.concat([iv,cipher.getAuthTag(),bytes]); },
        decrypt(value: Buffer) { const cipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));cipher.setAuthTag(value.subarray(12,28));return Buffer.concat([cipher.update(value.subarray(28)),cipher.final()]).toString(); }
    };
    try {
        const stored=new ProviderCredentialVault(dir,encryption);
        stored.set('openai','synthetic-global');stored.set('openai','synthetic-project',{workspacePath:dir});
        const file=path.join(dir,'provider-credentials/vault.bin'), before=fs.readFileSync(file);
        let allowed=false;
        const guarded=new ProviderCredentialVault(dir,encryption,()=>{},name=>name!=='openai'||allowed);
        expect(guarded.get('openai')).toBeUndefined();expect(guarded.get('openai',{workspacePath:dir})).toBeUndefined();
        expect(guarded.availableKeys()).toEqual({});expect(guarded.availableKeys({workspacePath:dir})).toEqual({});expect(guarded.mobileOpenAIKey()).toBeUndefined();
        expect(fs.readFileSync(file)).toEqual(before);
        allowed=true;expect(guarded.get('openai')).toBe('synthetic-global');expect(guarded.get('openai',{workspacePath:dir})).toBe('synthetic-project');
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
