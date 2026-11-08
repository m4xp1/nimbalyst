// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../OpenAIProvider';

const fake = vi.hoisted(() => ({
  ids: [] as string[],
  create: vi.fn(async function* (_params: Record<string, unknown>, _options?: unknown) {}),
}));
vi.mock('openai', () => ({ default: class {
  models = { list: async () => ({ data: fake.ids.map(id => ({ id })) }) };
  chat = { completions: { create: fake.create } };
} }));
vi.mock('../../../openaiAccessPolicy', () => ({ assertOpenAIRequestAllowed: () => {} }));

beforeEach(() => { fake.ids = []; fake.create.mockClear(); });

describe('OpenAIProvider config', () => {
  it('lists available Terra and Astra with API-qualified identities', async () => {
    fake.ids = ['gpt-6.1-terra', 'gpt-6-astra'];
    const models = await OpenAIProvider.getModels('fake-api-key');
    expect(models.map(model => model.id).sort()).toEqual(['openai:gpt-6-astra', 'openai:gpt-6.1-terra']);
    expect(models.every(model => model.provider === 'openai')).toBe(true);
  });

  it('does not advertise Terra when the API account does not list it', async () => {
    fake.ids = ['gpt-5.4'];
    expect((await OpenAIProvider.getModels('fake-api-key')).map(model => model.id)).toEqual(['openai:gpt-5.4']);
  });

  it('sends Terra via the API client without unsupported temperature overrides', async () => {
    const provider = new OpenAIProvider();
    await provider.initialize({ apiKey: 'fake-api-key', model: 'gpt-6.1-terra' });
    for await (const _chunk of provider.sendMessage('synthetic fixture')) { /* fake stream */ }
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(fake.create.mock.calls[0]?.[0]).toMatchObject({ model: 'gpt-6.1-terra' });
    expect(fake.create.mock.calls[0]?.[0]).not.toHaveProperty('temperature');
  });

  it('falls back to the default model when initialized without one', async () => {
    const provider = new OpenAIProvider();

    await provider.initialize({ apiKey: 'test-openai-key' });

    expect((provider as any).config.model).toBe(OpenAIProvider.DEFAULT_MODEL);
  });

  it('preserves the selected model when initialized with one', async () => {
    const provider = new OpenAIProvider();

    await provider.initialize({ apiKey: 'test-openai-key', model: 'gpt-5-mini' });

    expect((provider as any).config.model).toBe('gpt-5-mini');
  });
});
