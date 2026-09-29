import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifySlackSignature } from '../lib/slack-signature.js';

function sign(body, timestamp, secret) {
  return `v0=${crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

test('accepts a correct Slack signature', () => {
  const secret = 'test-secret';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({ type: 'event_callback' });
  const signature = sign(rawBody, timestamp, secret);
  assert.equal(verifySlackSignature({ rawBody, timestamp, signature, signingSecret: secret }), true);
});

test('rejects tampered Slack body', () => {
  const secret = 'test-secret';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign('original', timestamp, secret);
  assert.equal(verifySlackSignature({ rawBody: 'tampered', timestamp, signature, signingSecret: secret }), false);
});

test('rejects old requests', () => {
  const secret = 'test-secret';
  const old = Math.floor(Date.now() / 1000) - 3600;
  const rawBody = 'payload';
  const signature = sign(rawBody, String(old), secret);
  assert.equal(verifySlackSignature({ rawBody, timestamp: String(old), signature, signingSecret: secret }), false);
});
