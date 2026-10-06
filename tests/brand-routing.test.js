import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBrandId } from '../lib/slack-handler.js';

// Minimal stand-in for the supabase-js query builder used by resolveBrandId.
function fakeDb(rows = [], error = null) {
  return {
    from(table) {
      assert.equal(table, 'channel_brands');
      const filters = {};
      const builder = {
        select() { return builder; },
        eq(column, value) { filters[column] = value; return builder; },
        async maybeSingle() {
          if (error) return { data: null, error };
          const row = rows.find(r => r.workspace_id === filters.workspace_id && r.channel_id === filters.channel_id);
          return { data: row || null, error: null };
        }
      };
      return builder;
    }
  };
}

const WORKSPACE = 'T001';

test('mapped channel resolves to its brand', async () => {
  const db = fakeDb([{ workspace_id: WORKSPACE, channel_id: 'C_BIER', brand_id: 'biergarten' }]);
  assert.equal(await resolveBrandId({ workspaceId: WORKSPACE, channelId: 'C_BIER', db, channelBrandMap: {} }), 'biergarten');
});

test('unmapped channel resolves to no brand, even when brands exist', async () => {
  const db = fakeDb([{ workspace_id: WORKSPACE, channel_id: 'C_BIER', brand_id: 'biergarten' }]);
  assert.equal(await resolveBrandId({ workspaceId: WORKSPACE, channelId: 'C_RANDOM', db, channelBrandMap: {} }), '');
});

test('two brands: each channel gets its own brand, never the other', async () => {
  const db = fakeDb([
    { workspace_id: WORKSPACE, channel_id: 'C_BIER', brand_id: 'biergarten' },
    { workspace_id: WORKSPACE, channel_id: 'C_OTHER', brand_id: 'other-brand' }
  ]);
  assert.equal(await resolveBrandId({ workspaceId: WORKSPACE, channelId: 'C_BIER', db, channelBrandMap: {} }), 'biergarten');
  assert.equal(await resolveBrandId({ workspaceId: WORKSPACE, channelId: 'C_OTHER', db, channelBrandMap: {} }), 'other-brand');
  assert.equal(await resolveBrandId({ workspaceId: WORKSPACE, channelId: 'C_NEW', db, channelBrandMap: {} }), '');
});

test('same channel id in another workspace is not mapped', async () => {
  const db = fakeDb([{ workspace_id: WORKSPACE, channel_id: 'C_BIER', brand_id: 'biergarten' }]);
  assert.equal(await resolveBrandId({ workspaceId: 'T999', channelId: 'C_BIER', db, channelBrandMap: {} }), '');
});

test('env map is only a fallback; the table wins', async () => {
  const db = fakeDb([{ workspace_id: WORKSPACE, channel_id: 'C_BIER', brand_id: 'biergarten' }]);
  const channelBrandMap = { C_BIER: 'wrong-brand', C_LEGACY: 'legacy-brand' };
  assert.equal(await resolveBrandId({ workspaceId: WORKSPACE, channelId: 'C_BIER', db, channelBrandMap }), 'biergarten');
  assert.equal(await resolveBrandId({ workspaceId: WORKSPACE, channelId: 'C_LEGACY', db, channelBrandMap }), 'legacy-brand');
});

test('database error is raised, not turned into a default brand', async () => {
  const db = fakeDb([], { message: 'boom' });
  await assert.rejects(() => resolveBrandId({ workspaceId: WORKSPACE, channelId: 'C_BIER', db, channelBrandMap: { C_BIER: 'biergarten' } }), /boom/);
});
