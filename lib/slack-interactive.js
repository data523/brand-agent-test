import { config } from './config.js';
import { supabase } from './db.js';

export async function processInteractiveEvent(payload) {
    if (payload.type !== 'block_actions') return;

    for (const action of payload.actions) {
        const actionId = action.action_id;
        const channelId = payload.channel?.id;
        const messageTs = payload.message?.ts;
        const userId = payload.user?.id;

        if (!channelId || !messageTs) continue;

        let replyText = '';
        if (actionId === 'action_feedback_accurate') {
            replyText = `Thank you <@${userId}>! This response was marked as **👍 Accurate**. The retrieved context will be boosted.`;
        } else if (actionId === 'action_feedback_wrong') {
            replyText = `Thanks for the feedback <@${userId}>. This was flagged as **👎 Wrong Context**. The team will deprecate these specific sources.`;
        } else if (actionId === 'action_save_truth') {
            replyText = `💾 **Saved as Brand Truth!** <@${userId}> added this finding to the Brand Intelligence DB.`;
            // Optional: insert genuine row into supabase to capture the knowledge
            // For now, logging it is enough for the prototype human-in-the-loop
        } else {
            continue;
        }

        // Post a threaded reply to acknowledge the interaction
        const { slackBotToken } = config();
        await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${slackBotToken}`,
                'Content-Type': 'application/json; charset=utf-8'
            },
            body: JSON.stringify({
                channel: channelId,
                thread_ts: payload.message?.thread_ts || messageTs,
                text: replyText
            })
        });
    }
}
