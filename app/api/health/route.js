export const runtime = 'nodejs';

export async function GET() {
  return Response.json({
    ok: true,
    service: 'thinktree-brand-agent',
    version: '0.1.0',
    timestamp: new Date().toISOString()
  });
}
