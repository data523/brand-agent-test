// Token-free reader for a view-only Dropbox shared folder link.
// Uses the same endpoint the Dropbox web page uses (see Shared/BrandAgent/DROPBOX_ACCESS_NOTES.md).
// It is unofficial: if Dropbox changes it, listing fails loudly instead of returning partial data.

const LIST_URL = 'https://www.dropbox.com/list_shared_link_folder_entries';
const UA = 'Mozilla/5.0 (compatible; BrandAgent/1.0)';

export function parseSharedLink(link) {
  const url = new URL(link);
  const match = url.pathname.match(/^\/scl\/fo\/([^/]+)\/([^/]+)/);
  const rlkey = url.searchParams.get('rlkey');
  if (!match || !rlkey) throw new Error('Not a Dropbox shared folder link (expected /scl/fo/<key>/<hash>?rlkey=...)');
  return { linkKey: match[1], rootHash: match[2], rlkey, link };
}

// Directory/file entries carry their own href: /scl/fo/<key>/<hash>/<path>?rlkey=...
function hashAndPath(href) {
  const match = new URL(href).pathname.match(/^\/scl\/fo\/[^/]+\/([^/]+)\/(.+)$/);
  if (!match) throw new Error('Unexpected Dropbox entry link');
  return { secureHash: match[1], subPath: `/${decodeURIComponent(match[2])}` };
}

export async function openSharedLink(link, { fetchImpl = fetch } = {}) {
  const info = parseSharedLink(link);
  const first = await fetchImpl(link, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!first.ok) throw new Error(`Dropbox share link returned ${first.status}`);
  await first.arrayBuffer();
  const cookies = (first.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]);
  const csrf = cookies.find((c) => c.startsWith('t='))?.slice(2);
  if (!csrf) throw new Error('Dropbox did not return a session token for the share link');
  const cookieHeader = cookies.join('; ');

  async function listPage({ secureHash, subPath, voucher }) {
    const form = new URLSearchParams({
      t: csrf, link_key: info.linkKey, link_type: 's', secure_hash: secureHash, rlkey: info.rlkey, sub_path: subPath
    });
    if (voucher) form.set('voucher', typeof voucher === 'string' ? voucher : JSON.stringify(voucher));
    const response = await fetchImpl(LIST_URL, {
      method: 'POST',
      headers: { 'user-agent': UA, cookie: cookieHeader, origin: 'https://www.dropbox.com', referer: link, 'content-type': 'application/x-www-form-urlencoded' },
      body: form
    });
    if (!response.ok) throw new Error(`Dropbox listing failed (${response.status}) for ${subPath || '/'}`);
    return response.json();
  }

  async function listFolder(secureHash, subPath) {
    let page = await listPage({ secureHash, subPath });
    const entries = [...page.entries];
    while (page.has_more_entries) {
      page = await listPage({ secureHash, subPath, voucher: page.next_request_voucher });
      entries.push(...page.entries);
    }
    return entries;
  }

  // Walk one top-level brand folder, returning files with their path relative to that folder.
  async function listBrandFolder(folderName) {
    const root = await listFolder(info.rootHash, '');
    const top = root.find((entry) => entry.is_dir && entry.filename.toLowerCase() === String(folderName).toLowerCase());
    if (!top) throw new Error(`Folder "${folderName}" not found in the shared link`);
    const { secureHash, subPath } = hashAndPath(top.href);
    const files = [];
    async function walk(hash, path, rel) {
      for (const entry of await listFolder(hash, path)) {
        const relPath = rel ? `${rel}/${entry.filename}` : entry.filename;
        if (entry.is_dir) {
          const next = hashAndPath(entry.href);
          await walk(next.secureHash, next.subPath, relPath);
        } else {
          files.push({
            name: entry.filename, relPath, bytes: Number(entry.bytes) || 0, fileId: entry.file_id || null,
            revisionId: entry.revision_id || null, modifiedTs: entry.ts || null, href: entry.href
          });
        }
      }
    }
    await walk(secureHash, subPath, '');
    return { folder: top.filename, files };
  }

  async function download(file, { maxBytes = Infinity } = {}) {
    if (file.bytes > maxBytes) throw new Error(`File is ${file.bytes} bytes, over the ${maxBytes} byte limit`);
    const url = new URL(file.href);
    url.searchParams.set('dl', '1');
    const response = await fetchImpl(url, { headers: { 'user-agent': UA, cookie: cookieHeader }, redirect: 'follow' });
    if (!response.ok) throw new Error(`Dropbox download failed (${response.status}) for ${file.relPath}`);
    return Buffer.from(await response.arrayBuffer());
  }

  return { listBrandFolder, download };
}

const VIDEO_AUDIO = /\.(mov|mp4|m4v|avi|mkv|mp3|wav|aif|aiff)$/i;
const DESIGN_SOURCE = /\.(ai|psd|psb|eps|cdr|indd|sketch|fig|xd)$/i;
const FONT_BINARY = /\.(ttf|otf|woff2?|ttc|fon)$/i;
const IMAGE = /\.(png|jpe?g|gif|svg|webp)$/i;
const SWATCH = /\.(aco|ase)$/i;
const DOCUMENT = /\.(pdf|pptx)$/i;
const TEXT = /\.txt$/i;

// Decide what to do with one file. Returns { action: 'ingest'|'inventory'|'skip', kind, reason }.
//  ingest    -> parsed and stored as knowledge (documents, swatches)
//  inventory -> only its name/path is recorded in the brand's asset inventory
//  skip      -> ignored, with a reason kept in the manifest
export function classifyFile(file) {
  const { name, relPath } = file;
  const lowerPath = relPath.toLowerCase();
  if (name.startsWith('._') || name === '.DS_Store') return { action: 'skip', kind: 'junk', reason: 'macos_junk' };
  if (VIDEO_AUDIO.test(name)) return { action: 'skip', kind: 'video', reason: 'video_or_audio' };
  if (DESIGN_SOURCE.test(name)) return { action: 'skip', kind: 'design', reason: 'design_source_file' };
  if (/\.cube$/i.test(name)) return { action: 'skip', kind: 'lut', reason: 'lut' };
  if (/\.(zip|rar|7z)$/i.test(name)) return { action: 'skip', kind: 'archive', reason: 'archive' };
  if (/(^|[\/ _-])(ofl|license|licence|readme|copyright|credits)[^/]*$/i.test(lowerPath)) return { action: 'skip', kind: 'font_license', reason: 'font_license_text' };
  if (FONT_BINARY.test(name)) return { action: 'inventory', kind: 'font', reason: 'recorded_by_name_in_inventory' };
  if (SWATCH.test(name)) return { action: 'ingest', kind: 'swatch', reason: null };
  if (IMAGE.test(name)) {
    if (/logo/i.test(lowerPath)) return { action: 'inventory', kind: 'logo', reason: 'recorded_by_name_in_inventory' };
    if (/element|shape|doodle|icon|key.?visual/i.test(lowerPath)) return { action: 'inventory', kind: 'brand_element', reason: 'recorded_by_name_in_inventory' };
    return { action: 'skip', kind: 'image', reason: 'image_not_logo_or_element' };
  }
  if (DOCUMENT.test(name)) {
    if (/logo/i.test(name)) return { action: 'inventory', kind: 'logo', reason: 'recorded_by_name_in_inventory' };
    return { action: 'ingest', kind: 'document', reason: null };
  }
  if (TEXT.test(name)) return { action: 'ingest', kind: 'document', reason: null };
  return { action: 'skip', kind: 'other', reason: 'unsupported_type' };
}

export function documentTypeFromName(name = '') {
  const n = name.toLowerCase();
  if (/brand ?book|brandboo+k|style ?book|playbook/.test(n)) return 'brand_book';
  if (/guideline/.test(n)) return 'brand_guidelines';
  if (/menu/.test(n)) return 'product_document';
  if (/brief/.test(n)) return 'creative_brief';
  if (/deck|presentation/.test(n)) return 'presentation';
  if (/report|notes/.test(n)) return 'report';
  return 'general';
}

// Dates in file names are more trustworthy than Dropbox's copy dates: 240710, 20230210, 2024-11.
export function dateFromName(name = '') {
  const full = name.match(/(?<!\d)(20\d{2})[-_]?(0[1-9]|1[0-2])[-_]?(0[1-9]|[12]\d|3[01])(?!\d)/);
  if (full) return `${full[1]}-${full[2]}-${full[3]}`;
  const short = name.match(/(?<!\d)(\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/);
  if (short) return `20${short[1]}-${short[2]}-${short[3]}`;
  const month = name.match(/(?<!\d)(20\d{2})[-_](0[1-9]|1[0-2])(?!\d)/);
  return month ? `${month[1]}-${month[2]}-01` : null;
}

// Font family from a font file or its folder, e.g. "Fonts/Hanken Grotesk/HankenGrotesk-Bold.ttf" -> "Hanken Grotesk".
export function fontFamilyName(relPath) {
  const parts = relPath.split('/');
  const file = parts.at(-1).replace(/\.[^.]+$/, '');
  const generic = /^(fonts?|typography|static|variable|ttf|otf|web|desktop)$/i;
  const folder = [...parts.slice(0, -1)].reverse().find((p) => !generic.test(p) && !/font/i.test(p));
  const base = (folder || file).replace(/[-_]/g, ' ');
  return base.replace(/\s+(regular|bold|italic|light|medium|semibold|black|thin|extrabold)\b.*$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
}

export function buildInventoryText(brandName, entries) {
  const byKind = (kind) => entries.filter((e) => e.kind === kind);
  const list = (items) => items.map((e) => {
    const base = `- ${e.relPath}${/(^|[\/ _-])old([\/ _.-]|$)/i.test(e.relPath) ? ' (older version)' : ''}`;
    if (e.kind === 'logo' && e.href) {
      return `${base} — <${e.href}|Dropbox link>`;
    }
    return base;
  }).join('\n');
  const fonts = [...new Set(byKind('font').map((e) => fontFamilyName(e.relPath)).filter(Boolean))];
  const sections = [`ASSET INVENTORY for ${brandName}. This lists file names only; the contents of these files were not analysed, so it says nothing about colours, fonts in use or rules.`];
  if (byKind('logo').length) sections.push(`Logo files (${byKind('logo').length}):\n${list(byKind('logo'))}`);
  if (byKind('brand_element').length) sections.push(`Brand element / graphic files (${byKind('brand_element').length}):\n${list(byKind('brand_element'))}`);
  if (fonts.length) sections.push(`Font files supplied (family names inferred from file/folder names; usage rules are only in the brand guidelines): ${fonts.join(', ')}`);
  return sections.length > 1 ? sections.join('\n\n') : '';
}
