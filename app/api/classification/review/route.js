import { config } from '../../../../lib/config.js';
import { supabase } from '../../../../lib/db.js';

export const runtime = 'nodejs';

function authorized(request) {
  return request.headers.get('authorization') === `Bearer ${config().adminSecret}`;
}

export async function GET(request) {
  if (!authorized(request)) return Response.json({ ok: false }, { status: 401 });

  const url = new URL(request.url);
  const brandId = url.searchParams.get('brandId');
  const status = url.searchParams.get('status') || 'pending';
  if (!brandId) return Response.json({ ok: false, error: 'brandId is required' }, { status: 400 });

  const { data, error } = await supabase()
    .from('classification_review_queue')
    .select('*')
    .eq('brand_id', brandId)
    .eq('status', status)
    .order('created_at', { ascending: true })
    .limit(100);

  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  return Response.json({ ok: true, items: data || [] });
}

export async function POST(request) {
  if (!authorized(request)) return Response.json({ ok: false }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { brandId, source, decision, reviewer, notes, metadata } = body;

  if (!brandId || !source || !['approve', 'reject'].includes(decision)) {
    return Response.json({ ok: false, error: 'brandId, source and decision (approve|reject) are required' }, { status: 400 });
  }

  const db = supabase();
  const { data: queueItem, error: queueError } = await db
    .from('classification_review_queue')
    .select('*')
    .eq('brand_id', brandId)
    .eq('source', source)
    .single();

  if (queueError || !queueItem) {
    return Response.json({ ok: false, error: queueError?.message || 'Review item not found' }, { status: 404 });
  }

  if (decision === 'reject') {
    const { error } = await db
      .from('classification_review_queue')
      .update({
        status: 'rejected',
        reviewer: reviewer || 'admin',
        review_notes: notes || null,
        reviewed_at: new Date().toISOString()
      })
      .eq('id', queueItem.id);

    if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
    return Response.json({ ok: true, status: 'rejected' });
  }

  const patch = metadata && typeof metadata === 'object' ? metadata : queueItem.proposed_metadata || {};
  const allowedScopes = ['company','client_brand','client_project','campaign','external_research','conversation','unknown'];
  const allowedOwners = ['internal','client','third_party','mixed','unknown'];
  const allowedAuthorities = ['very_high','high','medium','low'];
  const allowedStatuses = ['approved','current','draft','proposed','historical','unknown'];

  const knowledgeScope = allowedScopes.includes(patch.knowledge_scope) ? patch.knowledge_scope : queueItem.knowledge_scope;
  const owner = allowedOwners.includes(patch.owner) ? patch.owner : queueItem.owner;
  const authority = allowedAuthorities.includes(patch.authority) ? patch.authority : 'medium';
  const semanticStatus = allowedStatuses.includes(patch.status) ? patch.status : 'current';
  const entityName = typeof patch.entity_name === 'string' && patch.entity_name.trim() ? patch.entity_name.trim() : null;
  const confidenceValue = Number(patch.classification_confidence ?? 1);
  const confidence = Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : 1;

  const chunkPatch = {
    knowledge_scope: knowledgeScope,
    owner,
    entity_name: entityName,
    entity_aliases: Array.isArray(patch.entity_aliases) ? patch.entity_aliases : [],
    entity_type: typeof patch.entity_type === 'string' ? patch.entity_type : 'unknown',
    document_type: typeof patch.document_type === 'string' ? patch.document_type : queueItem.document_type,
    knowledge_domains: Array.isArray(patch.knowledge_domains) ? patch.knowledge_domains : [],
    purpose: typeof patch.purpose === 'string' ? patch.purpose : 'general',
    authority,
    status: semanticStatus,
    is_brand_reference: knowledgeScope === 'client_brand' && patch.is_brand_reference === true,
    is_current_candidate: patch.is_current_candidate !== false,
    brands: Array.isArray(patch.brands) ? patch.brands : [],
    projects: Array.isArray(patch.projects) ? patch.projects : [],
    campaigns: Array.isArray(patch.campaigns) ? patch.campaigns : [],
    products: Array.isArray(patch.products) ? patch.products : [],
    topics: Array.isArray(patch.topics) ? patch.topics : [],
    summary: typeof patch.summary === 'string' ? patch.summary : '',
    effective_date: patch.effective_date || null,
    supersedes: Array.isArray(patch.supersedes) ? patch.supersedes : [],
    classification_confidence: confidence,
    classification_reason: notes || queueItem.classification_reason || 'Approved during semantic classification review.'
  };

  const { error: chunkError } = await db
    .from('brand_chunks')
    .update(chunkPatch)
    .eq('brand_id', brandId)
    .eq('source', source);

  if (chunkError) return Response.json({ ok: false, error: chunkError.message }, { status: 500 });

  const { error: reviewError } = await db
    .from('classification_review_queue')
    .update({
      status: 'approved',
      reviewer: reviewer || 'admin',
      review_notes: notes || null,
      reviewed_at: new Date().toISOString(),
      proposed_metadata: { ...queueItem.proposed_metadata, ...patch }
    })
    .eq('id', queueItem.id);

  if (reviewError) return Response.json({ ok: false, error: reviewError.message }, { status: 500 });
  return Response.json({ ok: true, status: 'approved', metadata: chunkPatch });
}
