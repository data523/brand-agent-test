import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore','pipe','pipe'] });
    let stdout='', stderr='';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(command + ' failed (' + code + '): ' + stderr.slice(-3000))));
  });
}

async function commandExists(command) {
  try { await run(command, ['--version']); return true; } catch { return false; }
}

async function renderPdfRange(pdfPath, outputDir, maxPages) {
  const prefix = join(outputDir, 'page');
  const args = ['-jpeg', '-r', '110', '-f', '1'];
  if (maxPages > 0) args.push('-l', String(maxPages));
  args.push(pdfPath, prefix);
  await run('pdftoppm', args);
  const { readdir } = await import('node:fs/promises');
  const names = (await readdir(outputDir))
    .filter(n => /^page-\d+\.jpg$/i.test(n))
    .sort((a,b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  return Promise.all(names.map(async name => ({
    name,
    location: 'page ' + name.match(/\d+/)?.[0],
    mimeType: 'image/jpeg',
    data: (await readFile(join(outputDir,name))).toString('base64')
  })));
}

export async function renderDocumentPages(buffer, { fileType, maxPages = Number(process.env.VISION_MAX_PAGES || 0) } = {}) {
  if (!buffer?.length) return [];
  const hasPdf = await commandExists('pdftoppm');
  if (!hasPdf) return [];

  const dir = await mkdtemp(join(tmpdir(), 'brand-agent-render-'));
  const extension = fileType === 'pdf' ? '.pdf' : fileType === 'ppt' ? '.ppt' : '.pptx';
  const input = join(dir, randomUUID() + extension);
  try {
    await (await import('node:fs/promises')).writeFile(input, buffer);
    let pdfPath = input;
    if (fileType !== 'pdf') {
      const soffice = await commandExists('soffice') ? 'soffice' : (await commandExists('libreoffice') ? 'libreoffice' : null);
      if (!soffice) return [];
      await run(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', dir, input]);
      pdfPath = join(dir, input.split('/').pop().replace(/\.(pptx?|odp)$/i, '.pdf'));
    }
    return await renderPdfRange(pdfPath, dir, maxPages);
  } catch {
    return [];
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
