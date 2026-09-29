export function cleanSlackText(text = '') {
  return text
    .replace(/<@[A-Z0-9]+>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function chunkText(text, { maxChars = 2800, overlap = 300 } = {}) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';

  const flush = () => {
    if (!current.trim()) return;
    chunks.push(current.trim());
    const tail = current.slice(Math.max(0, current.length - overlap));
    current = tail;
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (current.trim()) flush();
      let start = 0;
      while (start < paragraph.length) {
        const end = Math.min(paragraph.length, start + maxChars);
        chunks.push(paragraph.slice(start, end).trim());
        if (end === paragraph.length) break;
        start = Math.max(start + 1, end - overlap);
      }
      current = '';
      continue;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxChars) flush();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }

  if (current.trim()) chunks.push(current.trim());
  return [...new Set(chunks.filter(Boolean))];
}

export function formatThreadForModel(messages = [], maxMessages = 16) {
  return messages
    .slice(-maxMessages)
    .map((m) => `${m.isBot ? 'ASSISTANT' : 'USER'}: ${cleanSlackText(m.text)}`)
    .join('\n');
}
