import { supabase } from './db.js';

function slackTimestampToDate(eventTs) {
  const value = Number(eventTs);
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function saveSlackEvent({ workspaceId, channelId, eventTs, threadTs = null, userId = null, eventType, brandId, content }) {
  if (!workspaceId || !channelId || !eventTs || !eventType || !brandId || !content) return;
  const eventTime = slackTimestampToDate(eventTs);
  const { error } = await supabase().from('slack_events').upsert({
    workspace_id: workspaceId,
    channel_id: channelId,
    event_ts: eventTs,
    event_time: eventTime,
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

function normalizeChangeQuery(query = '') {
  return String(query)
    .replace(/\b(what|changed|change|update|updated|yesterday|today|recent|latest|new|approved|approval|happened|for|the|client|brand)\b/gi, ' ')
    .replace(/[^a-zA-Z0-9_@#&.'-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function searchRecentBrandEvents({ brandId, sinceDays = 1, query = '', limit = 30, excludeContent = '' }) {
  if (!brandId) return [];
  const { start, end } = dayRangeOffset(sinceDays);
  const normalizedQuery = normalizeChangeQuery(query);

  const { data, error } = await supabase().rpc('search_recent_brand_events', {
    p_brand_id: brandId,
    p_since: start.toISOString(),
    p_until: end.toISOString(),
    p_query: normalizedQuery,
    p_limit: limit
  });
  if (error) throw new Error(`Recent event search failed: ${error.message}`);

  // If lexical matching is too restrictive for a natural-language change question,
  // fall back to the brand/time window rather than returning false "no change" evidence.
  let rows = data || [];
  if (normalizedQuery && !rows.length) {
    const fallback = await supabase().rpc('search_recent_brand_events', {
      p_brand_id: brandId,
      p_since: start.toISOString(),
      p_until: end.toISOString(),
      p_query: '',
      p_limit: Math.min(limit, 30)
    });
    if (fallback.error) throw new Error(`Recent event fallback failed: ${fallback.error.message}`);
    rows = fallback.data || [];
  }

  const excluded = String(excludeContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!excluded) return rows;
  // The Slack handler stores the user's current message before running the agent.
  // Exclude that exact message so a change query cannot cite itself as evidence.
  return rows.filter((row) => String(row.content || '').replace(/\s+/g, ' ').trim().toLowerCase() !== excluded);
}

export { normalizeChangeQuery, slackTimestampToDate };
