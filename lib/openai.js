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
  // Cascading fallbacks: prevent Slack bot crashes by degrading gracefully 
  // from the primary model to cheaper/free models on OpenRouter (fixes 402/429/500 blocks)
  const modelsToTry = [
    model,
    'openai/gpt-4o-mini',
    'google/gemini-1.5-flash',
    'meta-llama/llama-3-8b-instruct:free' // ultimate zero-cost fallback
  ];

  let lastError;
  let attempt = 0;
  
  // Dedup logic: avoid retrying the same model twice if it was passed manually
  const uniqueModels = [...new Set(modelsToTry)];

  for (const fallbackModel of uniqueModels) {
    attempt += 1;
    try {
      const chat = await openai().chat.completions.create({
        model: fallbackModel,
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: input }
        ],
        temperature: 0.2,
        max_tokens: maxOutputTokens
      });
      const text = chat.choices?.[0]?.message?.content?.trim() || '';
      if (text) return text;
      throw new Error(`Model ${fallbackModel} returned empty chat content`);
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || error?.response?.status || 0);
      const isConfigError = status === 400; // invalid params, moving to next model is safe
      
      console.warn('[openai] chat synthesis model failure; shifting to fallback', {
        model: fallbackModel,
        attempt,
        status,
        code: error?.code || null,
        message: error?.message || String(error)
      });
      
      // Delay slightly before retrying the next fallback model
      if (attempt < uniqueModels.length) {
        await new Promise(resolve => setTimeout(resolve, 300 * attempt));
      }
    }
  }
  throw lastError;
}