import { config } from './config.js';

// Do not throw during module evaluation: a failed CDN load or temporary network
// problem must still leave the sign-in screen visible instead of a blank page.
export const initError = window.supabase ? null : 'Supabase failed to load. Check your connection and refresh.';
export const db = window.supabase?.createClient(config.supabaseUrl, config.supabasePublishableKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
}) || null;

export async function requireUser() {
  if (!db) return null;
  try {
    const { data: { user } } = await db.auth.getUser();
    return user;
  } catch {
    return null;
  }
}

export function isMissingTable(error) {
  return Boolean(error && (/relation .* does not exist|schema cache|Could not find the table/i.test(error.message)));
}
