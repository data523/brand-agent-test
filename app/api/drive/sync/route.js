import { config } from '../../../../lib/config.js';
import { extractDriveText, inferDocumentType, listFilesRecursive } from '../../../../lib/google-drive.js';
import { ingestDocument } from '../../../../lib/rag.js';
import { analyzeVisualAssets } from '../../../../lib/vision.js';
import { supabase } from '../../../../lib/db.js';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request) {
  const auth = request.headers.get('authorization') || '';
  if (auth !== `Bearer ${config().adminSecret}`) return Response.json({ ok: false }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const brandId = body.brandId;
  const folderId = body.folderId || config().googleDriveFolderId;
  const fileId = body.fileId || null;
  if (!brandId || !folderId) return Response.json({ ok: false, error: 'brandId and folderId are required' }, { status: 400 });

  const { token, files: discoveredFiles } = await listFilesRecursive(folderId);
  const files = fileId ? discoveredFiles.filter((file) => file.id === fileId) : discoveredFiles;
  if (fileId && !files.length) return Response.json({ ok: false, error: 'fileId_not_found_in_folder' }, { status: 404 });
  const results = [];

  for (const file of files) {
    try {
      const extracted = await extractDriveText(file, token);
      if (extracted.skipped || !extracted.text) {
        results.push({
          name: file.name,
          path: file.sourcePath,
          mimeType: file.mimeType,
          status: 'skipped',
          reason: extracted.skipped || 'No text'
        });
        continue;
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
          results.push({
            name: file.name,
            path: file.sourcePath,
            status: 'review_queue_error',
            chunks: result.inserted,
            classification: result.metadata,
            error: reviewError.message
          });
          continue;
        }
      }

      results.push({
        name: file.name,
        path: file.sourcePath,
        status: needsReview ? 'indexed_needs_review' : 'indexed',
        chunks: result.inserted,
        classification: result.metadata,
        visual: visualMetadata ? {
          assetsAnalyzed: visualMetadata.assetsAnalyzed,
          pagesAnalyzed: visualMetadata.pagesAnalyzed,
          confidence: visualMetadata.confidence,
          colors: visualMetadata.colors
        } : null
      });
    } catch (error) {
      results.push({ name: file.name, path: file.sourcePath, status: 'error', error: error.message });
    }
  }

  return Response.json({ ok: true, brandId, folderId, filesFound: files.length, results });
}
