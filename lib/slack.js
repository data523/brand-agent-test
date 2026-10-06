import { config } from './config.js';

async function slackApi(method, payload = {}) {
  const { slackBotToken } = config();
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${slackBotToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!data.ok) {
    const detail = data.response_metadata?.messages?.join('; ') || '';
    throw new Error(`Slack ${method} failed: ${data.error || 'unknown_error'}${detail ? ` (${detail})` : ''}`);
  }
  return data;
}

let cachedBotUserId = null;

export async function getBotUserId() {
  if (cachedBotUserId) return cachedBotUserId;
  const auth = await slackApi('auth.test');
  cachedBotUserId = auth.user_id;
  return cachedBotUserId;
}

export async function getThreadMessages(channel, rootTs) {
  const data = await slackApi('conversations.replies', {
    channel,
    ts: rootTs,
    limit: 15
  });
  const botUserId = await getBotUserId();
  return (data.messages || []).map((m) => ({
    ts: m.ts,
    text: m.text || '',
    user: m.user || null,
    isBot: Boolean(m.bot_id || m.user === botUserId)
  }));
}

export async function postThreadMessage({ channel, threadTs, text, blocks }) {
  return slackApi('chat.postMessage', {
    channel,
    thread_ts: threadTs, blocks,
    text,
    unfurl_links: false,
    unfurl_media: false
  });
}

export async function threadContainsBot(channel, rootTs) {
  const messages = await getThreadMessages(channel, rootTs);
  return messages.some((m) => m.isBot);
}
