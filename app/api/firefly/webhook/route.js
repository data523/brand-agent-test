import { config } from '../../../../lib/config.js';
import { ingestDocument } from '../../../../lib/rag.js';
import { supabase } from '../../../../lib/db.js';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 60;

const FIREFLIES_GRAPHQL_ENDPOINT = 'https://api.fireflies.ai/graphql';

const TRANSCRIPT_QUERY = `
  query GetTranscript($id: String!) {
    transcript(id: $id) {
      id
      title
      date
      duration
      organizer_email
      participants
      transcript_url
      sentences {
        index
        speaker_name
        text
        start_time
        end_time
      }
      summary {
        overview
        action_items
        keywords
        outline
        shorthand_bullet
      }
    }
  }
`;

function verifyFireflySignature(payload, signature, secret) {
  if (!secret) return false;
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const sigValue = signature.replace(/^sha256=/, '');
  const sigBuffer = Buffer.from(sigValue, 'hex');
  const expBuffer = Buffer.from(expected, 'hex');
  if (sigBuffer.length !== expBuffer.length) return false;
  return crypto.timingSafeEqual(sigBuffer, expBuffer);
}

async function fetchTranscript(meetingId, apiKey) {
  const response = await fetch(FIREFLIES_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: TRANSCRIPT_QUERY,
      variables: { id: meetingId },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Fireflies API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  if (data.errors) {
    throw new Error(`Fireflies GraphQL error: ${JSON.stringify(data.errors)}`);
  }

  return data.data?.transcript;
}

function formatTranscript(transcript) {
  if (!transcript?.sentences?.length) return '';
  return transcript.sentences
    .map(s => `${s.speaker_name || 'Unknown'}: ${s.text}`)
    .join('\n');
}

function extractBrandIdFromMeeting(meeting, defaultBrandId) {
  const text = `${meeting.title || ''} ${meeting.transcript_text || ''} ${JSON.stringify(meeting.participants || [])}`.toLowerCase();
  const brandKeywords = {
    'biergarten': 'biergarten',
    'birra': 'biergarten',
    'qp': 'qp',
    'quantum peak': 'qp',
    'lllf': 'lllf',
    'live love laugh': 'lllf',
    'blive': 'blive',
    'b live': 'blive',
    'b-live': 'blive',
    'corner house': 'cornerhouse',
    'asc': 'asc',
    'amazon smart commerce': 'asc',
    'se': 'se',
    'schneider electric': 'se',
    'meghna foods': 'meghna-foods',
    "meghana's": 'meghna-foods',
    'meghana': 'meghna-foods',
  };
  for (const [keyword, brandId] of Object.entries(brandKeywords)) {
    if (text.includes(keyword)) return brandId;
  }
  return defaultBrandId;
}

async function checkAndMarkProcessed(meetingId, payloadHash, eventType, brandId) {
  const { data: existing } = await supabase()
    .from('firefly_webhook_processed')
    .select('meeting_id, payload_hash')
    .eq('meeting_id', meetingId)
    .single();

  if (existing) {
    if (existing.payload_hash === payloadHash) {
      return { isDuplicate: true, shouldProcess: false };
    }
    return { isDuplicate: false, shouldProcess: true };
  }

  return { isDuplicate: false, shouldProcess: true };
}

async function recordProcessed(meetingId, payloadHash, eventType, brandId, result) {
  await supabase().from('firefly_webhook_processed').upsert({
    meeting_id: meetingId,
    payload_hash: payloadHash,
    event_type: eventType,
    brand_id: brandId,
    ingest_result: result,
  });
}

export async function POST(request) {
  const cfg = config();
  const fireflySecret = process.env.FIREFLY_WEBHOOK_SECRET || '';
  const firefliesApiKey = process.env.FIREFLIES_API_KEY || '';
  const signature = request.headers.get('x-hub-signature') || request.headers.get('x-hub-signature-256') || '';

  if (!fireflySecret) {
    return Response.json({ ok: false, error: 'Webhook verification is not configured' }, { status: 503 });
  }
  if (!firefliesApiKey) {
    return Response.json({ ok: false, error: 'FIREFLIES_API_KEY not configured' }, { status: 503 });
  }

  const rawBody = await request.text();

  if (!signature) {
    return Response.json({ ok: false, error: 'Missing X-Hub-Signature header' }, { status: 401 });
  }
  if (!verifyFireflySignature(rawBody, signature, fireflySecret)) {
    return Response.json({ ok: false, error: 'Invalid signature' }, { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const eventType = payload.event;
  const meetingId = payload.meeting_id;

  if (!eventType || !meetingId) {
    return Response.json({ ok: false, error: 'Missing event or meeting_id in payload' }, { status: 400 });
  }

  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');

  const { isDuplicate, shouldProcess } = await checkAndMarkProcessed(meetingId, payloadHash, eventType, null);
  if (isDuplicate) {
    return Response.json({ ok: true, duplicate: true, meetingId });
  }

  let transcriptData;
  try {
    transcriptData = await fetchTranscript(meetingId, firefliesApiKey);
  } catch (error) {
    console.error('[firefly/webhook] Failed to fetch transcript:', error);
    return Response.json({ ok: false, error: `Transcript fetch failed: ${error.message}` }, { status: 502 });
  }

  if (!transcriptData) {
    return Response.json({ ok: false, error: 'Transcript not found' }, { status: 404 });
  }

  const transcriptText = formatTranscript(transcriptData);
  if (!transcriptText || transcriptText.trim().length < 50) {
    return Response.json({ ok: false, error: 'Transcript too short or empty' }, { status: 400 });
  }

  const brandId = extractBrandIdFromMeeting(transcriptData, cfg.defaultBrandId);
  if (!brandId) {
    return Response.json({ ok: false, error: 'No brandId configured and unable to infer from meeting' }, { status: 400 });
  }

  const fullText = [
    `Meeting: ${transcriptData.title || 'Firefly Meeting'}`,
    `Date: ${transcriptData.date || new Date().toISOString()}`,
    `Duration: ${transcriptData.duration ? `${transcriptData.duration}s` : 'unknown'}`,
    `Organizer: ${transcriptData.organizer_email || 'unknown'}`,
    `Participants: ${Array.isArray(transcriptData.participants) ? transcriptData.participants.join(', ') : 'none'}`,
    transcriptData.summary?.overview ? `Summary: ${transcriptData.summary.overview}` : '',
    transcriptData.summary?.action_items?.length ? `Action Items:\n${transcriptData.summary.action_items.map(a => `- ${a}`).join('\n')}` : '',
    'Transcript:',
    transcriptText,
  ].filter(Boolean).join('\n\n');

  const metadata = {
    source: 'firefly',
    meeting_url: transcriptData.transcript_url || '',
    meeting_id: meetingId,
    started_at: transcriptData.date || new Date().toISOString(),
    attendees: Array.isArray(transcriptData.participants) ? transcriptData.participants : [],
    firefly_payload: payload,
    firefly_summary: transcriptData.summary || null,
  };

  let result;
  try {
    result = await ingestDocument({
      brandId,
      title: `Firefly: ${transcriptData.title || 'Meeting'}`,
      text: fullText,
      source: 'firefly_meeting',
      documentType: 'meeting_notes',
      date: transcriptData.date || new Date().toISOString(),
      metadata,
    });
  } catch (error) {
    console.error('[firefly/webhook] Ingestion failed:', error);
    await recordProcessed(meetingId, payloadHash, eventType, brandId, { error: error.message });
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  await recordProcessed(meetingId, payloadHash, eventType, brandId, result);

  return Response.json({ ok: true, brandId, ...result });
}