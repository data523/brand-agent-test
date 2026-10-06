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
    // reasoning: { effort: reasoning },
    instructions,
    input,
    max_output_tokens: maxOutputTokens
  });
  return result.output_text?.trim() || '';
}


export async function llmText({ model, instructions, input, reasoning = 'low', maxOutputTokens = 1200 }) {
  // OpenRouter's stable OpenAI-compatible path for text synthesis is Chat
  // Completions. Keep Responses API usage out of the critical answer path:
  // a transport-specific empty response must never make the Brand Agent appear
  // broken when the same model is available through chat completions.
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const chat = await openai().chat.completions.create({
        model,
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: input }
        ],
        temperature: 0.2,
        max_tokens: maxOutputTokens
        // reasoning: { effort: reasoning }
      });
      const text = chat.choices?.[0]?.message?.content?.trim() || '';
      if (text) return text;
      throw new Error(`Model ${model} returned empty chat content`);
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || error?.response?.status || 0);
      const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
      console.error('[openai] chat synthesis attempt failed', {
        model,
        attempt,
        status: error?.status || null,
        code: error?.code || null,
        message: error?.message || String(error)
      });
      if (!retryable || attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 300 * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}