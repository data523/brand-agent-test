import crypto from 'node:crypto';

export function verifySlackSignature({ rawBody, timestamp, signature, signingSecret, now = Date.now() }) {
  if (!rawBody || !timestamp || !signature || !signingSecret) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;

  const ageSeconds = Math.abs(Math.floor(now / 1000) - ts);
  if (ageSeconds > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const digest = `v0=${crypto.createHmac('sha256', signingSecret).update(base).digest('hex')}`;

  const a = Buffer.from(digest);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
