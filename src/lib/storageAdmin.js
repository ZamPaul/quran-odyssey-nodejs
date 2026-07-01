import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const DEFAULT_BUCKET  = 'assignments';
 
// Service-role client — SERVER ONLY. Never import this in frontend code.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
 
// Derive a storage path from a Supabase public URL (fallback for old rows).
export function pathFromPublicUrl(url, bucket = DEFAULT_BUCKET) {
  if (!url) return null;
  const marker = `/object/public/${bucket}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return decodeURIComponent(url.slice(idx + marker.length));
}
 
// Delete a single stored file. Prefers an explicit path; falls back to URL.
// Never throws — returns a result object so callers can proceed even if the
// storage delete fails (we don't want a stuck file to block a DB operation).
export async function deleteStoredFile({ path, url, bucket = DEFAULT_BUCKET } = {}) {
  const target = path || pathFromPublicUrl(url, bucket);
  if (!target) return { success: false, error: 'No path or resolvable URL' };
 
  try {
    const { error } = await supabaseAdmin.storage.from(bucket).remove([target]);
    if (error) {
      console.error('⚠️  Storage delete failed:', error.message);
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err) {
    console.error('⚠️  Storage delete threw:', err.message);
    return { success: false, error: err.message };
  }
}