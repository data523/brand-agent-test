import { config } from './config.js';
import { llmText } from './openai.js';
import { classifyQuery } from './knowledge.js';

export async function rewriteForRetrieval({ latestMessage, conversationText, dateContext }) {
  const { queryModel } = config();
  const instructions = `You are the retrieval planner for a brand knowledge assistant.
CURRENT DATE: ${dateContext?.display || '(unknown)'}
CURRENT YEAR: ${dateContext?.year || '(unknown)'}
Use this date when interpreting relative time references such as today, this year, last year, recent, or current.
Convert the user's latest request plus recent conversation into one standalone search query for a vector database.
Resolve pronouns and implied references using the conversation.
Preserve names, campaign names, dates, products, client feedback, and exact constraints.
Do not answer the user. Return only the standalone retrieval query, no labels and no markdown.`;
  const input = `RECENT CONVERSATION:
${conversationText || '(none)'}

LATEST USER MESSAGE:
${latestMessage}`;
  return (await llmText({ model: queryModel, instructions, input, reasoning: 'low' })) || latestMessage;
}

export async function planQuery({ latestMessage, conversationText, dateContext }) {
  const plan = await classifyQuery({ latestMessage, conversationText, dateContext });
  const searchQuery = plan.search_query || await rewriteForRetrieval({ latestMessage, conversationText, dateContext });
  return {
    ...plan,
    preferred_document_types: Array.isArray(plan.preferred_document_types) ? plan.preferred_document_types : [],
    excluded_document_types: Array.isArray(plan.excluded_document_types) ? plan.excluded_document_types : [],
    knowledge_domains: Array.isArray(plan.knowledge_domains) ? plan.knowledge_domains : [],
    search_query: searchQuery || latestMessage
  };
}
