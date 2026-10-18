/**
 * OpenAI embeddings via the REST API (no SDK dependency — uses global fetch).
 * Key-source-agnostic: the apiKey is supplied explicitly by the caller at
 * construction. The engine never reads it from the environment implicitly.
 */
import type { Embedder, EmbedderInfo } from '../types.js';
import { MAX_EMBEDDING_INPUT_BYTES, MAX_EMBEDDING_BATCH_BYTES, utf8Bytes } from '../embeddingInput.js';

export interface OpenAIEmbedderConfig {
  apiKey: string;
  /** Default: text-embedding-3-small. */
  model?: string;
  /** Default: 1536 (text-embedding-3-small native dim). */
  dims?: number;
  /** Override for OpenAI-compatible gateways. Default: https://api.openai.com/v1 */
  baseUrl?: string;
  /** Max texts per request. Default: 128. */
  batchSize?: number;
}

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMS = 1536;
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_BATCH = 128;

export class OpenAIEmbedder implements Embedder {
  readonly info: EmbedderInfo;
  private apiKey: string;
  private baseUrl: string;
  private batchSize: number;

  constructor(config: OpenAIEmbedderConfig) {
    if (!config.apiKey) throw new Error('OpenAIEmbedder requires an apiKey');
    const model = config.model ?? DEFAULT_MODEL;
    const dims = config.dims ?? DEFAULT_DIMS;
    this.info = { id: 'openai', model, dims };
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    if (config.batchSize !== undefined && (!Number.isInteger(config.batchSize) || config.batchSize < 1)) throw new Error('Invalid embedding batch size');
    this.batchSize = Math.min(config.batchSize ?? DEFAULT_BATCH, DEFAULT_BATCH);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const sizes = texts.map(text => utf8Bytes(text));
    if (sizes.some(size => size > MAX_EMBEDDING_INPUT_BYTES)) {
      throw Object.assign(new Error('Embedding input exceeds the safe input length limit; shorten the query or re-index the source.'), {code:'EMBEDDING_INPUT_TOO_LARGE'});
    }
    const out: number[][] = [];
    let batch: string[] = [], bytes = 0;
    for (let i = 0; i < texts.length; i++) {
      if (batch.length && (batch.length >= this.batchSize || bytes + sizes[i] > MAX_EMBEDDING_BATCH_BYTES)) {
        out.push(...await this.embedBatch(batch)); batch = []; bytes = 0;
      }
      batch.push(texts[i]); bytes += sizes[i];
    }
    if (batch.length) out.push(...await this.embedBatch(batch));
    return out;
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    const body: Record<string, unknown> = { model: this.info.model, input: batch };
    // text-embedding-3-* support an explicit `dimensions` truncation.
    if (this.info.model.startsWith('text-embedding-3')) body.dimensions = this.info.dims;

    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let inputLimit=false,providerCode='EMBEDDING_PROVIDER_ERROR';
      try { const error=JSON.parse(detail)?.error;inputLimit=/maximum (input|context) length|too (large|long)|input.*exceed.*token/i.test(error?.message??'');
        if(['insufficient_quota','invalid_api_key','model_not_found','rate_limit_exceeded'].includes(error?.code))providerCode=error.code;
      } catch { /* Non-JSON failures still retain their HTTP status. */ }
      throw Object.assign(new Error(inputLimit?'Embedding input exceeds provider input length limit.':`OpenAI embedding request failed (${res.status}).`),{status:res.status,code:inputLimit?'EMBEDDING_INPUT_TOO_LARGE':providerCode});
    }
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    // Preserve input order regardless of response ordering.
    return json.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}
