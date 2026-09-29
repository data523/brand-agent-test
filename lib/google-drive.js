import crypto from 'node:crypto';
import { config } from './config.js';
import { parseOfficeBuffer } from './document-parser.js';
import { renderDocumentPages } from './document-renderer.js';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export const DRIVE_MIME_TYPES = {
  googleDoc: 'application/vnd.google-apps.document',
  googleSheet: 'application/vnd.google-apps.spreadsheet',
  googleSlides: 'application/vnd.google-apps.presentation',
  pdf: 'application/pdf',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

async function accessToken() {
  const { googleServiceAccountEmail: email, googleServiceAccountPrivateKey: privateKey } = config();
  if (!email || !privateKey) throw new Error('Google Drive credentials are not configured');

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: email,
    scope: DRIVE_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`
    })
  });
  if (!response.ok) throw new Error(`Google auth failed: ${response.status} ${await response.text()}`);
  return (await response.json()).access_token;
}

async function driveFetch(path, token) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`Google Drive request failed: ${response.status} ${await response.text()}`);
  return response;
}

export async function getDriveFile(fileId) {
  const token = await accessToken();
  const params = new URLSearchParams({
    fields: 'id,name,mimeType,modifiedTime,webViewLink,description,parents'
  });
  return { token, file: await (await driveFetch(`files/${fileId}?${params}`, token)).json() };
}

export async function listFilesRecursive(rootFolderId) {
  const token = await accessToken();
  const output = [];
  const queue = [{ id: rootFolderId, path: '' }];

  while (queue.length) {
    const { id: folderId, path: parentPath } = queue.shift();
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,description,parents)',
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true'
      });
      if (pageToken) params.set('pageToken', pageToken);
      const data = await (await driveFetch(`files?${params}`, token)).json();
      for (const file of data.files || []) {
        if (file.mimeType === FOLDER_MIME) {
          queue.push({ id: file.id, path: [parentPath, file.name].filter(Boolean).join('/') });
        } else {
          output.push({ ...file, sourcePath: [parentPath, file.name].filter(Boolean).join('/') });
        }
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
  }

  return { token, files: output };
}

async function downloadBinary(file, token) {
  const response = await driveFetch(`files/${file.id}?alt=media`, token);
  return Buffer.from(await response.arrayBuffer());
}

export async function extractDriveText(file, token) {
  if (file.mimeType === DRIVE_MIME_TYPES.googleDoc) {
    const response = await driveFetch(`files/${file.id}/export?mimeType=${encodeURIComponent('text/plain')}`, token);
    return { text: (await response.text()).trim(), skipped: null, format: 'google_doc' };
  }

  if (file.mimeType === DRIVE_MIME_TYPES.googleSheet) {
    const response = await driveFetch(`files/${file.id}/export?mimeType=${encodeURIComponent('text/csv')}`, token);
    return { text: (await response.text()).trim(), skipped: null, format: 'google_sheet' };
  }

  if (file.mimeType === DRIVE_MIME_TYPES.googleSlides) {
    const response = await driveFetch(`files/${file.id}/export?mimeType=${encodeURIComponent(DRIVE_MIME_TYPES.pptx)}`, token);
    const buffer = Buffer.from(await response.arrayBuffer());
    try {
      const parsed = await parseOfficeBuffer(buffer, {
        fileType: 'pptx',
        enableOcr: process.env.DOCUMENT_PARSER_OCR === 'true',
        extractAttachments: true
      });
      return {
        text: parsed.text,
        skipped: parsed.text ? null : 'Google Slides export returned no text',
        visualAssets: parsed.visualAssets || [],
        visualColors: parsed.visualColors || [],
        format: 'google_slides_pptx',
        pageCount: parsed.pageCount,
        parserMetadata: parsed.metadata,
        renderedPages: parsed.renderedPages || []
      };
    } catch (error) {
      return { text: '', skipped: `Google Slides visual parse failed: ${error.message}`, format: 'google_slides' };
    }
  }

  if (file.mimeType.startsWith('text/') || ['application/json', 'application/xml'].includes(file.mimeType)) {
    const response = await driveFetch(`files/${file.id}?alt=media`, token);
    return { text: (await response.text()).trim(), skipped: null, format: 'text' };
  }

  if ([DRIVE_MIME_TYPES.pdf, DRIVE_MIME_TYPES.ppt, DRIVE_MIME_TYPES.pptx].includes(file.mimeType)) {
    const parserUrl = process.env.DOCUMENT_PARSER_URL || '';
    const buffer = await downloadBinary(file, token);

    if (!parserUrl) {
      if (file.mimeType === DRIVE_MIME_TYPES.ppt) {
        return { text: '', skipped: 'Legacy PPT requires DOCUMENT_PARSER_URL', format: 'ppt' };
      }
      try {
        const fileType = file.mimeType === DRIVE_MIME_TYPES.pdf ? 'pdf' : 'pptx';
        const parsed = await parseOfficeBuffer(buffer, {
          fileType,
          enableOcr: process.env.DOCUMENT_PARSER_OCR === 'true'
        });
        return {
          text: parsed.text,
          skipped: parsed.text ? null : 'Local document parser returned no text',
          visualAssets: parsed.visualAssets || [],
          renderedPages: parsed.renderedPages || [],
          visualColors: parsed.visualColors || [],
          format: parsed.format,
          pageCount: parsed.pageCount,
          parserMetadata: parsed.metadata
        };
      } catch (error) {
        return { text: '', skipped: `Local document parser failed: ${error.message}`, format: 'binary_document' };
      }
    }

    const response = await fetch(parserUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-document-mime-type': file.mimeType,
        'x-document-name': file.name
      },
      body: buffer
    });

    if (!response.ok) return { text: '', skipped: `Document parser failed: ${response.status}`, format: 'binary_document' };

    const payload = await response.json().catch(() => null);
    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
    const renderedPages = await renderDocumentPages(buffer, {
      fileType: file.mimeType === DRIVE_MIME_TYPES.pdf ? 'pdf' : file.mimeType === DRIVE_MIME_TYPES.ppt ? 'ppt' : 'pptx'
    });
    if (!text) return { text: '', skipped: 'Document parser returned no text', format: 'binary_document' };

    return {
      text,
      skipped: null,
      visualAssets: payload?.visualAssets || [],
      renderedPages: renderedPages.length ? renderedPages : (payload?.renderedPages || []),
      visualColors: payload?.visualColors || [],
      format: payload?.format || 'binary_document',
      pageCount: Number.isFinite(Number(payload?.pageCount)) ? Number(payload.pageCount) : null,
      parserMetadata: payload?.metadata || null
    };
  }

  return { text: '', skipped: `Unsupported MIME type: ${file.mimeType}`, format: 'unsupported' };
}

export function inferDocumentType(name = '') {
  const n = name.toLowerCase();
  if (n.includes('calendar')) return 'content_calendar';
  if (n.includes('shoot')) return 'shoot_document';
  if (n.includes('tov') || n.includes('tone')) return 'tone_of_voice';
  if (n.includes('meeting') || n.includes('mom')) return 'meeting_notes';
  if (n.includes('sop')) return 'internal_sop';
  if (n.includes('policy')) return 'internal_policy';
  if (n.includes('guideline') || n.includes('brandbook') || n.includes('brand book')) return 'brand_guidelines';
  if (n.includes('strategy') || n.includes('strat')) return 'brand_strategy';
  if (n.includes('brief')) return 'creative_brief';
  if (n.includes('report') || n.includes('qa')) return 'report';
  if (n.includes('deck') || n.includes('presentation')) return 'presentation';
  return 'general';
}
