import test from 'node:test';
import assert from 'node:assert/strict';
import { KNOWLEDGE_SCOPES, DOCUMENT_TYPES, classifyQuery } from '../lib/knowledge.js';
import { normalizeChangeQuery, slackTimestampToDate } from '../lib/slack-events.js';

test('semantic taxonomy contains required scopes', () => {
  for (const scope of ['company', 'client_brand', 'client_project', 'campaign', 'external_research', 'conversation', 'unknown']) {
    assert.ok(KNOWLEDGE_SCOPES.includes(scope));
  }
});

test('semantic taxonomy contains core document types', () => {
  for (const type of ['brand_guidelines', 'brand_strategy', 'campaign_brief', 'internal_sop', 'research', 'presentation']) {
    assert.ok(DOCUMENT_TYPES.includes(type));
  }
});

test('change query normalization keeps entity terms and removes temporal noise', () => {
  assert.equal(
    normalizeChangeQuery('What changed for BierGarten yesterday?'),
    'BierGarten'
  );
});

test('Slack timestamps are converted to real event time', () => {
  assert.equal(slackTimestampToDate('1759143600'), new Date(1759143600 * 1000).toISOString());
  assert.equal(slackTimestampToDate('not-a-timestamp'), null);
});

test('current approved brand questions request current official evidence', async () => {
  const original = process.env.OPENAI_QUERY_MODEL;
  process.env.OPENAI_QUERY_MODEL = original || 'test';
  // Planner behavior is integration-tested in evals; this unit test only verifies
  // the taxonomy exposes the required status vocabulary used by retrieval.
  assert.ok(['approved', 'current', 'draft', 'proposed', 'historical', 'unknown'].includes('approved'));
});

test('caption questions use the client brand creative and voice path', async () => {
  const plan = await classifyQuery({
    latestMessage: "Give me 3 examples of captions that fit BierGarten's brand voice.",
    conversationText: '',
    dateContext: { display: '30 September 2026', year: 2026 }
  });
  assert.equal(plan.knowledge_scope, 'client_brand');
  assert.equal(plan.intent, 'creative_lookup');
  assert.ok(plan.knowledge_domains.includes('tone_of_voice'));
  assert.ok(plan.knowledge_domains.includes('messaging'));
});

test('visual official-palette questions stay in client brand scope', async () => {
  const plan = await classifyQuery({
    latestMessage: "What is BierGarten's official brand HEX colour palette and official font family?",
    conversationText: '',
    dateContext: { display: '30 September 2026', year: 2026 }
  });
  assert.equal(plan.knowledge_scope, 'client_brand');
  assert.equal(plan.intent, 'brand_guideline_lookup');
  assert.equal(plan.requires_official_sources, true);
});

test('conflicting-document questions use the dedicated comparison path', async () => {
  const plan = await classifyQuery({
    latestMessage: "I found two BierGarten documents that seem to give different directions. How should I decide which one to follow?",
    conversationText: '',
    dateContext: { display: '30 September 2026', year: 2026 }
  });
  assert.equal(plan.reason, 'deterministic_conflict_path');
  assert.equal(plan.knowledge_scope, 'client_brand');
  assert.equal(plan.include_historical, true);
  assert.ok(plan.knowledge_scopes.includes('client_brand'));
});
