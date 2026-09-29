import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSlackText, chunkText, formatThreadForModel } from '../lib/text.js';

test('cleanSlackText removes bot mentions and normalizes spaces', () => {
  assert.equal(cleanSlackText('<@U123ABC>   what  is this?'), 'what is this?');
});

test('chunkText splits long text while preserving content', () => {
  const text = `${'A'.repeat(80)}\n\n${'B'.repeat(80)}\n\n${'C'.repeat(80)}`;
  const chunks = chunkText(text, { maxChars: 120, overlap: 10 });
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 130));
});

test('formatThreadForModel labels users and assistants', () => {
  const result = formatThreadForModel([
    { text: 'hello', isBot: false },
    { text: 'hi', isBot: true }
  ]);
  assert.equal(result, 'USER: hello\nASSISTANT: hi');
});
