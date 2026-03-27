import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("[Supabase] SUPABASE_URL or SUPABASE_ANON_KEY not set — Supabase features will be unavailable.");
}

export const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;

export async function sbQuery<T = any>(
  tableName: string,
  builder: (query: any) => any
): Promise<T[]> {
  if (!supabase) {
    console.error(`[Supabase] Client not initialized — cannot query table: ${tableName}`);
    return [];
  }
  const { data, error } = await builder(supabase.from(tableName));
  if (error) {
    console.error(`[Supabase] Error querying ${tableName}:`, error.message, error.details ?? "");
    return [];
  }
  return data || [];
}
