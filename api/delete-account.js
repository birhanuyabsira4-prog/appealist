// api/delete-account.js
//
// Permanently deletes the logged-in user's own account and data.
//
// SECURITY DESIGN (read this before changing anything):
// This is the most dangerous endpoint in the whole app, so it works
// differently from the others. It uses Supabase's "service_role" key,
// which has full admin power over your database — including deleting
// ANY user. Because of that:
//   1. This key lives ONLY here, in a Vercel environment variable, and is
//      never sent to the browser.
//   2. We never trust a user ID sent in the request body (someone could
//      type in anyone's ID). Instead, we take the person's own login
//      token (their "access token", the thing that proves they're really
//      logged in as themselves) and ask Supabase directly: "who does this
//      token actually belong to?" Only THAT verified account gets
//      deleted — never whatever the request claims.

import { createClient } from '@supabase/supabase-js';
import { checkRateLimit } from './_rateLimit.js';
import { applyCors } from './_cors.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (!applyCors(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  // Low limit: account deletion should basically never be called
  // repeatedly by a legitimate user in a short window.
  const allowed = await checkRateLimit(req, res, {
    name: 'delete-account',
    perIpLimit: 3,
    perIpWindowSeconds: 60 * 60,
    globalDailyLimit: 50,
  });
  if (!allowed) return;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Account deletion is not configured: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.');
    return res.status(503).json({ error: 'Account deletion is temporarily unavailable. Please try again later.' });
  }

  // Pull the user's own login token out of the request. The frontend
  // sends this as: Authorization: Bearer <their access token>
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'You must be logged in to delete your account.' });
  }

  try {
    // A lightweight client, just used to verify WHO this token belongs to.
    const supabaseAuthCheck = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: userData, error: userError } = await supabaseAuthCheck.auth.getUser(token);

    if (userError || !userData || !userData.user) {
      return res.status(401).json({ error: 'Your session has expired. Please log in again and retry.' });
    }

    const verifiedUserId = userData.user.id;

    // ---- Delete the user's stored data first, then their login account ----
    // NOTE: once a table for saved appeals/deadlines exists, delete each
    // user's rows from that table here too, e.g.:
    //   await supabaseAuthCheck.from('appeals').delete().eq('user_id', verifiedUserId);
    // This is a placeholder reminder until that table is built.

    const { error: deleteError } = await supabaseAuthCheck.auth.admin.deleteUser(verifiedUserId);
    if (deleteError) throw deleteError;

    return res.status(200).json({ success: true, message: 'Account permanently deleted.' });
  } catch (err) {
    console.error('Account deletion failed:', err);
    return res.status(500).json({ error: 'Something went wrong deleting your account. Please try again or contact support.' });
  }
}
