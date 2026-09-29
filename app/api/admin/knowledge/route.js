import { config } from '../../../../lib/config.js';
import { supabase } from '../../../../lib/db.js';

export const runtime = 'nodejs';

export async function GET(request) {
  const auth = request.headers.get('authorization') || '';
  if (auth !== `Bearer ${config().adminSecret}`) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const brandId = url.searchParams.get('brandId');
  if (!brandId) {
    return Response.json({ ok: false, error: 'brandId is required' }, { status: 400 });
  }

  const db = supabase();
  const [current, historical, changes, conflicts] = await Promise.all([
    db.from('brand_chunks').select('*', { count: 'exact', head: true })
      .eq('brand_id', brandId).eq('is_superseded', false),
    db.from('brand_chunks').select('*', { count: 'exact', head: true })
      .eq('brand_id', brandId).eq('is_superseded', true),
    db.from('slack_events').select('id,channel_id,event_ts,event_time,user_id,event_type,content')
      .eq('brand_id', brandId).order('event_time', { ascending: false }).limit(25),
    db.rpc('find_brand_conflict_candidates', { p_brand_id: brandId, p_limit: 50 })
  ]);

  const errors = [current, historical, changes, conflicts]
    .filter(result => result.error)
    .map(result => result.error.message);

  return Response.json({
    ok: errors.length === 0,
    brandId,
    health: {
      currentChunks: current.count || 0,
      supersededChunks: historical.count || 0,
      recentChangeEvents: changes.data?.length || 0,
      conflictCandidates: conflicts.data?.length || 0
    },
    recentChanges: changes.data || [],
    conflictCandidates: conflicts.data || [],
    errors
  });
}
