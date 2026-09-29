export const runtime = 'nodejs';

export async function GET() {
  return Response.json({
    ok: true,
    service: 'thinktree-brand-agent',
    version: '0.2.0',
    timestamp: new Date().toISOString()
  });
}
