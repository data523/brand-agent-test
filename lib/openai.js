import OpenAI from 'openai';
import { config } from './config.js';

let client;
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
  const result = await openai().responses.create({
    model,
    reasoning: { effort: reasoning },
    instructions,
    input,
    max_output_tokens: maxOutputTokens
  });
  return result.output_text?.trim() || '';
}


export async function llmText({ model, instructions, input, reasoning = 'low', maxOutputTokens = 1200 }) {
  const result = await openai().responses.create({
    model, reasoning: { effort: reasoning }, instructions, input,
    max_output_tokens: maxOutputTokens
  });
  return result.output_text?.trim() || '';
}
