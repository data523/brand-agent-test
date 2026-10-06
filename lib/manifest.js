import crypto from 'node:crypto';
import { supabase } from './db.js';

export function contentHash(text = '') {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

// Every file we look at leaves one row here (ingested / skipped / failed), so we
// can always see what was kept or ignored and why. A manifest write must never
// break ingestion itself, so errors are logged and swallowed.
export async function recordManifest({
  brandId, source, sourcePath = null, title = null, mimeType = null,
  contentHash: hash = null, status, skipReason = null, error = null, chunkCount = 0
}, db = supabase()) {
  if (!brandId || !source) return;
  const now = new Date().toISOString();
  try {
    const { error: writeError } = await db.from('ingestion_manifest').upsert({
      brand_id: brandId,
      source,
      source_path: sourcePath,
      title,
      mime_type: mimeType,
      content_hash: hash,
      status,
      skip_reason: skipReason,
      error: error ? String(error).slice(0, 500) : null,
      chunk_count: chunkCount,
      last_attempt_at: now,
      ingested_at: status === 'ingested' ? now : undefined
    }, { onConflict: 'brand_id,source' });
    if (writeError) console.error('[manifest] write failed', writeError.message);
  } catch (writeError) {
    console.error('[manifest] write failed', writeError?.message || writeError);
  }
}
