import { config } from '../../../lib/config.js';
import { ingestDocument } from '../../../lib/rag.js';

export const runtime = 'nodejs';
export const maxDuration = 60;

function authorized(request) {
  const header = request.headers.get('authorization') || '';
  return header === `Bearer ${config().adminSecret}`;
}

export async function POST(request) {
  if (!authorized(request)) return Response.json({ ok: false }, { status: 401 });

  const body = await request.json();
  const { brandId, title, text, source, documentType, date, metadata } = body || {};
  if (!brandId || !title || !text) {
    return Response.json({ ok: false, error: 'brandId, title and text are required' }, { status: 400 });
  }

  const result = await ingestDocument({ brandId, title, text, source, documentType, date, metadata });
  return Response.json({ ok: true, ...result });
}
