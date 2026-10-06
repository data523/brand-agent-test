import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrands, findBrandIds, resolveBrand } from '../lib/brand-resolver.js';

const BRANDS = [
  { id: 'biergarten', name: 'BierGarten', aliases: ['Bier Garten'], status: 'active' },
  { id: 'qp', name: 'QP', aliases: ['Quarter Peter'], status: 'active' },
  { id: 'lllf', name: 'LLLF', aliases: ['LLL', 'Agents of Change', 'Artiste Corner', 'Lecture Series', 'Lecture Series Unplugged', 'Story of Hope'], status: 'active' },
  { id: 'cornerhouse', name: 'Corner House', aliases: ['CH'], status: 'active' },
  { id: 'se', name: 'SE', aliases: [], status: 'active' }
];

const resolve = (text, threadTexts = []) => resolveBrand({ text, threadTexts, brands: BRANDS });

test('named brand resolves from the message', () => {
  assert.deepEqual(resolve("What is BierGarten's tone of voice?"), { status: 'resolved', brandId: 'biergarten', via: 'message' });
  assert.equal(resolve('biergarten colours?').brandId, 'biergarten');
});

test('alias, spacing and hyphen variants resolve to the brand', () => {
  assert.equal(resolve('Bier Garten positioning').brandId, 'biergarten');
  assert.equal(resolve('what is Quarter Peter about').brandId, 'qp');
  assert.equal(resolve('corner-house logo rules').brandId, 'cornerhouse');
  assert.equal(resolve('CH brand book?').brandId, 'cornerhouse');
});

test('every LLLF IP name resolves to lllf', () => {
  for (const ip of ['Agents of Change', 'Artiste Corner', 'Lecture Series', 'Lecture Series Unplugged', 'Story of Hope']) {
    assert.deepEqual(resolve(`What is the tone for ${ip}?`), { status: 'resolved', brandId: 'lllf', via: 'message' }, ip);
  }
  // Two IP names of the same brand are still one brand.
  assert.equal(resolve('Lecture Series vs Story of Hope').brandId, 'lllf');
});

test('no brand named and no thread: ask, never guess', () => {
  assert.deepEqual(resolve('What is our tone of voice?'), { status: 'none' });
  assert.deepEqual(resolve(''), { status: 'none' });
});

test('thread carry-over: an earlier message in the thread sets the brand', () => {
  const thread = ['and what about the colours?', 'Tell me about QP positioning'];
  assert.deepEqual(resolve('and what about fonts?', thread), { status: 'resolved', brandId: 'qp', via: 'thread' });
});

test('thread carry-over: the newest brand in the thread wins, and the message beats the thread', () => {
  const thread = ['now Corner House tone?', 'BierGarten tone?'];
  assert.equal(resolve('and the colours?', thread).brandId, 'cornerhouse');
  assert.deepEqual(resolve('what about QP?', thread), { status: 'resolved', brandId: 'qp', via: 'message' });
});

test('thread messages that name two brands do not set a brand', () => {
  assert.deepEqual(resolve('and fonts?', ['compare BierGarten and QP']), { status: 'none' });
});

test('two brands in one message: ask, no mixing', () => {
  assert.deepEqual(resolve('compare BierGarten and QP'), { status: 'multiple', brandIds: ['biergarten', 'qp'] });
});

test('short names must be written as given and match whole words only', () => {
  assert.deepEqual(resolve('se debe usar el tono'), { status: 'none' });
  assert.equal(resolve('SE guidelines?').brandId, 'se');
  assert.deepEqual(resolve('the qpl campaign'), { status: 'none' });
  assert.deepEqual(resolve('the CHARM campaign'), { status: 'none' });
});

test('a brand id of 3 characters or fewer is not matched on its own', () => {
  assert.deepEqual(findBrandIds('qp tone', [{ id: 'qp', name: 'Quarter Peter Co', aliases: [] }]), []);
});

test('loadBrands only asks for active and onboarding brands and surfaces DB errors', async () => {
  let statuses;
  const db = {
    from(table) {
      assert.equal(table, 'brands');
      const builder = { select() { return builder; }, async in(column, values) { assert.equal(column, 'status'); statuses = values; return { data: BRANDS, error: null }; } };
      return builder;
    }
  };
  assert.equal((await loadBrands(db)).length, BRANDS.length);
  assert.deepEqual(statuses, ['active', 'onboarding']);
  const failing = { from() { const b = { select() { return b; }, async in() { return { data: null, error: { message: 'boom' } }; } }; return b; } };
  await assert.rejects(() => loadBrands(failing), /boom/);
});
