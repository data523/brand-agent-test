import { supabase } from './db.js';
import { embedTexts } from './openai.js';
import { chunkText } from './text.js';
import { classifyContent } from './knowledge.js';

function listOrNull(value) {
  return Array.isArray(value) && value.length ? value : null;
}

function normalizeDocumentKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function ingestDocument({
  brandId, title, text, source = 'manual', documentType = 'general',
  date = null, replace = false, metadata = null, sourcePath = null,
  sourceMetadata = null, visualMetadata = null
}) {
  const chunks = chunkText(text);
  if (!chunks.length) return { inserted: 0, metadata: null };

  const semantic = metadata || await classifyContent({
    title, text, source, documentTypeHint: documentType,
    sourceDate: date, sourcePath, sourceMetadata
  });

  const documentKey = normalizeDocumentKey(sourcePath || title || source);
  let supersededByVersion = false;

  if (documentKey) {
    const { data: existingVersions, error: versionError } = await supabase().from('brand_chunks')
      .select('source,source_date')
      .eq('brand_id', brandId)
      .eq('document_key', documentKey)
      .neq('source', source)
      .limit(100);
    if (versionError && !/document_key/i.test(versionError.message)) {
      throw new Error(`RAG versioning lookup failed: ${versionError.message}`);
    }

    const incomingTime = date ? Date.parse(date) : Number.POSITIVE_INFINITY;
    const existingMaxTime = Math.max(...(existingVersions || []).map(row => row.source_date ? Date.parse(row.source_date) : Number.NEGATIVE_INFINITY));
    supersededByVersion = Number.isFinite(existingMaxTime) && incomingTime < existingMaxTime;

    if (!supersededByVersion && existingVersions?.length) {
      const { error: supersedeError } = await supabase().from('brand_chunks')
        .update({ is_superseded: true, is_current_candidate: false })
        .eq('brand_id', brandId)
        .eq('document_key', documentKey)
        .neq('source', source);
      if (supersedeError) throw new Error(`RAG versioning failed: ${supersedeError.message}`);
    }
  }

  if (replace) {
    const { error: deleteError } = await supabase().from('brand_chunks').delete().eq('brand_id', brandId).eq('source', source);
    if (deleteError) throw new Error(`RAG replace failed: ${deleteError.message}`);
  }

  const embeddingInputs = chunks.map(chunk =>
    [title, semantic.knowledge_scope, semantic.entity_name, semantic.summary, semantic.topics?.join(', '),
      visualMetadata?.summary, visualMetadata?.elements?.join(', '), visualMetadata?.colors?.join(', '),
      visualMetadata?.composition?.join(', '), visualMetadata?.hierarchy?.join(', '),
      visualMetadata?.logoPlacement?.join(', '), chunk].filter(Boolean).join('\n')
  );
  const embeddings = await embedTexts(embeddingInputs);

  const rows = chunks.map((content, index) => {
    const matches = [...String(content).matchAll(/\[(PAGE|SLIDE)\s+(\d+)\]/gi)];
    const locations = new Set(matches.map(match => `${match[1].toLowerCase()} ${match[2]}`));
    const visualPageEvidence = Array.isArray(visualMetadata?.pageAnalyses)
      ? visualMetadata.pageAnalyses.filter(page => page?.location && locations.has(String(page.location).toLowerCase()))
      : [];
    return {
      brand_id: brandId, title, source,
      document_type: semantic.document_type || documentType, source_date: date,
      chunk_index: index, content, embedding: embeddings[index],
      knowledge_scope: semantic.knowledge_scope || 'unknown', owner: semantic.owner || 'unknown',
      entity_name: semantic.entity_name || null, entity_aliases: semantic.entity_aliases || [],
      entity_type: semantic.entity_type || 'unknown', source_path: sourcePath || null,
      source_location: matches.at(-1) ? `${matches.at(-1)[1].toLowerCase()} ${matches.at(-1)[2]}` : null,
      knowledge_domains: semantic.knowledge_domains || [], purpose: semantic.purpose || 'general',
      authority: semantic.authority || 'medium', status: semantic.status || 'unknown',
      is_brand_reference: Boolean(semantic.is_brand_reference),
      is_current_candidate: semantic.is_current_candidate !== false,
      brands: semantic.brands || [], projects: semantic.projects || [],
      campaigns: semantic.campaigns || [], products: semantic.products || [],
      topics: semantic.topics || [], summary: semantic.summary || '',
      effective_date: semantic.effective_date || date || null,
      supersedes: semantic.supersedes || [],
      classification_confidence: semantic.confidence || 0.05,
      classification_reason: semantic.classification_reason || '',
      visual_summary: visualMetadata?.summary || '', visual_elements: visualMetadata?.elements || [],
      visual_colors: visualMetadata?.colors || [], visual_typography: visualMetadata?.typography || [],
      visual_layout: visualMetadata?.layout || [], visual_composition: visualMetadata?.composition || [],
      visual_hierarchy: visualMetadata?.hierarchy || [], visual_spacing: visualMetadata?.spacing || [],
      visual_logo_placement: visualMetadata?.logoPlacement || [], visual_text_alignment: visualMetadata?.textAlignment || [],
      visual_confidence: Number(visualMetadata?.confidence || 0), visual_pages: visualPageEvidence,
      is_superseded: supersededByVersion, document_key: documentKey
    };
  });

  const { error } = await supabase().from('brand_chunks').insert(rows);
  if (error) throw new Error(`RAG ingest failed: ${error.message}`);
  return { inserted: rows.length, metadata: semantic };
}

async function callMatchBrandChunks(params) {
  const { data, error } = await supabase().rpc('match_brand_chunks', params);
  if (error) throw error;
  return data || [];
}

function normalizeForSearch(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();
}

function directRelevanceScore(row, query) {
  const q = normalizeForSearch(query);
  const text = normalizeForSearch([
    row.title, row.content, row.summary, row.entity_name,
    ...(row.knowledge_domains || []), ...(row.topics || []),
    ...(row.visual_colors || []), ...(row.visual_typography || [])
  ].join(' '));
  if (!q || !text) return 0;
  const terms = [...new Set(q.split(/\s+/).filter(term => term.length > 2))];
  if (!terms.length) return 0;
  const hits = terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
  const exact = text.includes(q) ? 0.35 : 0;
  const authority = row.authority === 'very_high' ? 0.18 : row.authority === 'high' ? 0.12 : row.authority === 'medium' ? 0.05 : 0;
  const current = row.status === 'approved' || row.status === 'current' ? 0.10 : 0;
  return hits / terms.length + exact + authority + current;
}

async function directBrandFallback({ brandId, query, filters }) {
  const db = supabase();
  const requestedScopes = Array.isArray(filters.knowledgeScopes) && filters.knowledgeScopes.length
    ? filters.knowledgeScopes
    : null;
  const allowedScopes = requestedScopes || (filters.knowledgeScope && filters.knowledgeScope !== 'unknown'
    ? [filters.knowledgeScope]
    : null);

  let request = db.from('brand_chunks')
    .select('id,brand_id,title,source,document_type,source_date,content,knowledge_scope,owner,entity_name,entity_type,authority,status,purpose,knowledge_domains,is_brand_reference,summary,source_path,source_location,lexical_score,visual_summary,visual_elements,visual_colors,visual_typography,visual_layout,visual_composition,visual_hierarchy,visual_spacing,visual_logo_placement,visual_text_alignment,visual_confidence,visual_pages,document_key,is_superseded,entity_aliases,brands,projects,campaigns,products,topics')
    .eq('brand_id', brandId)
    .limit(Math.min(Math.max(Number(filters.fallbackLimit || 80), 20), 150));

  if (Array.isArray(filters.excludedDocumentTypes) && filters.excludedDocumentTypes.length) {
    request = request.not('document_type', 'in', `(${filters.excludedDocumentTypes.join(',')})`);
  }
  if (Array.isArray(filters.documentTypes) && filters.documentTypes.length) {
    request = request.in('document_type', filters.documentTypes);
  }
  if (allowedScopes?.length) {
    request = request.in('knowledge_scope', allowedScopes);
  }
  if (!filters.includeSuperseded) {
    request = request.or('is_superseded.is.null,is_superseded.eq.false');
  }
  if (filters.entityName) {
    const entity = String(filters.entityName).replace(/,/g, '');
    request = request.or([
      `entity_name.ilike.%${entity}%`,
      `title.ilike.%${entity}%`,
      `content.ilike.%${entity}%`
    ].join(','));
  }

  let { data, error } = await request;
  if (error) {
    // Last compatibility layer for installations that only have the original
    // brand_chunks columns. Never let a schema-version mismatch erase the brand.
    console.warn('[rag] modern direct fallback failed; trying base brand_chunks columns', error.message);
    let legacyRequest = db.from('brand_chunks')
      .select('id,brand_id,title,source,document_type,source_date,content')
      .eq('brand_id', brandId)
      .limit(Math.min(Math.max(Number(filters.fallbackLimit || 80), 20), 150));
    if (Array.isArray(filters.documentTypes) && filters.documentTypes.length) {
      legacyRequest = legacyRequest.in('document_type', filters.documentTypes);
    }
    const legacyResult = await legacyRequest;
    if (legacyResult.error) {
      console.error('[rag] legacy direct brand fallback failed', legacyResult.error);
      return [];
    }
    data = legacyResult.data || [];
  }

  const rows = Array.isArray(data) ? data : [];
  rows.sort((a, b) => directRelevanceScore(b, query) - directRelevanceScore(a, query));

  // Conflict/version questions need document diversity, not just the most
  // semantically similar chunks from one file. Surface one strong chunk from
  // each distinct document first, then fill remaining slots by relevance.
  if (filters.includeSuperseded && rows.length > (filters.matchCount ?? 12)) {
    const unique = [];
    const seenDocuments = new Set();
    for (const row of rows) {
      const key = row.document_key || row.source_path || row.title || row.source || String(row.id);
      if (seenDocuments.has(key)) continue;
      seenDocuments.add(key);
      unique.push(row);
      if (unique.length >= (filters.matchCount ?? 12)) break;
    }
    const used = new Set(unique.map(row => row.id));
    for (const row of rows) {
      if (unique.length >= (filters.matchCount ?? 12)) break;
      if (used.has(row.id)) continue;
      unique.push(row);
      used.add(row.id);
    }
    rows.splice(0, rows.length, ...unique);
  }

  // Exact visual/document questions need evidence-bearing rows even when the
  // embedding/RPC misses them. A second lexical pass is intentionally same-brand.
  if (!rows.length || rows[0] && directRelevanceScore(rows[0], query) < 0.15) {
    try {
      let lexical = db.from('brand_chunks')
        .select('id,brand_id,title,source,document_type,source_date,content,knowledge_scope,owner,entity_name,entity_type,authority,status,purpose,knowledge_domains,is_brand_reference,summary,source_path,source_location,lexical_score,visual_summary,visual_elements,visual_colors,visual_typography,visual_layout,visual_composition,visual_hierarchy,visual_spacing,visual_logo_placement,visual_text_alignment,visual_confidence,visual_pages,document_key,is_superseded,entity_aliases,brands,projects,campaigns,products,topics')
        .eq('brand_id', brandId)
        .textSearch('search_document', query, { type: 'websearch', config: 'simple' })
        .limit(60);
      if (allowedScopes?.length) lexical = lexical.in('knowledge_scope', allowedScopes);
      if (!filters.includeSuperseded) lexical = lexical.or('is_superseded.is.null,is_superseded.eq.false');
      if (Array.isArray(filters.excludedDocumentTypes) && filters.excludedDocumentTypes.length) {
        lexical = lexical.not('document_type', 'in', `(${filters.excludedDocumentTypes.join(',')})`);
      }
      const lexicalResult = await lexical;
      if (!lexicalResult.error) {
        const byId = new Map(rows.map(row => [row.id, row]));
        for (const row of lexicalResult.data || []) byId.set(row.id, row);
        rows.splice(0, rows.length, ...byId.values());
        rows.sort((a, b) => directRelevanceScore(b, query) - directRelevanceScore(a, query));
      }
    } catch (lexicalError) {
      console.warn('[rag] direct lexical fallback failed', lexicalError?.message || lexicalError);
    }
  }

  return rows.slice(0, filters.matchCount ?? 12);
}

export async function retrieve(args) {
  const { brandId, query, ...filters } = args;
  const [embedding] = await embedTexts([query]);
  const common = {
    p_brand_id: brandId,
    p_query_embedding: embedding,
    p_query_text: query,
    p_match_count: filters.matchCount ?? 12,
    p_document_types: listOrNull(filters.documentTypes),
    p_excluded_document_types: listOrNull(filters.excludedDocumentTypes),
    p_preferred_domains: listOrNull(filters.preferredDomains),
    p_knowledge_scope: filters.knowledgeScope || 'unknown',
    p_entity_name: filters.entityName || null,
    p_require_official: Boolean(filters.requireOfficial),
    p_require_current: Boolean(filters.requireCurrent)
  };
  const scopes = listOrNull(filters.knowledgeScopes);

  let rpcRows = [];
  try {
    rpcRows = await callMatchBrandChunks({
      ...common,
      p_knowledge_scopes: scopes,
      p_include_superseded: Boolean(filters.includeSuperseded)
    });
    if (rpcRows.length) return rpcRows;
  } catch (modernError) {
    console.warn('[rag] modern retrieval RPC failed; trying compatible signature', modernError?.message || modernError);
  }

  try {
    rpcRows = await callMatchBrandChunks({
      ...common,
      p_knowledge_scopes: scopes
    });
    if (rpcRows.length) return rpcRows;
  } catch (crossScopeError) {
    console.warn('[rag] cross-scope retrieval RPC unavailable; trying legacy signature', crossScopeError?.message || crossScopeError);
  }

  const legacyScopes = scopes?.length ? scopes : [filters.knowledgeScope || 'unknown'];
  const rows = [];
  const seen = new Set();

  for (const scope of legacyScopes) {
    try {
      const data = await callMatchBrandChunks({
        ...common,
        p_knowledge_scope: scope
      });
      for (const row of data || []) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          rows.push(row);
        }
      }
    } catch (legacyError) {
      try {
        const data = await callMatchBrandChunks({
          p_brand_id: brandId,
          p_query_embedding: embedding,
          p_match_count: filters.matchCount ?? 12,
          p_document_types: listOrNull(filters.documentTypes),
          p_excluded_document_types: listOrNull(filters.excludedDocumentTypes),
          p_preferred_domains: listOrNull(filters.preferredDomains),
          p_knowledge_scope: scope,
          p_entity_name: filters.entityName || null,
          p_require_official: Boolean(filters.requireOfficial),
          p_require_current: Boolean(filters.requireCurrent)
        });
        for (const row of data || []) {
          if (!seen.has(row.id)) {
            seen.add(row.id);
            rows.push(row);
          }
        }
      } catch (originalError) {
        console.error('[rag] compatible retrieval signatures failed for scope', {
          scope,
          legacy: legacyError?.message || String(legacyError),
          original: originalError?.message || String(originalError)
        });
      }
    }
  }

  if (rows.length) {
    return rows
      .sort((a, b) => Number(b.similarity || 0) - Number(a.similarity || 0))
      .slice(0, filters.matchCount ?? 12);
  }

  // Final same-brand database fallback. This deliberately ignores semantic
  // classification failures and RPC version drift, but never crosses brand_id.
  const directRows = await directBrandFallback({ brandId, query, filters });
  if (directRows.length) {
    console.warn('[rag] using direct same-brand fallback', { brandId, count: directRows.length });
    return directRows;
  }

  throw new Error('RAG retrieval failed: no compatible RPC or direct brand rows returned');
}
