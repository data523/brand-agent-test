import OpenAI from 'openai';
import { config } from './config.js';

const DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';

function parseJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {} }
  return null;
}

function normalize(x) {
  const list = (v, n) => Array.isArray(v) ? v.slice(0, n).map(String) : [];
  return {
    answerable: x?.answerable !== false,
    confidence: ['low','medium','high'].includes(x?.confidence) ? x.confidence : 'medium',
    missingEvidence: list(x?.missing_evidence, 6),
    conflicts: list(x?.conflicts, 6),
    strongestEvidence: list(x?.strongest_evidence, 8),
    suggestedInvestigations: list(x?.suggested_investigations, 4),
    claimChecks: Array.isArray(x?.claim_checks) ? x.claim_checks.slice(0,8).map(i => ({claim:String(i?.claim||''),status:String(i?.status||'unknown'),reason:String(i?.reason||'').slice(0,500)})).filter(i => i.claim) : []
  };
}

export async function assessEvidence({ latestMessage, plan, evidenceText, brandMemoryText, dateContext }) {
  const { nemotronApiKey, nemotronBaseUrl, nemotronModel, nemotronMode } = config();
  if (!nemotronApiKey || nemotronMode === 'off') return null;
  const client = new OpenAI({ apiKey: nemotronApiKey, baseURL: nemotronBaseUrl });
  const instructions = [
    'You are the evidence-reasoning engine inside a production Brand Intelligence system.',
    'Do not write the final user answer. Inspect the evidence and return a compact JSON assessment.',
    'Check the exact request, direct support, scope, authority, freshness, conflicts, and missing evidence.',
    'Distinguish permanent brand truth, campaign/project guidance, observations, historical material, and external research.',
    'Treat brand memory as a lead, never as higher authority than an explicit current/approved source.',
    'Never treat semantic similarity alone as proof. Never invent missing facts.',
    'Suggest up to four targeted follow-up investigations only when they materially improve the answer.',
    'Return ONLY JSON: answerable, confidence, missing_evidence, conflicts, strongest_evidence, suggested_investigations, claim_checks.'
  ].join('\\n');
  const input = [
    'CURRENT DATE: ' + (dateContext?.display || ''),
    'USER REQUEST:\n' + latestMessage,
    'QUERY PLAN:\n' + JSON.stringify(plan),
    'BRAND MEMORY:\n' + (brandMemoryText || '(none)'),
    'RETRIEVED EVIDENCE:\n' + (evidenceText || '(none)')
  ].join('\\n\\n');
  const startedAt = Date.now();
  try {
    // This call is deliberately structured-output oriented. NVIDIA documents that
    // reasoning-enabled constrained JSON can become malformed on some Nemotron
    // serving stacks, so keep hidden thinking off for this small assessor and
    // validate the returned object before using it.
    const response = await client.chat.completions.create({
      model: nemotronModel || DEFAULT_MODEL,
      messages: [{ role:'system', content:instructions }, { role:'user', content:input }],
      temperature: 0.1,
      top_p: 0.9,
      max_tokens: 3500,
      extra_body: {
        chat_template_kwargs: {
          enable_thinking: false,
          force_nonempty_content: true
        }
      }
    });

    const message = response.choices?.[0]?.message || {};
    const rawContent = message.content || '';
    const parsed = parseJson(rawContent);
    if (!parsed) {
      console.error('[nemotron] invalid structured assessment', {
        mode: nemotronMode,
        model: nemotronModel || DEFAULT_MODEL,
        latencyMs: Date.now() - startedAt,
        finishReason: response.choices?.[0]?.finish_reason || null,
        contentLength: String(rawContent).length
      });
      throw new Error('Nemotron returned a non-JSON assessment');
    }

    const assessment = normalize(parsed);
    console.log('[nemotron] assessment ok', {
      mode: nemotronMode,
      model: nemotronModel || DEFAULT_MODEL,
      latencyMs: Date.now() - startedAt,
      confidence: assessment.confidence,
      answerable: assessment.answerable,
      missing: assessment.missingEvidence.length,
      conflicts: assessment.conflicts.length,
      investigations: assessment.suggestedInvestigations.length
    });
    return assessment;
  } catch (error) {
    console.error('[nemotron] assessment request failed', {
      mode: nemotronMode,
      model: nemotronModel || DEFAULT_MODEL,
      latencyMs: Date.now() - startedAt,
      status: error?.status || null,
      code: error?.code || null,
      message: error?.message || String(error)
    });
    throw error;
  }
}

export function formatNemotronBrief(assessment) {
  return assessment ? JSON.stringify(assessment, null, 2) : '(Nemotron assessment unavailable.)';
}