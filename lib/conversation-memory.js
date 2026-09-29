import { supabase } from './db.js';

export async function saveThreadMessage({ workspaceId, channelId, threadTs, messageTs, userId = null, role, content }) {
  if (!workspaceId || !channelId || !threadTs || !messageTs || !content) return;

  const { error } = await supabase()
    .from('slack_thread_messages')
    .upsert({
      workspace_id: workspaceId,
      channel_id: channelId,
      thread_ts: threadTs,
      message_ts: messageTs,
      user_id: userId,
      role,
      content
    }, { onConflict: 'workspace_id,channel_id,message_ts', ignoreDuplicates: true });

  if (error) throw new Error(`Conversation memory write failed: ${error.message}`);
}

export async function getThreadMessages({ workspaceId, channelId, threadTs, limit = 16 }) {
  const { data, error } = await supabase()
    .from('slack_thread_messages')
    .select('message_ts,user_id,role,content,created_at')
    .eq('workspace_id', workspaceId)
    .eq('channel_id', channelId)
    .eq('thread_ts', threadTs)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Conversation memory read failed: ${error.message}`);

  return (data || []).reverse().map((m) => ({
    ts: m.message_ts,
    text: m.content,
    user: m.user_id,
    isBot: m.role === 'assistant'
  }));
}

export async function threadHasAssistant({ workspaceId, channelId, threadTs }) {
  const { data, error } = await supabase()
    .from('slack_thread_messages')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('channel_id', channelId)
    .eq('thread_ts', threadTs)
    .eq('role', 'assistant')
    .limit(1);

  if (error) throw new Error(`Conversation memory lookup failed: ${error.message}`);
  return Boolean(data?.length);
}
