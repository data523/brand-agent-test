import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

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

test('accepts a correct Fireflies V2 signature (sha256= prefix)', () => {
  const secret = 'test-webhook-secret';
  const rawBody = JSON.stringify({ event: 'meeting_transcript_ready', meeting_id: 'meet_123' });
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const signature = `sha256=${expected}`;
  assert.equal(verifyFireflySignature(rawBody, signature, secret), true);
});

test('accepts a correct Fireflies V2 signature (without sha256= prefix)', () => {
  const secret = 'test-webhook-secret';
  const rawBody = JSON.stringify({ event: 'meeting_transcript_ready', meeting_id: 'meet_123' });
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const signature = expected;
  assert.equal(verifyFireflySignature(rawBody, signature, secret), true);
});

test('rejects tampered Fireflies body', () => {
  const secret = 'test-webhook-secret';
  const originalBody = JSON.stringify({ event: 'meeting_transcript_ready', meeting_id: 'meet_123' });
  const tamperedBody = JSON.stringify({ event: 'meeting_transcript_ready', meeting_id: 'meet_456' });
  const expected = crypto.createHmac('sha256', secret).update(originalBody).digest('hex');
  const signature = `sha256=${expected}`;
  assert.equal(verifyFireflySignature(tamperedBody, signature, secret), false);
});

test('rejects request when secret is missing', () => {
  const rawBody = JSON.stringify({ event: 'meeting_transcript_ready', meeting_id: 'meet_123' });
  const expected = crypto.createHmac('sha256', 'secret').update(rawBody).digest('hex');
  const signature = `sha256=${expected}`;
  assert.equal(verifyFireflySignature(rawBody, signature, ''), false);
  assert.equal(verifyFireflySignature(rawBody, signature, undefined), false);
});

test('rejects request when signature is missing', () => {
  const secret = 'test-webhook-secret';
  const rawBody = JSON.stringify({ event: 'meeting_transcript_ready', meeting_id: 'meet_123' });
  assert.equal(verifyFireflySignature(rawBody, '', secret), false);
  assert.equal(verifyFireflySignature(rawBody, undefined, secret), false);
});

test('rejects request with wrong secret', () => {
  const rawBody = JSON.stringify({ event: 'meeting_transcript_ready', meeting_id: 'meet_123' });
  const expected = crypto.createHmac('sha256', 'wrong-secret').update(rawBody).digest('hex');
  const signature = `sha256=${expected}`;
  assert.equal(verifyFireflySignature(rawBody, signature, 'correct-secret'), false);
});