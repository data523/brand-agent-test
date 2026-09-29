import { config } from '../../../../lib/config.js';
import { refreshBrandIntelligence } from '../../../../lib/brand-intelligence.js';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request) {
  const auth = request.headers.get('authorization') || '';
  if (auth !== `Bearer ${config().adminSecret}`) return Response.json({ ok: false }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const brandId = body.brandId || config().defaultBrandId;
  if (!brandId) return Response.json({ ok: false, error: 'brandId is required' }, { status: 400 });

  try {
    const result = await refreshBrandIntelligence({ brandId });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    console.error('[brand-intelligence] refresh failed', error);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}
