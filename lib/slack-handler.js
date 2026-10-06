import { runBrandAgent } from './agent.js';
import { config } from './config.js';
import { supabase } from './db.js';
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

const UNMAPPED_CHANNEL_REPLY = 'This channel isn’t linked to a client brand yet. Name the brand in your question (for example “BierGarten: …”) or ask an admin to connect this channel to a brand.';

// A channel answers for exactly one brand, taken from channel_brands. The env
// map is a temporary fallback for channels not yet in the table. There is no
// default brand: an unmapped channel resolves to '' and the caller refuses.
export async function resolveBrandId({ workspaceId, channelId, db = supabase(), channelBrandMap = config().slackChannelBrandMap }) {
  const { data, error } = await db
    .from('channel_brands')
    .select('brand_id')
    .eq('workspace_id', workspaceId)
    .eq('channel_id', channelId)
    .maybeSingle();

  if (error) throw new Error(`Unable to resolve brand for channel: ${error.message}`);
  if (data?.brand_id) return data.brand_id;

  const mapped = channelBrandMap?.[channelId];
  if (mapped) {
    console.warn('[slack] brand resolved from SLACK_CHANNEL_BRAND_MAP fallback; add this channel to channel_brands', { channelId, brandId: mapped });
    return mapped;
  }
  return '';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Fallback for channels with no mapping: the message itself must name exactly
// one active brand (by id, name or alias). Zero or several matches -> no brand.
export async function matchBrandInText({ text, db = supabase() }) {
  const { data, error } = await db
    .from('brands')
    .select('id,name,aliases')
    .eq('status', 'active');
  if (error) throw new Error(`Unable to load brands: ${error.message}`);

  const matched = (data || []).filter((brand) => {
    const names = [brand.id, brand.name, ...(brand.aliases || [])].filter(Boolean);
    return names.some((name) => new RegExp(`(?<![\\w])${escapeRegExp(name)}(?![\\w])`, 'i').test(text));
  });
  return matched.length === 1 ? matched[0].id : '';
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

  let brandId = '';
  let brandFromMessage = false;
  try {
    brandId = await resolveBrandId({ workspaceId, channelId });
    if (!brandId && isMention) {
      brandId = await matchBrandInText({ text: latestMessage });
      brandFromMessage = Boolean(brandId);
    }
  } catch (error) {
    console.error('[slack] brand resolution failed', error);
    if (isMention) {
      await postThreadMessage({
        channel: channelId,
        threadTs: rootTs,
        text: 'I received your message, but the brand knowledge base is not configured correctly yet.'
      }).catch((postError) => console.error('[slack] configuration reply failed', postError));
    }
    return;
  }

  if (!brandId) {
    // Only reply when the bot is mentioned, so ordinary chatter in an unmapped
    // channel doesn't get a refusal on every message.
    console.warn('[slack] no brand mapped for channel', { workspaceId, channelId });
    if (isMention) {
      await postThreadMessage({
        channel: channelId,
        threadTs: rootTs,
        text: UNMAPPED_CHANNEL_REPLY
      }).catch((postError) => console.error('[slack] no-brand reply failed', postError));
    }
    return;
  }

  console.log('[slack] resolved brand', { channelId, brandId, via: brandFromMessage ? 'message' : 'channel' });

  try {
    if (!(await hasBrandAccess({ brandId, slackUserId: event.user || null }))) {
      if (isMention) {
        await postThreadMessage({
          channel: channelId,
          threadTs: rootTs,
          text: 'I can’t access this client workspace for your account.'
        });
      }
      console.log('[slack] access denied', { channelId, brandId, userId: event.user || null });
      return;
    }
  } catch (error) {
    console.error('[slack] access check failed', error);
    await postThreadMessage({
      channel: channelId,
      threadTs: rootTs,
      text: 'I received your message, but I could not verify access to the brand knowledge.'
    }).catch((postError) => console.error('[slack] access-error reply failed', postError));
    return;
  }

  if (isMention || isHuman) {
    try {
      await saveThreadMessage({
        workspaceId, channelId, threadTs: rootTs, messageTs: event.ts,
        userId: event.user || null, role: 'user', content: latestMessage
      });
    } catch (error) {
      console.error('[slack] conversation memory write failed; continuing', error);
    }
  }

  // Chatter in a channel that isn't mapped to this brand must not become brand evidence.
  if (!brandFromMessage) {
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
  }

  let shouldRespond = isMention;
  if (!shouldRespond && isHuman && event.thread_ts) {
    try {
      shouldRespond = await threadHasAssistant({ workspaceId, channelId, threadTs: rootTs });
    } catch (error) {
      console.error('[slack] thread continuation check failed', error);
    }
  }
  if (!shouldRespond) {
    console.log('[slack] event does not require a response');
    return;
  }

  console.log('[slack] starting Brand Agent', { brandId, channelId });

  try {
    let threadMessages = [];
    try {
      threadMessages = await getThreadMessages({ workspaceId, channelId, threadTs: rootTs, limit: 12 });
    } catch (error) {
      console.error('[slack] conversation memory read failed; answering without stored context', error);
    }

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
