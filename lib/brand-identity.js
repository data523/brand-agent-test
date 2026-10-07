import { config } from './config.js';
import { openai } from './openai.js';
import { renderDocumentPages } from './document-renderer.js';
import { parseOfficeBuffer } from './document-parser.js';
import { parseOfficeBuffer as parseOfficeBufferImport } from './document-parser.js';

const REGISTRY_PATH = '/Users/uday/OpenBot/Shared/BrandAgent/BRAND_REGISTRY.md';

const VISION_MODEL = 'gpt-4o';

const KNOWN_BAD_NAMES = new Set([
  'asc', 'lllf', 'lll', 'impact maker', 'impact_maker', 'creative guidelines',
  'social media guidelines', 'print template', 'brand book', 'brandbook',
  'style book', 'stylebook', 'playbook', 'guidelines', 'guide',
  'branding guidelines', 'brand identity', 'visual identity'
]);

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function slugify(text) {
  return String(text).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function looksLikeBadName(name) {
  const n = String(name).toLowerCase().trim();
  if (KNOWN_BAD_NAMES.has(n)) return true;
  if (n.length < 3) return true;
  if (/^(the|a|an|of|for|and|or|with|by|brand|identity|guidelines|guidelines?)$/.test(n)) return true;
  if (/^\d+$/.test(n)) return true;
  return false;
}

function normalizeAlias(a) {
  return String(a).trim().toLowerCase().replace(/[^a-z0-9\s-]/g, '');
}

function validateName(name, aliases) {
  const nameStr = String(name).trim();
  const aliasList = (aliases || []).map(a => String(a).trim().toLowerCase()).filter(Boolean);
  
  if (!nameStr || nameStr.length < 3) return { ok: false, reason: 'Name too short or missing' };
  if (looksLikeBadName(nameStr)) return { ok: false, reason: `Name "${nameStr}" is a known bad pattern` };
  
  const allNames = [nameStr.toLowerCase(), ...aliasList];
  for (const n of allNames) {
    if (KNOWN_BAD_NAMES.has(n)) return { ok: false, reason: `Bad name/alias: "${n}"` };
  }
  
  if (aliasList.length === 0) return { ok: false, reason: 'At least one alias required' };
  
  return { ok: true };
}

async function extractFirstPageText(buffer, fileType) {
  try {
    const parsed = await parseOfficeBuffer(buffer, { fileType: 'pdf', enableOcr: true });
    return parsed.text || '';
  } catch (error) {
    console.warn('PDF text extraction failed:', error.message);
    return '';
  }
}

async function analyzeFirstPageImage(buffer, title, sourcePath) {
  try {
    const pages = await renderDocumentPages(buffer, { fileType: 'pdf' });
    const firstPage = pages.find(p => p?.data && /^image\//i.test(p.mimeType || ''));
    if (!firstPage) return null;
    
    const { openai } = await import('./openai.js');
    const { visionModel } = await import('./config.js');
    
    const result = await openai().responses.create({
      model: 'gpt-4o',
      reasoning: { effort: 'low' },
      instructions: 'Analyze the COMPLETE rendered page as a brand designer. Identify: 1) Full official brand name on the page, 2) Any logo alt-text or logo text, 3) One-line description of what the brand is, 4) Any short name/abbreviation/alias visible. Return ONLY JSON with: full_name, logo_alt_text, one_liner, short_name, confidence (0-1).',
      input: [{ role: 'user', content: [
        { type: 'input_text', text: `Document: ${title}\nPath: ${sourcePath}\nAnalyze the first page for brand identity.` },
        { type: 'input_image', image_url: 'data:' + firstPage.mimeType + ';base64,' + firstPage.data }
      ] }],
      max_output_tokens: 800
    });
    
    const text = result.output_text?.trim() || '';
    const parsed = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    try { return JSON.parse(parsed); } catch { return null; }
  } catch (error) {
    console.warn('Vision analysis failed:', error.message);
    return null;
  }
}

function deriveFromFilenames(files) {
  const pdfs = files.filter(f => /\.pdf$/i.test(f.name));
  if (!pdfs.length) return null;
  
  const candidates = pdfs
    .filter(f => /brand.?book|brandboo+k|style.?book|playbook|guideline/.test(f.name.toLowerCase()))
    .sort((a, b) => b.bytes - a.bytes);
  
  const primary = candidates[0] || pdfs.sort((a, b) => b.bytes - a.bytes)[0];
  if (!primary) return null;
  
  const nameFromFile = primary.name
    .replace(/\.pdf$/i, '')
    .replace(/[_-](v\d+|vo\d+|\d{6,8}|\d{4}[-_]\d{2}[-_]\d{2})$/i, '')
    .replace(/[_-](brand.?book|brandboo+k|style.?book|playbook|guidelines?)$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  
  const folderName = primary.relPath.split('/')[0];
  
  return {
    folderName,
    primaryPdf: primary.name,
    primaryBytes: primary.bytes,
    nameHint: nameFromFile
  };
}

function deriveFromText(text) {
  if (!text) return null;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const firstLines = lines.slice(0, 10).join(' ');
  return firstLines.slice(0, 500);
}

function deriveFromVision(vision) {
  if (!vision) return null;
  return {
    fullName: vision.full_name,
    logoAltText: vision.logo_alt_text,
    oneLiner: vision.one_liner,
    shortName: vision.short_name,
    confidence: vision.confidence || 0
  };
}

async function deriveBrandIdentity({ folder, files, brandId, client, bufferMap }) {
  const fileHint = deriveFromFilenames(files);
  if (!fileHint) return { ok: false, reason: 'No candidate PDF found' };
  
  const primaryFile = files.find(f => f.name === fileHint.primaryPdf);
  if (!primaryFile) return { ok: false, reason: 'Primary PDF not found in file list' };
  
  if (primaryFile.bytes > 150 * 1024 * 1024) {
    return { ok: false, reason: `Primary PDF too large (${primaryFile.bytes} bytes) for vision analysis` };
  }
  
  const buffer = bufferMap?.get(primaryFile.relPath) || await client.download(primaryFile, { maxBytes: 150 * 1024 * 1024 });
  
  const text = await extractFirstPageText(buffer, 'pdf');
  const vision = await analyzeFirstPageImage(buffer, fileHint.primaryPdf, `dropbox:${fileHint.primaryPdf}`);
  const textHint = deriveFromText(text);
  const visionData = deriveFromVision(vision);
  
  let fullName = visionData?.fullName || fileHint.nameHint || fileHint.folderName;
  let shortName = visionData?.shortName || fileHint.folderName;
  let oneLiner = visionData?.oneLiner || 'Brand identity derived from Dropbox folder';
  let confidence = visionData?.confidence || 0;
  
  if (!fullName || looksLikeBadName(fullName)) {
    if (fileHint.nameHint && !looksLikeBadName(fileHint.nameHint)) {
      fullName = fileHint.nameHint;
    } else if (fileHint.folderName && !looksLikeBadName(fileHint.folderName)) {
      fullName = fileHint.folderName;
    } else {
      return { ok: false, reason: 'Could not derive valid full name' };
    }
  }
  
  const aliases = new Set([normalizeAlias(brandId), normalizeAlias(fileHint.folderName)]);
  if (visionData?.shortName) aliases.add(normalizeAlias(visionData.shortName));
  if (fileHint.nameHint && !looksLikeBadName(fileHint.nameHint)) aliases.add(normalizeAlias(fileHint.nameHint));
  if (fullName && fullName !== shortName) aliases.add(normalizeAlias(fullName));
  
  const aliasArray = [...aliases].filter(a => a && a.length >= 2);
  
  const validation = validateName(fullName, aliasArray);
  if (!validation.ok) return { ok: false, reason: validation.reason };
  
  return {
    ok: true,
    brandId,
    fullName,
    shortName,
    aliases: [...new Set(aliasArray)],
    oneLiner,
    confidence,
    sourcePdf: fileHint.primaryPdf,
    sourceBytes: fileHint.primaryBytes,
    derivedFrom: vision ? 'vision' : 'filenames'
  };
}

async function updateRegistry(derived) {
  const fs = await import('fs');
  const path = await import('path');
  
  const registryPath = REGISTRY_PATH;
  let content = '';
  try {
    content = await fs.promises.readFile(registryPath, 'utf8');
  } catch {
    content = '';
  }
  
  const lines = content.split('\n');
  const headerEnd = lines.findIndex(l => l.startsWith('| brand_id |'));
  const headerLines = lines.slice(0, headerEnd + 2);
  const dataLines = lines.slice(headerEnd + 2).filter(l => l.trim() && !l.startsWith('##'));
  
  const existingIdx = dataLines.findIndex(l => l.startsWith(`| ${derived.brandId} |`));
  
  const newRow = `| ${derived.brandId} | ${derived.shortName} | ${derived.fullName} | ${derived.aliases.join(', ')} | ${derived.oneLiner} | PDF: ${derived.sourcePdf} (${Math.round(derived.sourceBytes / 1024 / 1024)} MB) |`;
  
  if (existingIdx >= 0) {
    dataLines[existingIdx] = newRow;
  } else {
    dataLines.push(newRow);
  }
  
  const newContent = [...headerLines, ...dataLines, '', '## Notes', '- Auto-updated by ingestion pipeline'].join('\n');
  await fs.promises.writeFile(registryPath, newContent, 'utf8');
}

async function validateAndRegister({ folder, files, brandId, client, bufferMap }) {
  const derived = await deriveBrandIdentity({ folder, files, brandId, client, bufferMap: null });
  
  if (!derived.ok) {
    return { ok: false, reason: derived.reason, derived: null };
  }
  
  const validation = validateName(derived.fullName, derived.aliases);
  if (!validation.ok) {
    return { ok: false, reason: `Validation failed: ${validation.reason}`, derived: null };
  }
  
  if (derived.confidence < 0.6) {
    return { ok: false, reason: `Confidence too low (${derived.confidence})`, derived: null };
  }
  
  await updateRegistry(derived);
  
  return { ok: true, derived };
}

export {
  deriveBrandIdentity,
  validateAndRegister,
  updateRegistry,
  extractFirstPageText,
  analyzeFirstPageImage,
  deriveFromFilenames,
  validateName,
  REGISTRY_PATH
};