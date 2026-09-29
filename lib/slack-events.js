import { supabase } from './db.js';

export async function saveSlackEvent({ workspaceId, channelId, eventTs, threadTs = null, userId = null, eventType, brandId, content }) {
  if (!workspaceId || !channelId || !eventTs || !eventType || !brandId || !content) return;
  const { error } = await supabase().from('slack_events').upsert({
    workspace_id: workspaceId,
    channel_id: channelId,
    event_ts: eventTs,
    thread_ts: threadTs,
    user_id: userId,
    event_type: eventType,
    brand_id: brandId,
    content
  }, { onConflict: 'workspace_id,channel_id,event_ts', ignoreDuplicates: true });
  if (error) throw new Error(`Slack event write failed: ${error.message}`);
}

function dayRangeOffset(days) {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return { start, end };
}

export async function searchRecentBrandEvents({ brandId, sinceDays = 1, query = '', limit = 30 }) {
  if (!brandId) return [];
  const { start, end } = dayRangeOffset(sinceDays);
  const { data, error } = await supabase().rpc('search_recent_brand_events', {
    p_brand_id: brandId,
    p_since: start.toISOString(),
    p_until: end.toISOString(),
    p_query: query,
    p_limit: limit
  });
  if (error) throw new Error(`Recent event search failed: ${error.message}`);
  return data || [];
}
