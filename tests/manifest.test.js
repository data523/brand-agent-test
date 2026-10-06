import test from 'node:test';
import assert from 'node:assert/strict';
import { contentHash, recordManifest } from '../lib/manifest.js';

function fakeDb(result = { error: null }) {
  const calls = [];
  return {
    calls,
    from(table) {
      return { async upsert(row, options) { calls.push({ table, row, options }); return result; } };
    }
  };
}

test('contentHash is stable and content-sensitive', () => {
  assert.equal(contentHash('abc'), contentHash('abc'));
  assert.notEqual(contentHash('abc'), contentHash('abd'));
});

test('ingested file writes one upserted row with chunk count and ingested_at', async () => {
  const db = fakeDb();
  await recordManifest({ brandId: 'biergarten', source: 'gdrive:1', title: 'Guide.pdf', status: 'ingested', chunkCount: 4, contentHash: 'h' }, db);
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].table, 'ingestion_manifest');
  assert.deepEqual(db.calls[0].options, { onConflict: 'brand_id,source' });
  assert.equal(db.calls[0].row.chunk_count, 4);
  assert.ok(db.calls[0].row.ingested_at);
});

test('skipped file keeps its reason and has no ingested_at', async () => {
  const db = fakeDb();
  await recordManifest({ brandId: 'qp', source: 'gdrive:2', status: 'skipped', skipReason: 'video' }, db);
  assert.equal(db.calls[0].row.skip_reason, 'video');
  assert.equal(db.calls[0].row.ingested_at, undefined);
});

test('manifest write errors never throw into ingestion', async () => {
  await recordManifest({ brandId: 'qp', source: 'x', status: 'failed', error: 'e' }, fakeDb({ error: { message: 'db down' } }));
  const throwing = { from() { throw new Error('boom'); } };
  await recordManifest({ brandId: 'qp', source: 'x', status: 'failed' }, throwing);
});
