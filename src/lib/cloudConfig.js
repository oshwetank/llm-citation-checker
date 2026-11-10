/*
 * cloudConfig.js — where accounts and shared campaigns live (0.82.0).
 *
 * Empty until the owner's Supabase project and Vercel deployment exist (see
 * server/README.md). While empty, the extension says "Accounts aren't
 * switched on yet", sends nothing anywhere, and campaigns are still shared
 * as files. The anon key is public by design (Supabase's own term): it only
 * reaches what the database's row-level rules allow.
 */
export const CLOUD = {
  apiBase: "", // e.g. https://citoskeleton.vercel.app
  supabaseUrl: "", // e.g. https://abcd1234.supabase.co
  supabaseAnonKey: "",
};
