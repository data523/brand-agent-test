import { config } from '../../../../lib/config.js';
import { runBrandAgent } from '../../../../lib/agent.js';

export const runtime = 'nodejs';
export const maxDuration = 300;

function authorized(request) {
  const header = request.headers.get('authorization') || '';
  return header === `Bearer ${config().adminSecret}`;
}

export async function POST(request) {
  if (!authorized(request)) return Response.json({ ok: false }, { status: 401 });

  const body = await request.json();
  const brandId = body.brandId || config().defaultBrandId;
  const latestMessage = String(body.message || '').trim();
  if (!latestMessage) return Response.json({ ok: false, error: 'message required' }, { status: 400 });

  const threadMessages = Array.isArray(body.threadMessages) ? body.threadMessages : [];
  const result = await runBrandAgent({ brandId, latestMessage, threadMessages });
  return Response.json({ ok: true, ...result });
}
