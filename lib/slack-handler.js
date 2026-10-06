import { runBrandAgent } from './agent.js';
import { loadBrands, resolveBrand } from './brand-resolver.js';
import { cleanSlackText } from './text.js';
import { postThreadMessage } from './slack.js';
import { getThreadMessages, saveThreadMessage, threadHasAssistant } from './conversation-memory.js';
import { saveSlackEvent } from './slack-events.js';
import { hasBrandAccess } from './access.js';

function cleanAgentReply(text = '') {
  return String(text)
    .replace(/\\#/g, '#')
    .replace(/\\\*/g, '*')
    .replace(/\\_/g, '_')
    .replace(/\\\[/g, '[')
    .replace(/\\\]/g, ']')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\*\*(.*?)\*\*/g, '*$1*')
    .replace(/\*([^*\n]+)\*/g, '*$1*')
    .replace(/\[SOURCE\s+\d+\]/gi, '')
    .replace(/\[CHANGE\s+\d+\]/gi, '')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isHumanMessage(event) {
  return event && event.type === 'message' && !event.bot_id && !event.subtype;
}

const ASK_BRAND_REPLY = 'Which brand? Name it in your message (for example “BierGarten”) and I’ll answer from that brand’s material only.';

function askWhichOfReply(names) {
  return `You named more than one brand (${names.join(', ')}). Which one should I answer for? I keep each brand’s material separate.`;
}

function threadUserTexts(threadMessages, currentTs) {
  return [...threadMessages].reverse().filter((m) => !m.isBot && m.ts !== currentTs).map((m) => m.text);
}

export async function processSlackEvent(payload) {
  const event = payload?.event;
  if (!event || event.bot_id || event.subtype) return;

  const workspaceId = payload.team_id || payload.team?.id || 'unknown-workspace';
  const channelId = event.channel;
  const isMention = event.type === 'app_mention';
  const isHuman = isHumanMessage(event);
  const latestMessage = cleanSlackText(event.text || '');
  const rootTs = event.thread_ts || event.ts;

  console.log('[slack] event received', {
    type: event.type,
    channelId,
    userId: event.user || null,
    isMention,
    hasText: Boolean(latestMessage)
  });

  if (!channelId || !rootTs || !latestMessage) {
    console.log('[slack] ignoring event: missing channel/thread/text');
    return;
  }

  let shouldRespond = isMention;
  if (!shouldRespond && isHuman && event.thread_ts) {
    try {
      shouldRespond = await threadHasAssistant({ workspaceId, channelId, threadTs: rootTs });
    } catch (error) {
      console.error('[slack] thread continuation check failed', error);
    }
  }

  const reply = (text) => postThreadMessage({ channel: channelId, threadTs: rootTs, text })
    .catch((postError) => console.error('[slack] reply failed', postError));
  const remember = () => saveThreadMessage({
    workspaceId, channelId, threadTs: rootTs, messageTs: event.ts,
    userId: event.user || null, role: 'user', content: latestMessage
  }).catch((error) => console.error('[slack] conversation memory write failed; continuing', error));

  // The brand comes from the message (or its thread), never from the channel or a default.
  let brands = [];
  try {
    brands = await loadBrands();
  } catch (error) {
    console.error('[slack] brand list failed', error);
    if (shouldRespond) await reply('I received your message, but the brand knowledge base is not configured correctly yet.');
    return;
  }

  let threadMessages = [];
  let resolution = resolveBrand({ text: latestMessage, brands });

  if (shouldRespond) {
    await remember();
    try {
      threadMessages = await getThreadMessages({ workspaceId, channelId, threadTs: rootTs, limit: 12 });
    } catch (error) {
      console.error('[slack] conversation memory read failed; answering without stored context', error);
    }
    resolution = resolveBrand({ text: latestMessage, threadTexts: threadUserTexts(threadMessages, event.ts), brands });
  }

  const nameOf = (id) => brands.find((b) => b.id === id)?.name || id;

  if (resolution.status !== 'resolved') {
    // Nothing is saved for an unresolved message: no event, and no guessed brand.
    console.log('[slack] brand not resolved', { channelId, status: resolution.status, respond: shouldRespond });
    if (shouldRespond) {
      await reply(resolution.status === 'multiple' ? askWhichOfReply(resolution.brandIds.map(nameOf)) : ASK_BRAND_REPLY);
    }
    return;
  }

  const brandId = resolution.brandId;
  console.log('[slack] resolved brand', { channelId, brandId, via: resolution.via });

  try {
    if (!(await hasBrandAccess({ brandId, slackUserId: event.user || null }))) {
      if (isMention) await reply('I can’t access this client workspace for your account.');
      console.log('[slack] access denied', { channelId, brandId, userId: event.user || null });
      return;
    }
  } catch (error) {
    console.error('[slack] access check failed', error);
    if (shouldRespond) await reply('I received your message, but I could not verify access to the brand knowledge.');
    return;
  }

  if (brands.find((b) => b.id === brandId)?.status === 'onboarding') {
    if (shouldRespond) await reply(`I don’t have ${nameOf(brandId)}’s material loaded yet, so I can’t answer about it.`);
    return;
  }

  if (!shouldRespond) await remember();

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
    console.error('[slack] event evidence write failed; continuing', error);
  }

  if (!shouldRespond) {
    console.log('[slack] event does not require a response');
    return;
  }

  console.log('[slack] starting Brand Agent', { brandId, channelId });

  try {
    const result = await runBrandAgent({ brandId, latestMessage, threadMessages });
    console.log('[slack] Brand Agent completed', {
      brandId,
      sources: result.sources?.length || 0,
      answerLength: result.answer?.length || 0
    });

    const uniqueSources = [];
    const seenSources = new Set();
    for (const source of result.sources || []) {
      const key = source.documentKey || `${source.title || 'Untitled'}|${source.sourcePath || ''}`;
      if (seenSources.has(key)) continue;
      seenSources.add(key);
      uniqueSources.push(source);
    }
    // Source metadata stays in the agent result/logs; don't expose retrieval
    // plumbing in the conversational Slack response.
    const sourceBlock = '';
    const changeLines = (result.changeEvidence || []).slice(0, 8).map((change, index) => {
      const when = change.eventTime || 'unknown time';
      const who = change.userId || 'unknown user';
      const channel = change.channelId || 'unknown channel';
      const content = String(change.content || '').replace(/\s+/g, ' ').trim();
      return `[${index + 1}] ${when} — ${who} — ${channel}\n${content}`;
    });
    // Change evidence is internal support for change/update questions.
    // Do not dump raw Slack records into ordinary conversational replies.
    const changeBlock = '';

    const finalAnswer = cleanAgentReply(result.answer) + changeBlock + sourceBlock;
    
    // Slack Block Kit interactive buttons
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: finalAnswer || " "
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '👍 Accurate',
              emoji: true
            },
            value: 'feedback_accurate',
            action_id: 'action_feedback_accurate'
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '👎 Wrong Context',
              emoji: true
            },
            value: 'feedback_wrong',
            action_id: 'action_feedback_wrong'
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '💾 Save as Brand Truth',
              emoji: true
            },
            value: 'action_save_truth',
            action_id: 'action_save_truth',
            style: 'primary'
          }
        ]
      }
    ];

    const posted = await postThreadMessage({
      channel: channelId,
      threadTs: rootTs,
      text: finalAnswer,
      blocks
    });

    console.log('[slack] reply posted', {
      channelId,
      threadTs: rootTs,
      messageTs: posted.ts || null
    });

    await saveThreadMessage({
      workspaceId, channelId, threadTs: rootTs,
      messageTs: posted.ts || `${Date.now()}`,
      userId: posted.message?.bot_id || null, role: 'assistant', content: cleanAgentReply(result.answer)
    }).catch(error => console.error('[slack] assistant memory write failed', error));
  } catch (error) {
    console.error('[slack] Brand Agent failed', error);
    const fallback = 'I hit an internal error while checking the brand knowledge. Please try that once more.';
    await postThreadMessage({ channel: channelId, threadTs: rootTs, text: fallback })
      .then((posted) => console.log('[slack] fallback reply posted', { messageTs: posted.ts || null }))
      .catch((postError) => console.error('[slack] fallback reply failed', postError));
  }
}
