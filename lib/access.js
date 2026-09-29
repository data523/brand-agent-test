import { supabase } from './db.js';

export function brandAccessEnforced() {
  return /^(1|true|yes)$/i.test(process.env.BRAND_ACCESS_ENFORCED || '');
}

export async function hasBrandAccess({ brandId, slackUserId }) {
  if (!brandAccessEnforced()) return true;
  if (!brandId || !slackUserId) return false;
  const { data, error } = await supabase().rpc('has_brand_access', {
    p_brand_id: brandId,
    p_slack_user_id: slackUserId
  });
  if (error) throw new Error(`Brand access check failed: ${error.message}`);
  return Boolean(data);
}
