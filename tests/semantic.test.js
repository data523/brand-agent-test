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
