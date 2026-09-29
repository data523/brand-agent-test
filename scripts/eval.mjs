import fs from 'node:fs/promises';
import { runBrandAgent } from '../lib/agent.js';

const cases = JSON.parse(await fs.readFile(new URL('../evals/cases.json', import.meta.url), 'utf8'));
const brandId = process.env.EVAL_BRAND_ID || process.env.DEFAULT_BRAND_ID;
if (!brandId) throw new Error('Set EVAL_BRAND_ID or DEFAULT_BRAND_ID before running evals.');

const results = [];
for (const testCase of cases) {
  const result = await runBrandAgent({
    brandId,
    latestMessage: testCase.question,
    threadMessages: testCase.threadMessages || []
  });
  const expected = testCase.expectedPlan || {};
  const planFailures = Object.entries(expected)
    .filter(([key, value]) => result.queryPlan?.[key] !== value)
    .map(([key, value]) => ({ key, expected: value, actual: result.queryPlan?.[key] }));
  const answerText = String(result.answer || '').toLowerCase();
  const contentFailures = (testCase.mustContain || [])
    .filter(term => !answerText.includes(String(term).toLowerCase()));
  const forbiddenFailures = (testCase.mustNotContain || [])
    .filter(term => answerText.includes(String(term).toLowerCase()));
  const answerFailure = testCase.answerMustBeNonMeta && (
    !String(result.answer || '').trim() ||
    /current\/approved brand source first|decide between them using this order|sources i found are|source-selection|retrieval mechanics/i.test(answerText)
  );
  results.push({
    id: testCase.id,
    pass: planFailures.length === 0 && contentFailures.length === 0 && forbiddenFailures.length === 0 && !answerFailure,
    plan: result.queryPlan,
    answer: result.answer,
    sources: result.sources,
    failures: { plan: planFailures, mustContain: contentFailures, mustNotContain: forbiddenFailures, answerMustBeNonMeta: Boolean(answerFailure) }
  });
}
const failed = results.filter(result => !result.pass);
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
if (failed.length) process.exitCode = 1;
