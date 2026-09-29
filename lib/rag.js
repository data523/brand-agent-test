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

export async function retrieve(args) {
  const { brandId, query, ...filters } = args;
  const [embedding] = await embedTexts([query]);
  const { data, error } = await supabase().rpc('match_brand_chunks', {
    p_brand_id: brandId, p_query_embedding: embedding,
    p_query_text: query, p_match_count: filters.matchCount ?? 12,
    p_document_types: listOrNull(filters.documentTypes),
    p_excluded_document_types: listOrNull(filters.excludedDocumentTypes),
    p_preferred_domains: listOrNull(filters.preferredDomains),
    p_knowledge_scope: filters.knowledgeScope || 'unknown',
    p_knowledge_scopes: listOrNull(filters.knowledgeScopes),
    p_entity_name: filters.entityName || null,
    p_require_official: Boolean(filters.requireOfficial),
    p_require_current: Boolean(filters.requireCurrent),
    p_include_superseded: Boolean(filters.includeSuperseded)
  });
  if (error) throw new Error(`RAG retrieval failed: ${error.message}`);
  return data || [];
}
