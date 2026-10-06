import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAco, parseAse, describeColor } from '../lib/swatch.js';
import { parseSharedLink, classifyFile, dateFromName, fontFamilyName, buildInventoryText, documentTypeFromName } from '../lib/dropbox.js';

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const f32 = (n) => { const b = Buffer.alloc(4); b.writeFloatBE(n); return b; };
const u16str = (s) => Buffer.concat([...s].map((c) => u16(c.charCodeAt(0))));

test('aco v2: named RGB and CMYK swatches are read exactly', () => {
  const entry = (space, vals, name) => Buffer.concat([u16(space), ...vals.map(u16), u32(name.length + 1), u16str(name), u16(0)]);
  const v1 = Buffer.concat([u16(1), u16(2), u16(0), u16(65535), u16(0), u16(0), u16(0), u16(2), u16(0), u16(0), u16(0), u16(0)]);
  const v2 = Buffer.concat([u16(2), u16(2), entry(0, [65535, 0, 0, 0], 'Red'), entry(2, [65535, 0, 0, 65535], 'Warm')]);
  const colors = parseAco(Buffer.concat([v1, v2]));
  assert.deepEqual(colors.map((c) => c.name), ['Red', 'Warm']);
  assert.equal(colors[0].hex, '#FF0000');
  assert.deepEqual(colors[1].values, [0, 100, 100, 0]);
  assert.equal(describeColor(colors[1]), 'Warm: CMYK 0/100/100/0 %');
});

test('aco v1 only: swatches get numbered names, no invented values', () => {
  const v1 = Buffer.concat([u16(1), u16(1), u16(0), u16(0), u16(32896), u16(65535), u16(0)]);
  const [c] = parseAco(v1);
  assert.equal(c.name, 'Swatch 1');
  assert.equal(c.hex, '#0080FF');
});

test('ase: RGB and CMYK blocks', () => {
  const colorBlock = (name, model, floats) => {
    const body = Buffer.concat([u16(name.length + 1), u16str(name), u16(0), Buffer.from(model.padEnd(4, ' ')), ...floats.map(f32), u16(2)]);
    return Buffer.concat([u16(0x0001), u32(body.length), body]);
  };
  const file = Buffer.concat([Buffer.from('ASEF'), u16(1), u16(0), u32(2), colorBlock('Brand Blue', 'RGB', [0, 0.25, 1]), colorBlock('Print Blue', 'CMYK', [1, 0.5, 0, 0])]);
  const colors = parseAse(file);
  assert.equal(colors[0].name, 'Brand Blue');
  assert.equal(colors[0].hex, '#0040FF');
  assert.deepEqual(colors[1].values, [100, 50, 0, 0]);
  assert.throws(() => parseAse(Buffer.from('nope')), /Not an ASE/);
});

test('shared link parsing needs a folder link with rlkey', () => {
  const p = parseSharedLink('https://www.dropbox.com/scl/fo/abc123/HASH?rlkey=KEY&dl=0');
  assert.deepEqual([p.linkKey, p.rootHash, p.rlkey], ['abc123', 'HASH', 'KEY']);
  assert.throws(() => parseSharedLink('https://www.dropbox.com/scl/fo/abc123/HASH'), /Not a Dropbox shared folder link/);
});

test('TAKE / SKIP rules', () => {
  const f = (relPath) => classifyFile({ name: relPath.split('/').at(-1), relPath });
  assert.equal(f('bg-brand-playbook-240710-v01.pdf').action, 'ingest');
  assert.equal(f('PSD Colour Palette/BG_Colour Palette.aco').kind, 'swatch');
  assert.equal(f('Brand Color Palette/Brand_Color_RGB.ase').kind, 'swatch');
  assert.equal(f('LLL Assets_Folder/LLL Assets Report.txt').action, 'ingest');
  assert.equal(f('bg-logo.png').kind, 'logo');
  assert.equal(f('Elements/Functional/Arch.png').kind, 'brand_element');
  assert.equal(f('Fonts/Hanken Grotesk/HankenGrotesk-Bold.ttf').kind, 'font');
  assert.equal(f('LAI Logo.pdf').kind, 'logo');
  for (const skipped of ['Old/BG Logo animation.mov', 'Quarter Peter Logo.ai', 'x.psd', 'x.eps', 'Fonts.zip', '._bg.pdf', 'grade.cube', 'Fonts/OFL.txt', 'Shoot/IMG_1.jpg']) {
    assert.equal(f(skipped).action, 'skip', skipped);
  }
});

test('dates come from file names, not Dropbox copy dates', () => {
  assert.equal(dateFromName('bg-brand-playbook-240710-v01.pdf'), '2024-07-10');
  assert.equal(dateFromName('bg-beer-menu-231205.pdf'), '2023-12-05');
  assert.equal(dateFromName('social_media_guidelines_v7.2_20230210.pdf'), '2023-02-10');
  assert.equal(dateFromName('Brand Book VO4.pdf'), null);
});

test('document types and font families from names', () => {
  assert.equal(documentTypeFromName('bg-brand-playbook-240710-v01.pdf'), 'brand_book');
  assert.equal(documentTypeFromName('bg-beer-menu-231205.pdf'), 'product_document');
  assert.equal(fontFamilyName('QP Fonts/Hanken Grotesk/HankenGrotesk-Bold.ttf'), 'Hanken Grotesk');
  assert.equal(fontFamilyName('Fonts/Syne-Regular.otf'), 'Syne');
});

test('inventory text lists names only and flags older versions', () => {
  const text = buildInventoryText('BierGarten', [
    { kind: 'logo', relPath: 'bg-logo.png' }, { kind: 'logo', relPath: 'Old/Biergarten logo.png' },
    { kind: 'font', relPath: 'Fonts/Syne-Regular.otf' }
  ]);
  assert.match(text, /Old\/Biergarten logo\.png \(older version\)/);
  assert.match(text, /Font files supplied.*Syne/);
  assert.equal(buildInventoryText('X', []), '');
});
