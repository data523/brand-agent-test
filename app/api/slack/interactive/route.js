import { after } from 'next/server';
import { config } from '../../../../../lib/config.js';
import { verifySlackSignature } from '../../../../../lib/slack-signature.js';
import { processInteractiveEvent } from '../../../../../lib/slack-interactive.js';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request) {
  const rawBody = await request.text();
  
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');

  const valid = verifySlackSignature({
    rawBody,
    timestamp,
    signature,
    signingSecret: config().slackSigningSecret
  });

  if (!valid) {
    console.warn('[slack-interactive] invalid signature');
    return Response.json({ ok: false, error: 'invalid_signature' }, { status: 401 });
  }

  // Parses `payload={json}`
  let payloadStr = '';
  const searchParams = new URLSearchParams(rawBody);
  if (searchParams.has('payload')) {
      payloadStr = searchParams.get('payload');
  } else {
      payloadStr = rawBody; // in case slack changes format to json directly
  }

  let payload;
  try {
    payload = JSON.parse(payloadStr);
  } catch (err) {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  if (payload.type === 'block_actions') {
      after(async () => {
          try {
             await processInteractiveEvent(payload);
          } catch(e) {
             console.error('[slack-interactive] process error', e);
          }
      });
  }

  return Response.json({ ok: true });
}
