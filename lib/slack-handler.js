import { runBrandAgent } from './agent.js';
import { config } from './config.js';
import { cleanSlackText } from './text.js';
import { postThreadMessage } from './slack.js';
import { getThreadMessages, saveThreadMessage, threadHasAssistant } from './conversation-memory.js';

function isHumanMessage(event) {
  return event && event.type === 'message' && !event.bot_id && !event.subtype;
}

export async function processSlackEvent(payload) {
  const event = payload?.event;
  if (!event || event.bot_id || event.subtype) return;

  const { defaultBrandId, slackChannelBrandMap } = config();
  const workspaceId = payload.team_id || payload.team?.id || 'unknown-workspace';
  const channelId = event.channel;
  const brandId = slackChannelBrandMap[channelId] || defaultBrandId;
  if (!brandId) return;
  const rootTs = event.thread_ts || event.ts;
  const latestMessage = cleanSlackText(event.text || '');

  if (!channelId || !rootTs || !latestMessage) return;

  const isMention = event.type === 'app_mention';
  const isHuman = isHumanMessage(event);

  if (isMention || isHuman) {
    await saveThreadMessage({
      workspaceId,
      channelId,
      threadTs: rootTs,
      messageTs: event.ts,
      userId: event.user || null,
      role: 'user',
      content: latestMessage
    });
  }

  let shouldRespond = isMention;

  if (!shouldRespond && isHuman && event.thread_ts) {
    shouldRespond = await threadHasAssistant({ workspaceId, channelId, threadTs: rootTs });
  }

  if (!shouldRespond) return;

  try {
    const threadMessages = await getThreadMessages({
      workspaceId,
      channelId,
      threadTs: rootTs,
      limit: 16
    });

    const result = await runBrandAgent({ brandId, latestMessage, threadMessages });
    const sourceLines = (result.sources || []).slice(0, 6).map((source, index) => {
      const location = source.sourceLocation ? ` — ${source.sourceLocation}` : '';
      return `[${index + 1}] ${source.title || 'Untitled'}${location}`;
    });
    const sourceBlock = sourceLines.length ? `\n\nSources:\n${sourceLines.join('\n')}` : '';
    const posted = await postThreadMessage({ channel: channelId, threadTs: rootTs, text: `${result.answer}${sourceBlock}` });

    await saveThreadMessage({
      workspaceId,
      channelId,
      threadTs: rootTs,
      messageTs: posted.ts || `${Date.now()}`,
      userId: posted.message?.bot_id || null,
      role: 'assistant',
      content: result.answer
    });
  } catch (error) {
    console.error('Brand Agent failed', error);
    const fallback = 'I hit an internal error while checking the brand knowledge. Please try that once more.';
    const posted = await postThreadMessage({
      channel: channelId,
      threadTs: rootTs,
      text: fallback
    }).catch(() => null);

    if (posted?.ts) {
      await saveThreadMessage({
        workspaceId,
        channelId,
        threadTs: rootTs,
        messageTs: posted.ts,
        userId: posted.message?.bot_id || null,
        role: 'assistant',
        content: fallback
      }).catch(() => {});
    }
  }
}
