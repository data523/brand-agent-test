import test from 'node:test';
import assert from 'node:assert/strict';
import { KNOWLEDGE_SCOPES, DOCUMENT_TYPES } from '../lib/knowledge.js';

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
