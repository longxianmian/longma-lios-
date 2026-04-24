import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM   = 1536;

// Max chars to embed per chunk (roughly 6 000 tokens)
const MAX_CHARS = 8000;

export async function embedText(text: string): Promise<number[]> {
  const input = text.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input });
  return res.data[0].embedding;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface ScoredAsset {
  id:         string;
  name:       string;
  content:    string;
  asset_type: string;
  similarity: number;
}

export function rankBySimilarity(
  queryVec: number[],
  assets:   { id: string; name: string; content: string; asset_type: string; embedding: number[] }[],
  topK = 5
): ScoredAsset[] {
  return assets
    .map(a => ({ ...a, similarity: cosineSimilarity(queryVec, a.embedding) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}
