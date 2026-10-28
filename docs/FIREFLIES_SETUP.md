# Fireflies V2 Webhook Integration Setup

## Overview
This integration receives Fireflies meeting webhooks, fetches transcripts via the Fireflies GraphQL API, and ingests them into the Brand Agent RAG system.

## Required Environment Variables

Add these to Vercel project settings (Project → Settings → Environment Variables):

| Variable | Description | Required |
|----------|-------------|----------|
| `FIREFLY_WEBHOOK_SECRET` | Secret from Fireflies webhook configuration (used to verify `X-Hub-Signature`) | Yes |
| `FIREFLIES_API_KEY` | Fireflies API key for GraphQL transcript queries | Yes |

## Fireflies Webhook Configuration

1. Go to Fireflies Settings → Integrations → Webhooks
2. Add webhook URL: `https://brand-agent-test.vercel.app/api/firefly/webhook`
3. Select events: `meeting.transcribed` and `meeting.summarized` (recommended)
4. Copy the **Signing Secret** → set as `FIREFLY_WEBHOOK_SECRET` in Vercel
5. Generate API key in Fireflies Settings → API → set as `FIREFLIES_API_KEY` in Vercel

## Signature Verification

- Header: `X-Hub-Signature` (or `X-Hub-Signature-256`)
- Format: `sha256=<hex_digest>`
- Algorithm: HMAC-SHA256 of raw request body

## Supported Event Types

| Event | Ingested | Notes |
|-------|----------|-------|
| `meeting.transcribed` | ✅ | Full transcript available |
| `meeting.summarized` | ✅ | Summary + transcript |
| `meeting.bot_joined` | ❌ | Acknowledged (2xx) but not ingested |

Other events are acknowledged with 2xx but ignored.

## Idempotency

Processed meetings are tracked in `firefly_webhook_processed` table:
- Composite primary key: `(meeting_id, event_type)`
- Stores `payload_hash` to detect retry with different payload
- `reprocessed_at` updated on each retry attempt
- Only successful ingestions are marked as processed
- Failures are NOT recorded, allowing retries

## Brand Inference

Meetings are matched to brands by keywords in title/transcript/participants:
- `biergarten` / `birra` → `biergarten`
- `qp` / `quantum peak` → `qp`
- `lllf` / `live love laugh` → `lllf`
- `blive` / `b live` / `b-live` → `blive`
- `corner house` → `cornerhouse`
- `asc` / `amazon smart commerce` → `asc`
- `se` / `schneider electric` → `se`
- `meghna foods` / `meghana's` / `meghana` → `meghna-foods`

Falls back to `DEFAULT_BRAND_ID` if no match.

## Date & Duration Handling

- `Transcript.date` → epoch milliseconds → converted to ISO 8601
- `Transcript.duration` → minutes → labeled as "Xmin"

## Testing Locally

```bash
# Start dev server
npm run dev

# Test webhook with ngrok
ngrok http 3000
# Configure Fireflies webhook to ngrok URL + /api/firefly/webhook
```

## Deployment

1. Push changes to GitHub
2. Vercel creates preview deployment automatically
3. Update Fireflies webhook URL to preview deployment
4. Test with a real meeting
5. When verified, promote to production

## Monitoring

Check webhook deliveries in:
- Vercel Function logs (filter by `firefly/webhook`)
- Supabase `firefly_webhook_processed` table
- Brand Agent Slack: ask about meeting content