import * as officeparser from 'officeparser';
import { renderDocumentPages } from './document-renderer.js';

function flattenText(nodes = [], out = []) {
  for (const node of nodes) {
    if (typeof node?.text === 'string' && node.text.trim()) out.push(node.text.trim());
    if (Array.isArray(node?.children)) flattenText(node.children, out);
    if (Array.isArray(node?.notes)) {
      for (const note of node.notes) if (typeof note?.text === 'string' && note.text.trim()) out.push('[Speaker note] ' + note.text.trim());
    }
  }
  return out;
}

function sectionize(nodes = []) {
  const sections = [];
  let sectionNumber = 0;
  for (const node of nodes) {
    const kind = node?.type === 'slide' ? 'slide' : node?.type === 'page' ? 'page' : null;
    if (!kind) continue;
    sectionNumber += 1;
    const text = flattenText(node?.children || node?.content || [], []);
    if (Array.isArray(node?.notes)) {
      for (const note of node.notes) if (note?.text) text.push('[Speaker note] ' + note.text);
    }
    sections.push({ kind, number: sectionNumber, text: text.join('\n').trim() });
  }
  return sections;
}

function collectVisualContext(nodes = [], currentLocation = null, assets = [], colors = []) {
  for (const node of nodes) {
    const kind = node?.type === 'slide' ? 'slide' : node?.type === 'page' ? 'page' : null;
    const location = kind ? kind + ' ' + ((currentLocation ? Number(currentLocation.split(' ')[1]) : 0) + 1) : currentLocation;
    if (node?.metadata?.attachmentName) {
      assets.push({
        name: node.metadata.attachmentName,
        location,
        ocrText: node?.ocrText || ''
      });
    }
    const color = node?.formatting?.color;
    if (typeof color === 'string' && color.startsWith('#')) colors.push(color.toUpperCase());
    const background = node?.formatting?.backgroundColor;
    if (typeof background === 'string' && background.startsWith('#')) colors.push(background.toUpperCase());
    if (Array.isArray(node?.children)) collectVisualContext(node.children, location, assets, colors);
    if (Array.isArray(node?.content)) collectVisualContext(node.content, location, assets, colors);
  }
}

// Under Next's server bundle the named `OfficeParser` export can come through as undefined,
// so resolve parseOffice from whichever shape the module arrives in.
function resolveParseOffice() {
  const fn = officeparser.parseOffice
    ?? officeparser.OfficeParser?.parseOffice
    ?? officeparser.default?.parseOffice
    ?? officeparser.default?.OfficeParser?.parseOffice;
  if (typeof fn !== 'function') throw new Error('officeparser: parseOffice is not available');
  return fn;
}

export async function parseOfficeBuffer(buffer, { fileType, enableOcr = false, extractAttachments = true } = {}) {
  if (!buffer?.length) throw new Error('Document buffer is empty');
  const ast = await resolveParseOffice()(buffer, {
    fileType,
    extractAttachments,
    ocr: enableOcr,
    extractTextColor: true
  });
  const sections = sectionize(ast.content || []);
  const renderedPages = await renderDocumentPages(buffer, { fileType });
  const fallbackText = flattenText(ast.content || [], []).join('\n');
  const text = sections.length
    ? sections.map(section => '[' + section.kind.toUpperCase() + ' ' + section.number + ']\n' + section.text).join('\n\n')
    : fallbackText;

  const references = [];
  const colors = [];
  collectVisualContext(ast.content || [], null, references, colors);
  const attachmentMap = new Map((ast.attachments || []).map(a => [a.name, a]));
  const visualAssets = references.map(ref => {
    const attachment = attachmentMap.get(ref.name);
    return attachment ? { ...attachment, location: ref.location } : null;
  }).filter(Boolean);

  // Some PDF/image attachments may not have a corresponding content node.
  for (const attachment of ast.attachments || []) {
    if (/^image\//i.test(attachment.mimeType || '') && !visualAssets.some(a => a.name === attachment.name)) {
      visualAssets.push({ ...attachment, location: null });
    }
  }

  return {
    text: text.trim(),
    format: fileType || ast.type || 'office',
    pageCount: sections.length || null,
    visualAssets,
    renderedPages,
    visualColors: [...new Set(colors)].slice(0, 32),
    metadata: {
      officeType: ast.type || fileType || null,
      warnings: Array.isArray(ast.warnings) ? ast.warnings : [],
      sections,
      attachmentCount: visualAssets.length,
      renderedPageCount: renderedPages.length
    }
  };
}
