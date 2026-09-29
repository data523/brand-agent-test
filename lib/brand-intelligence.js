import { supabase } from './db.js';
import { llmText } from './openai.js';
import { config } from './config.js';

const PROFILE_SCHEMA = {
  brand_name: '', essence: '', positioning: '', purpose: '', promise: '', personality: [],
  audience: { primary: '', secondary: '', needs: [], occasions: [], motivations: [] },
  offering: { products: [], services: [], differentiators: [], experience: [] },
  messaging: { core_messages: [], value_propositions: [], tone: [], language_preferences: [], avoid: [] },
  visual_identity: { logo: [], colors: [], typography: [], imagery: [], graphic_elements: [], layouts: [], composition: [], hierarchy: [], spacing: [], text_alignment: [], observations: [] },
  content_strategy: { pillars: [], formats: [], platforms: [], themes: [], creative_patterns: [] },
  campaigns: [], market_context: { competitors: [], category: '', differentiation: [] },
  guardrails: { must_do: [], must_not_do: [], approval_rules: [] },
  current_state: { active_priorities: [], current_campaigns: [], recent_decisions: [] },
  knowledge_gaps: [], evidence_notes: []
};

function clean(value, fallback = '') { return typeof value === 'string' ? value.trim() : fallback; }
function cleanList(value, limit = 30) {
  return Array.isArray(value) ? value.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()).slice(0, limit) : [];
}

function normalizeProfile(value) {
  const p = value && typeof value === 'object' ? value : {};
  const nested = key => (p[key] && typeof p[key] === 'object' ? p[key] : {});
  const audience = nested('audience'), offering = nested('offering'), messaging = nested('messaging');
  const visual = nested('visual_identity'), content = nested('content_strategy');
  const market = nested('market_context'), guardrails = nested('guardrails'), current = nested('current_state');
  return {
    brand_name: clean(p.brand_name), essence: clean(p.essence), positioning: clean(p.positioning),
    purpose: clean(p.purpose), promise: clean(p.promise), personality: cleanList(p.personality),
    audience: { primary: clean(audience.primary), secondary: clean(audience.secondary), needs: cleanList(audience.needs), occasions: cleanList(audience.occasions), motivations: cleanList(audience.motivations) },
    offering: { products: cleanList(offering.products), services: cleanList(offering.services), differentiators: cleanList(offering.differentiators), experience: cleanList(offering.experience) },
    messaging: { core_messages: cleanList(messaging.core_messages), value_propositions: cleanList(messaging.value_propositions), tone: cleanList(messaging.tone), language_preferences: cleanList(messaging.language_preferences), avoid: cleanList(messaging.avoid) },
    visual_identity: { logo: cleanList(visual.logo), colors: cleanList(visual.colors), typography: cleanList(visual.typography), imagery: cleanList(visual.imagery), graphic_elements: cleanList(visual.graphic_elements), layouts: cleanList(visual.layouts), composition: cleanList(visual.composition), hierarchy: cleanList(visual.hierarchy), spacing: cleanList(visual.spacing), text_alignment: cleanList(visual.text_alignment), observations: cleanList(visual.observations) },
    content_strategy: { pillars: cleanList(content.pillars), formats: cleanList(content.formats), platforms: cleanList(content.platforms), themes: cleanList(content.themes), creative_patterns: cleanList(content.creative_patterns) },
    campaigns: cleanList(p.campaigns, 20),
    market_context: { competitors: cleanList(market.competitors), category: clean(market.category), differentiation: cleanList(market.differentiation) },
    guardrails: { must_do: cleanList(guardrails.must_do), must_not_do: cleanList(guardrails.must_not_do), approval_rules: cleanList(guardrails.approval_rules) },
    current_state: { active_priorities: cleanList(current.active_priorities), current_campaigns: cleanList(current.current_campaigns), recent_decisions: cleanList(current.recent_decisions) },
    knowledge_gaps: cleanList(p.knowledge_gaps), evidence_notes: cleanList(p.evidence_notes, 40)
  };
}

function fingerprint(rows) {
  return rows.map(row => [
    row.id, row.source, row.source_date, row.status, row.authority, row.document_key,
    row.is_superseded, row.content?.length || 0
  ].join('|')).join('||');
}

const PROFILE_PROMPT = `You are the Brand Intelligence Architect for an agency.
Build a durable working model of ONE CLIENT BRAND from the supplied source evidence.
This is not a summary of one document. Synthesize the brand across all supplied current evidence.

SOURCE AUTHORITY:
- approved/current client brand references outrank drafts and discussions.
- strategy can establish positioning and messaging when it is the best available evidence.
- campaign material is campaign-specific unless it explicitly states a permanent brand rule.
- Slack/conversation material is context; treat it as a brand decision only when evidence explicitly records an approved decision.
- never invent missing facts.
- when evidence conflicts, do not silently choose. Record the conflict in evidence_notes and prefer the higher-authority/current source.
- visual observations from rendered pages/slides are useful evidence, but never turn an observed colour into an official HEX palette unless explicitly provided.
- internal company knowledge is NOT client brand truth.

OUTPUT:
Return ONLY valid JSON matching the schema. Use concise useful statements. Use [] or "" when evidence does not establish something. knowledge_gaps should contain important things the agency still cannot verify. evidence_notes should mention meaningful conflicts or provenance limitations. The profile must help another AI answer questions and create work without rereading the entire document set.

SCHEMA:
${JSON.stringify(PROFILE_SCHEMA, null, 2)}`;

function sourceDigest(rows) {
  return rows.map((row, index) => {
    const metadata = [
      'SOURCE ' + (index + 1),
      'title=' + (row.title || ''),
      'type=' + (row.document_type || ''),
      'scope=' + (row.knowledge_scope || ''),
      'entity=' + (row.entity_name || ''),
      'authority=' + (row.authority || ''),
      'status=' + (row.status || ''),
      'date=' + (row.source_date || row.effective_date || ''),
      'path=' + (row.source_path || ''),
      'summary=' + (row.summary || ''),
      'domains=' + (row.knowledge_domains || []).join(', '),
      'visual_colors=' + (row.visual_colors || []).join(', '),
      'visual_typography=' + (row.visual_typography || []).join(', '),
      'visual_elements=' + (row.visual_elements || []).join(', '),
      'visual_layout=' + (row.visual_layout || []).join(', '),
      'visual_composition=' + (row.visual_composition || []).join(', '),
      'visual_logo=' + (row.visual_logo_placement || []).join(', ')
    ].join(' | ');
    return metadata + '\nCONTENT:\n' + String(row.content || '').slice(0, 9000);
  }).join('\n\n---\n\n');
}

export async function loadBrandIntelligence(brandId) {
  const { data, error } = await supabase().from('brand_intelligence')
    .select('brand_id,profile,generated_at,profile_version,source_fingerprint')
    .eq('brand_id', brandId).maybeSingle();
  if (error) {
    if (/brand_intelligence/i.test(error.message)) return null;
    throw new Error('Brand Intelligence lookup failed: ' + error.message);
  }
  return data || null;
}

export async function refreshBrandIntelligence({ brandId }) {
  const { data: rows, error } = await supabase().from('brand_chunks')
    .select('id,title,source,document_type,source_date,content,knowledge_scope,owner,entity_name,entity_type,authority,status,knowledge_domains,summary,effective_date,document_key,is_superseded,visual_summary,visual_elements,visual_colors,visual_typography,visual_layout,visual_composition,visual_hierarchy,visual_spacing,visual_logo_placement,visual_text_alignment,visual_confidence')
    .eq('brand_id', brandId).eq('is_superseded', false)
    .order('source_date', { ascending: false, nullsFirst: false }).limit(220);
  if (error) throw new Error('Brand Intelligence source lookup failed: ' + error.message);
  if (!rows?.length) return { brandId, generated: false, reason: 'no_current_sources' };

  const sourceFingerprint = fingerprint(rows);
  const existing = await loadBrandIntelligence(brandId);
  if (existing?.source_fingerprint === sourceFingerprint) return { brandId, generated: false, reason: 'unchanged', generatedAt: existing.generated_at };

  const { queryModel } = config();
  let prompt = PROFILE_PROMPT.replace('${JSON.stringify(PROFILE_SCHEMA, null, 2)}', JSON.stringify(PROFILE_SCHEMA, null, 2));
  const raw = await llmText({
    model: queryModel, instructions: prompt,
    input: 'BRAND ID: ' + brandId + '\n\nCURRENT SOURCE EVIDENCE:\n' + sourceDigest(rows),
    reasoning: 'low', maxOutputTokens: 5000
  });

  let profile;
  try { profile = normalizeProfile(JSON.parse(raw)); }
  catch { throw new Error('Brand Intelligence generation returned invalid JSON'); }

  const { data: saved, error: saveError } = await supabase().from('brand_intelligence').upsert({
    brand_id: brandId, profile, source_fingerprint: sourceFingerprint,
    generated_at: new Date().toISOString(), profile_version: (existing?.profile_version || 0) + 1
  }, { onConflict: 'brand_id' }).select('brand_id,profile,generated_at,profile_version,source_fingerprint').single();
  if (saveError) throw new Error('Brand Intelligence save failed: ' + saveError.message);
  return { brandId, generated: true, profile: saved.profile, generatedAt: saved.generated_at, profileVersion: saved.profile_version };
}

export function formatBrandIntelligence(profileRow) {
  if (!profileRow?.profile) return '(Brand Intelligence profile has not been built yet.)';
  const p = normalizeProfile(profileRow.profile);
  const section = (name, value) => name + ':\n' + JSON.stringify(value);
  return [
    'BRAND: ' + (p.brand_name || '(name not established)'),
    section('ESSENCE & POSITIONING', { essence:p.essence, positioning:p.positioning, purpose:p.purpose, promise:p.promise, personality:p.personality }),
    section('AUDIENCE', p.audience), section('OFFERING', p.offering),
    section('MESSAGING & VOICE', p.messaging), section('VISUAL IDENTITY', p.visual_identity),
    section('CONTENT STRATEGY', p.content_strategy), section('CAMPAIGNS', p.campaigns),
    section('MARKET CONTEXT', p.market_context), section('GUARDRAILS', p.guardrails),
    section('CURRENT STATE', p.current_state), section('KNOWLEDGE GAPS', p.knowledge_gaps),
    section('EVIDENCE NOTES', p.evidence_notes)
  ].join('\n\n');
}
