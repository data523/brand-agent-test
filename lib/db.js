import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

let db;
export function supabase() {
  if (!db) {
    const { supabaseUrl, supabaseSecretKey } = config();
    db = createClient(supabaseUrl, supabaseSecretKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return db;
}
