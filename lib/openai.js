import OpenAI from 'openai';
import { config } from './config.js';

let client;

function isRetryableError(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  const code = String(error?.code || '').toLowerCase();
  return status === 408 || status === 409 || status === 429 || status >= 500 ||
    ['econnreset', 'etimedout', 'eai_again', 'enotfound', 'fetch_failed'].includes(code);
}

async function responsesCreate(payload, { attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await openai().responses.create(payload);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryableError(error)) throw error;
      const delayMs = 250 * (2 ** (attempt - 1));
      console.warn('[openai] transient response failure; retrying', {
        attempt,
        delayMs,
        status: error?.status || error?.response?.status || null,
        code: error?.code || null
      });
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export function openai() {
  if (!client) {
    const { openaiApiKey, openaiBaseUrl } = config();
    client = new OpenAI({ apiKey: openaiApiKey, baseURL: openaiBaseUrl });
  }
  return client;
}

export async function embedTexts(texts) {
  if (!texts.length) return [];
  const { embedModel } = config();
  const result = await openai().embeddings.create({ model: embedModel, input: texts });
  return result.data.map((item) => item.embedding);
}

export async function llmVision({ model, instructions, input, reasoning = 'low', maxOutputTokens = 1200 }) {
  const result = await responsesCreate({
    model,
    reasoning: { effort: reasoning },
    instructions,
    input,
    max_output_tokens: maxOutputTokens
  });
  return result.output_text?.trim() || '';
}


export async function llmText({ model, instructions, input, reasoning = 'low', maxOutputTokens = 1200 }) {
  const result = await responsesCreate({
    model, reasoning: { effort: reasoning }, instructions, input,
    max_output_tokens: maxOutputTokens
  });
  return result.output_text?.trim() || '';
}
