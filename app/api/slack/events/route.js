import { after } from 'next/server';
import { config } from '../../../../lib/config.js';
import { verifySlackSignature } from '../../../../lib/slack-signature.js';
import { processSlackEvent } from '../../../../lib/slack-handler.js';

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

  if (!valid) return Response.json({ ok: false, error: 'invalid_signature' }, { status: 401 });

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  if (payload.type === 'url_verification') {
    return Response.json({ challenge: payload.challenge });
  }

  if (payload.type === 'event_callback') {
    after(async () => {
      await processSlackEvent(payload);
    });
  }

  return Response.json({ ok: true });
}
