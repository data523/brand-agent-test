import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOfficeBuffer } from '../lib/document-parser.js';

// Smallest valid one-page PDF containing the text "Hello Brand".
function tinyPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  const stream = 'BT /F1 18 Tf 20 50 Td (Hello Brand) Tj ET';
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

test('parseOfficeBuffer extracts text from a PDF (officeparser loads in this runtime)', async () => {
  const parsed = await parseOfficeBuffer(tinyPdf(), { fileType: 'pdf' });
  assert.match(parsed.text, /Hello Brand/);
});

test('parseOfficeBuffer rejects an empty buffer', async () => {
  await assert.rejects(() => parseOfficeBuffer(Buffer.alloc(0), { fileType: 'pdf' }), /empty/);
});
