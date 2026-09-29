import { runBrandAgent } from './agent.js';
import { config } from './config.js';
import { cleanSlackText } from './text.js';
import { postThreadMessage } from './slack.js';
import { getThreadMessages, saveThreadMessage, threadHasAssistant } from './conversation-memory.js';
import { saveSlackEvent } from './slack-events.js';

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
    try {
      await saveThreadMessage({
        workspaceId, channelId, threadTs: rootTs, messageTs: event.ts,
        userId: event.user || null, role: 'user', content: latestMessage
      });
    } catch (error) {
      console.error('Conversation memory write failed; continuing with live Slack context', error);
    }
  }

  try {
    await saveSlackEvent({
      workspaceId,
      channelId,
      eventTs: event.ts,
      threadTs: event.thread_ts || null,
      userId: event.user || null,
      eventType: event.type || 'message',
      brandId,
      content: latestMessage
    });
  } catch (error) {
    console.error('Slack event evidence write failed; continuing', error);
  }

  let shouldRespond = isMention;
  if (!shouldRespond && isHuman && event.thread_ts) {
    try {
      shouldRespond = await threadHasAssistant({ workspaceId, channelId, threadTs: rootTs });
    } catch (error) {
      console.error('Conversation memory lookup failed; ignoring thread-continuation check', error);
    }
  }
  if (!shouldRespond) return;

  try {
    let threadMessages = [];
    try {
      threadMessages = await getThreadMessages({ workspaceId, channelId, threadTs: rootTs, limit: 12 });
    } catch (error) {
      console.error('Conversation memory read failed; answering without stored thread context', error);
    }

    const result = await runBrandAgent({ brandId, latestMessage, threadMessages });
    const sourceLines = (result.sources || []).map((source, index) => {
      const location = source.sourceLocation ? ` — ${source.sourceLocation}` : '';
      return `[${index + 1}] ${source.title || 'Untitled'}${location}`;
    });
    const sourceBlock = sourceLines.length ? `\n\nSources:\n${sourceLines.join('\n')}` : '';
    const changeLines = (result.changeEvidence || []).slice(0, 8).map((change, index) => {
      const when = change.eventTime || 'unknown time';
      const who = change.userId || 'unknown user';
      const channel = change.channelId || 'unknown channel';
      const content = String(change.content || '').replace(/\s+/g, ' ').trim();
      return `[${index + 1}] ${when} — ${who} — ${channel}\n${content}`;
    });
    const changeBlock = changeLines.length
      ? `\n\nChange evidence (dated Slack records):\n${changeLines.join('\n\n')}`
      : '';
    const posted = await postThreadMessage({ channel: channelId, threadTs: rootTs, text: `${result.answer}${changeBlock}${sourceBlock}` });

    await saveThreadMessage({
      workspaceId, channelId, threadTs: rootTs,
      messageTs: posted.ts || `${Date.now()}`,
      userId: posted.message?.bot_id || null, role: 'assistant', content: result.answer
    }).catch(error => console.error('Assistant memory write failed', error));
  } catch (error) {
    console.error('Brand Agent failed', error);
    const fallback = 'I hit an internal error while checking the brand knowledge. Please try that once more.';
    const posted = await postThreadMessage({ channel: channelId, threadTs: rootTs, text: fallback }).catch(() => null);
    if (posted?.ts) {
      await saveThreadMessage({
        workspaceId, channelId, threadTs: rootTs, messageTs: posted.ts,
        userId: posted.message?.bot_id || null, role: 'assistant', content: fallback
      }).catch(() => {});
    }
  }
}
