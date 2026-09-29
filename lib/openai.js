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
  // Prefer Responses API, but never silently convert an empty response into a
  // "model failed" condition. OpenRouter supports Chat Completions for these
  // models as well, so use it as a transport fallback.
  try {
    const result = await responsesCreate({
      model,
      reasoning: { effort: reasoning },
      instructions,
      input,
      max_output_tokens: maxOutputTokens
    });
    const text = result.output_text?.trim() || '';
    if (text) return text;

    console.warn('[openai] Responses API returned empty output_text; trying chat completions', {
      model,
      responseId: result.id || null,
      status: result.status || null
    });
  } catch (error) {
    console.warn('[openai] Responses API text generation failed; trying chat completions', {
      model,
      status: error?.status || null,
      code: error?.code || null,
      message: error?.message || String(error)
    });
  }

  const chat = await openai().chat.completions.create({
    model,
    messages: [
      { role: 'system', content: instructions },
      { role: 'user', content: input }
    ],
    temperature: 0.2,
    max_tokens: maxOutputTokens
  });

  const text = chat.choices?.[0]?.message?.content?.trim() || '';
  if (!text) {
    throw new Error(`Model ${model} returned no text from either Responses API or Chat Completions`);
  }
  return text;
}
