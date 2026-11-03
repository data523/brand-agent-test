import { config } from '../../../../lib/config.js';
import { extractDriveText, inferDocumentType, listFilesRecursive } from '../../../../lib/google-drive.js';
import { ingestDocument } from '../../../../lib/rag.js';
import { analyzeVisualAssets } from '../../../../lib/vision.js';
import { supabase } from '../../../../lib/db.js';
import { refreshBrandIntelligence } from '../../../../lib/brand-intelligence.js';

export const runtime = 'nodejs';
export const maxDuration = 300;

const BATCH_SIZE = 3;

async function updateManifest(id, updates) {
  await supabase().from('ingestion_manifest').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', id);
}

async function getOrCreateManifest(brandId, file) {
  const sourceKey = `gdrive:${file.id}`;
  const { data: existing } = await supabase()
    .from('ingestion_manifest')
    .select('*')
    .eq('brand_id', brandId)
    .eq('source', sourceKey)
    .single();

  if (existing) return { manifest: existing, isNew: false };

  const { data: created, error } = await supabase()
    .from('ingestion_manifest')
    .insert({
      brand_id: brandId,
      source: sourceKey,
      source_path: file.sourcePath,
      file_name: file.name,
      mime_type: file.mimeType,
      file_size: file.size || null,
      status: 'pending'
    })
    .select()
    .single();

  if (error) throw error;
  return { manifest: created, isNew: true };
}

async function processFile(brandId, file, token, manifestId) {
  await updateManifest(manifestId, { status: 'processing', started_at: new Date().toISOString() });

  try {
    const extracted = await extractDriveText(file, token);
    if (extracted.skipped || !extracted.text) {
      await updateManifest(manifestId, { status: 'skipped', skip_reason: extracted.skipped || 'No text', completed_at: new Date().toISOString() });
      return { name: file.name, path: file.sourcePath, status: 'skipped', reason: extracted.skipped || 'No text' };
    }

    const sourceKey = `gdrive:${file.id}`;
    const { data: existingReview } = await supabase()
      .from('classification_review_queue')
      .select('status, proposed_metadata')
      .eq('brand_id', brandId)
      .eq('source', sourceKey)
      .maybeSingle();
    const reviewedMetadata = existingReview?.status === 'approved' && existingReview?.proposed_metadata
      ? existingReview.proposed_metadata
      : null;

    let visualMetadata = null;
    if (process.env.VISION_ENABLED !== 'false' && (extracted.visualAssets?.length || extracted.renderedPages?.length)) {
      visualMetadata = await analyzeVisualAssets({
        title: file.name,
        sourcePath: file.sourcePath,
        assets: extracted.visualAssets,
        pages: extracted.renderedPages || [],
        visualContext: extracted.text.slice(0, 5000)
      });
    }

    const result = await ingestDocument({
      brandId,
      title: file.name,
      text: extracted.text,
      source: sourceKey,
      metadata: reviewedMetadata,
      documentType: inferDocumentType(file.name),
      date: file.modifiedTime || null,
      sourcePath: file.sourcePath,
      visualMetadata,
      sourceMetadata: {
        mimeType: file.mimeType,
        webViewLink: file.webViewLink || null,
        description: file.description || null,
        parserFormat: extracted.format || null,
        pageCount: extracted.pageCount || null,
        parserMetadata: extracted.parserMetadata || null
      },
      replace: true
    });

    const confidence = Number(result.metadata?.confidence || 0);
    const needsReview = !reviewedMetadata && (result.metadata?.knowledge_scope === 'unknown' || confidence < 0.6);

    if (needsReview) {
      const { error: reviewError } = await supabase()
        .from('classification_review_queue')
        .upsert({
          brand_id: brandId,
          source: sourceKey,
          title: file.name,
          source_path: file.sourcePath,
          knowledge_scope: result.metadata?.knowledge_scope || 'unknown',
          owner: result.metadata?.owner || 'unknown',
          entity_name: result.metadata?.entity_name || null,
          document_type: result.metadata?.document_type || inferDocumentType(file.name),
          classification_confidence: confidence,
          classification_reason: result.metadata?.classification_reason || '',
          status: 'pending',
          proposed_metadata: result.metadata || {}
        }, { onConflict: 'brand_id,source' });

      if (reviewError) {
        await updateManifest(manifestId, { status: 'review_queue_error', error_message: reviewError.message, completed_at: new Date().toISOString() });
        return { name: file.name, path: file.sourcePath, status: 'review_queue_error', chunks: result.inserted, error: reviewError.message };
      }
    }

    await updateManifest(manifestId, {
      status: needsReview ? 'indexed_needs_review' : 'ingested',
      chunks_count: result.inserted,
      visual_analyzed: !!visualMetadata,
      vision_pages: visualMetadata?.pagesAnalyzed || 0,
      vision_assets: visualMetadata?.assetsAnalyzed || 0,
      vision_confidence: visualMetadata?.confidence || null,
      document_type: result.metadata?.document_type,
      knowledge_scope: result.metadata?.knowledge_scope,
      authority: result.metadata?.authority,
      completed_at: new Date().toISOString()
    });

    return {
      name: file.name,
      path: file.sourcePath,
      status: needsReview ? 'indexed_needs_review' : 'ingested',
      chunks: result.inserted,
      classification: result.metadata,
      visual: visualMetadata ? { assetsAnalyzed: visualMetadata.assetsAnalyzed, pagesAnalyzed: visualMetadata.pagesAnalyzed, confidence: visualMetadata.confidence, colors: visualMetadata.colors } : null
    };
  } catch (error) {
    await updateManifest(manifestId, { status: 'failed', error_message: error.message, completed_at: new Date().toISOString() });
    return { name: file.name, path: file.sourcePath, status: 'error', error: error.message };
  }
}

export async function POST(request) {
  const auth = request.headers.get('authorization') || '';
  if (auth !== `Bearer ${config().adminSecret}`) return Response.json({ ok: false }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const brandId = body.brandId;
  const folderId = body.folderId || config().googleDriveFolderId;
  const cursor = body.cursor || 0; // file index to start from
  if (!brandId || !folderId) return Response.json({ ok: false, error: 'brandId and folderId are required' }, { status: 400 });

  const { token, files: allFiles } = await listFilesRecursive(folderId);
  const totalFiles = allFiles.length;
  const filesToProcess = allFiles.slice(cursor, cursor + BATCH_SIZE);

  if (filesToProcess.length === 0) {
    // All done, refresh brand intelligence
    let brandIntelligence = null;
    try {
      brandIntelligence = await refreshBrandIntelligence({ brandId });
    } catch (error) {
      console.error('[drive-sync-batched] Brand Intelligence refresh failed', error);
      brandIntelligence = { generated: false, error: error.message };
    }
    return Response.json({ ok: true, brandId, folderId, complete: true, totalFiles, processed: totalFiles, brandIntelligence });
  }

  const results = [];
  for (const file of filesToProcess) {
    const { manifest } = await getOrCreateManifest(brandId, file);
    if (manifest.status === 'ingested' || manifest.status === 'indexed_needs_review' || manifest.status === 'skipped') {
      // Already processed, skip
      results.push({ name: file.name, path: file.sourcePath, status: manifest.status, chunks: manifest.chunks_count, cached: true });
      continue;
    }
    const result = await processFile(brandId, file, token, manifest.id);
    results.push(result);
  }

  const nextCursor = cursor + filesToProcess.length;
  const complete = nextCursor >= totalFiles;

  let brandIntelligence = null;
  if (complete) {
    try {
      brandIntelligence = await refreshBrandIntelligence({ brandId });
    } catch (error) {
      console.error('[drive-sync-batched] Brand Intelligence refresh failed', error);
      brandIntelligence = { generated: false, error: error.message };
    }
  }

  return Response.json({
    ok: true,
    brandId,
    folderId,
    cursor: nextCursor,
    complete,
    totalFiles,
    processed: nextCursor,
    batchSize: filesToProcess.length,
    results,
    brandIntelligence
  });
}