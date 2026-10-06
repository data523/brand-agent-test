import { config } from '../../../../lib/config.js';
import { supabase } from '../../../../lib/db.js';
import { ingestDocument } from '../../../../lib/rag.js';
import { recordManifest } from '../../../../lib/manifest.js';
import { parseOfficeBuffer } from '../../../../lib/document-parser.js';
import { parseSwatchFile, describeColor } from '../../../../lib/swatch.js';
import {
  openSharedLink, classifyFile, documentTypeFromName, dateFromName, buildInventoryText
} from '../../../../lib/dropbox.js';

export const runtime = 'nodejs';
export const maxDuration = 300;

const DEFAULT_MAX_BYTES = 60 * 1024 * 1024;
const OLD_VERSION = /(^|[\/ _.-])old([\/ _.-]|$)/i;

// Metadata for records we build ourselves (swatches, inventory), so they skip the LLM classifier.
function builtInMetadata({ brandName, documentType, domains, authority, summary, topics, reason }) {
  return {
    knowledge_scope: 'client_brand', owner: 'client', entity_name: brandName, entity_aliases: [], entity_type: 'brand',
    document_type: documentType, knowledge_domains: domains, purpose: 'brand_reference', authority, status: 'current',
    is_brand_reference: true, is_current_candidate: true, brands: [brandName], projects: [], campaigns: [], products: [],
    topics, summary, supersedes: [], confidence: 1, classification_reason: reason
  };
}

async function ingestSwatch({ brandId, brandName, folder, file, buffer }) {
  const colors = parseSwatchFile(file.name, buffer);
  if (!colors.length) return { inserted: 0 };
  const text = `OFFICIAL COLOUR SWATCH FILE "${file.name}" for ${brandName} (values read directly from the supplied swatch file):\n${colors.map((c) => `- ${describeColor(c)}`).join('\n')}`;
  return ingestDocument({
    brandId, title: file.name, text, source: `dropbox:${file.fileId || file.relPath}`, documentType: 'brand_identity',
    sourcePath: `${folder}/${file.relPath}`, replace: true,
    sourceMetadata: { mimeType: 'application/x-adobe-swatch', swatchCount: colors.length },
    metadata: builtInMetadata({
      brandName, documentType: 'brand_identity', domains: ['visual_identity', 'colors'], authority: 'high',
      summary: `Official colour swatches for ${brandName} (${colors.length} colours) from the supplied swatch file.`,
      topics: ['colour palette', 'swatches'], reason: 'Swatch file supplied in the brand folder; values come from the file.'
    }),
    visualMetadata: {
      summary: 'Official swatch file', colors: colors.map((c) => (c.model === 'RGB' ? `${c.name} ${c.hex}` : describeColor(c))), confidence: 1
    }
  });
}

async function ingestFileDocument({ brandId, folder, file, buffer }) {
  const isPdf = /\.pdf$/i.test(file.name);
  const text = /\.txt$/i.test(file.name)
    ? buffer.toString('utf8').trim()
    : (await parseOfficeBuffer(buffer, { fileType: isPdf ? 'pdf' : 'pptx', enableOcr: process.env.DOCUMENT_PARSER_OCR === 'true' })).text;
  const result = await ingestDocument({
    brandId, title: file.name, text, source: `dropbox:${file.fileId || file.relPath}`,
    documentType: documentTypeFromName(file.name), date: dateFromName(file.name),
    sourcePath: `${folder}/${file.relPath}`, replace: true,
    sourceMetadata: { mimeType: isPdf ? 'application/pdf' : 'application/octet-stream', folder, relPath: file.relPath }
  });
  // Older versions stay searchable as history but must never win over the current one.
  if (result.inserted && OLD_VERSION.test(file.relPath)) {
    await supabase().from('brand_chunks')
      .update({ is_superseded: true, is_current_candidate: false, status: 'historical' })
      .eq('brand_id', brandId).eq('source', `dropbox:${file.fileId || file.relPath}`);
  }
  return result;
}

export async function POST(request) {
  // Accepts the normal admin secret, or a token scoped to this endpoint (DROPBOX_SYNC_TOKEN).
  const bearer = request.headers.get('authorization') || '';
  const scoped = process.env.DROPBOX_SYNC_TOKEN;
  if (bearer !== `Bearer ${config().adminSecret}` && !(scoped && bearer === `Bearer ${scoped}`)) return Response.json({ ok: false }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const { brandId, folder, dryRun = false, onlyPaths = null, inventoryOnly = false } = body;
  const maxBytes = Number(body.maxBytes || process.env.DROPBOX_MAX_BYTES || DEFAULT_MAX_BYTES);
  const link = process.env.DROPBOX_SHARED_LINK;
  if (!brandId || !folder) return Response.json({ ok: false, error: 'brandId and folder are required' }, { status: 400 });
  if (!link) return Response.json({ ok: false, error: 'DROPBOX_SHARED_LINK is not configured' }, { status: 500 });

  const { data: brand } = await supabase().from('brands').select('id,name,status').eq('id', brandId).maybeSingle();
  if (!brand) return Response.json({ ok: false, error: `Unknown brand "${brandId}". Add it to the brands table first.` }, { status: 404 });

  const client = await openSharedLink(link);
  const listing = await client.listBrandFolder(folder);
  const plan = listing.files.map((file) => ({ file, ...classifyFile(file) }));

  if (dryRun) {
    const summary = {};
    for (const item of plan) summary[`${item.action}:${item.kind}`] = (summary[`${item.action}:${item.kind}`] || 0) + 1;
    return Response.json({
      ok: true, dryRun: true, brandId, folder: listing.folder, files: plan.length, summary,
      toIngest: plan.filter((i) => i.action === 'ingest').map((i) => ({ path: i.file.relPath, bytes: i.file.bytes, kind: i.kind, tooLarge: i.file.bytes > maxBytes }))
    });
  }

  const results = [];
  const selected = Array.isArray(onlyPaths) && onlyPaths.length ? new Set(onlyPaths) : null;

  // inventoryOnly: skip parsing and only write the asset inventory + manifest rows for skipped/name-only files.
  for (const item of plan.filter((i) => !inventoryOnly && i.action === 'ingest' && (!selected || selected.has(i.file.relPath)))) {
    const { file } = item;
    const source = `dropbox:${file.fileId || file.relPath}`;
    const manifest = { brandId, source, sourcePath: `${listing.folder}/${file.relPath}`, title: file.name };
    try {
      if (file.bytes > maxBytes) {
        await recordManifest({ ...manifest, status: 'skipped', skipReason: `too_large_${file.bytes}_bytes` });
        results.push({ path: file.relPath, status: 'skipped', reason: 'too_large', bytes: file.bytes });
        continue;
      }
      const buffer = await client.download(file, { maxBytes });
      const result = item.kind === 'swatch'
        ? await ingestSwatch({ brandId, brandName: brand.name, folder: listing.folder, file, buffer })
        : await ingestFileDocument({ brandId, folder: listing.folder, file, buffer });
      results.push({ path: file.relPath, status: result.inserted ? 'ingested' : 'skipped', chunks: result.inserted, scope: result.metadata?.knowledge_scope || null });
    } catch (error) {
      // ingestDocument records its own failures; this covers download/parse errors before it runs.
      await recordManifest({ ...manifest, status: 'failed', error: error.message });
      results.push({ path: file.relPath, status: 'failed', error: error.message });
    }
  }

  // Logos, brand elements and fonts: kept as names only, in one inventory record per brand.
  const inventoryEntries = plan.filter((i) => i.action === 'inventory').map((i) => ({ kind: i.kind, relPath: i.file.relPath }));
  const inventoryText = buildInventoryText(brand.name, inventoryEntries);
  if (inventoryText && !selected) {
    try {
      const inv = await ingestDocument({
        brandId, title: `${brand.name} asset inventory`, text: inventoryText, source: `dropbox:inventory:${brandId}`,
        documentType: 'creative_asset', sourcePath: `${listing.folder}/(asset inventory)`, replace: true,
        metadata: builtInMetadata({
          brandName: brand.name, documentType: 'creative_asset', domains: ['visual_identity', 'assets'], authority: 'low',
          summary: `Names of logo, brand-element and font files supplied for ${brand.name}. Names only.`,
          topics: ['logo files', 'brand elements', 'fonts supplied'], reason: 'Built from file names in the brand folder.'
        })
      });
      results.push({ path: '(asset inventory)', status: 'ingested', chunks: inv.inserted });
    } catch (error) {
      results.push({ path: '(asset inventory)', status: 'failed', error: error.message });
    }
  }

  // Everything not parsed still leaves a manifest row, so skips are visible.
  if (!selected) {
    for (const item of plan.filter((i) => i.action !== 'ingest')) {
      await recordManifest({
        brandId, source: `dropbox:${item.file.fileId || item.file.relPath}`, sourcePath: `${listing.folder}/${item.file.relPath}`,
        title: item.file.name, status: 'skipped', skipReason: item.reason
      });
    }
  }

  const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
  return Response.json({ ok: true, brandId, folder: listing.folder, filesFound: plan.length, counts, results });
}
