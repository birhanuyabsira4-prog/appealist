// api/freemius-webhook.js
//
// Receives real-time notifications from Freemius the moment someone
// subscribes, cancels, or has a payment fail — and updates our own
// database so the rest of the app knows who's actually paying.
//
// SECURITY: Freemius signs every webhook request with a secret key only
// you and Freemius know (HMAC-SHA256 of the raw request body). We MUST
// verify this signature before trusting anything in the request —
// otherwise anyone who finds this URL could fake a "payment succeeded"
// event for free. This is why we disable Vercel's automatic JSON parsing
// below: signature verification requires the exact raw bytes of the
// request, not a re-encoded copy of the parsed JSON (even a reordered
// object key would produce a different, non-matching signature).

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

export const config = {
  api: {
    bodyParser: false,
  },
};

const FREEMIUS_SECRET_KEY = process.env.FREEMIUS_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Freemius event names vary by exact event type. We map anything that
// clearly means "this person is now paying" to 'active', and anything
// that clearly means "this person stopped paying" to 'cancelled'.
// Unrecognized events are logged but don't change subscription status,
// so we never accidentally lock someone out or unlock someone by mistake
// on an event we don't yet understand.
function statusFromEventType(eventType) {
  if (!eventType) return null;
  const t = eventType.toLowerCase();
  if (t.includes('payment.completed') || t.includes('subscription.created') || t.includes('subscription.renewed') || t.includes('license.created') || t.includes('license.activated')) {
    return 'active';
  }
  if (t.includes('subscription.cancelled') || t.includes('subscription.canceled') || t.includes('subscription.expired') || t.includes('license.deactivated') || t.includes('payment.failed') || t.includes('refund')) {
    return 'cancelled';
  }
  return null;
}

// Freemius payloads nest the relevant email in different places depending
// on event type. This checks the common spots rather than assuming one
// fixed shape.
function extractEmail(event) {
  const obj = event && (event.data || event.object || event);
  if (!obj) return null;
  return (
    obj.email ||
    (obj.user && obj.user.email) ||
    (obj.buyer && obj.buyer.email) ||
    null
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  if (!FREEMIUS_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Freemius webhook not fully configured: missing required env vars.');
    // Still return 200 so Freemius doesn't endlessly retry a
    // misconfiguration that a person needs to fix, not a bot to hammer.
    return res.status(200).json({ received: true, warning: 'not configured' });
  }

  const rawBody = await getRawBody(req);
  const signature = req.headers['x-signature'] || '';

  const expectedHash = crypto.createHmac('sha256', FREEMIUS_SECRET_KEY).update(rawBody).digest('hex');

  let isValid = false;
  try {
    isValid = crypto.timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    isValid = false; // malformed/missing signature header, not a real match
  }

  if (!isValid) {
    console.error('Freemius webhook: invalid signature, ignoring request.');
    // Return 200, not 401 — this avoids revealing to a potential attacker
    // whether they're close to guessing anything; legitimate Freemius
    // requests will always sign correctly, so this only ever silently
    // drops forged requests.
    return res.status(200).json({ received: true });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    console.error('Freemius webhook: could not parse payload as JSON.', err);
    return res.status(200).json({ received: true });
  }

  // Log the full event once — genuinely useful the first few times real
  // webhooks arrive, so we can confirm field names match reality and
  // adjust extractEmail/statusFromEventType if Freemius's real payload
  // shape differs from what's assumed above.
  console.log('Freemius webhook received:', JSON.stringify(event));

  const eventType = event.type || event.event || null;
  const email = extractEmail(event);
  const newStatus = statusFromEventType(eventType);

  if (!email || !newStatus) {
    // Not an event we act on (or we couldn't find an email) — acknowledge
    // receipt so Freemius doesn't retry, but don't change anything.
    return res.status(200).json({ received: true, acted: false });
  }

  try {
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await supabaseAdmin.from('subscriptions').upsert({
      email: email.toLowerCase(),
      status: newStatus,
      plan: (event.data && event.data.plan && event.data.plan.name) || null,
      freemius_subscription_id: (event.data && event.data.id) ? String(event.data.id) : null,
      last_event: eventType,
      updated_at: new Date().toISOString()
    }, { onConflict: 'email' });

    return res.status(200).json({ received: true, acted: true });
  } catch (err) {
    console.error('Freemius webhook: failed to update subscription in database.', err);
    // Still return 200 — Freemius's retry behavior is coarse, and we've
    // already logged the raw event above for manual recovery if needed.
    return res.status(200).json({ received: true, acted: false });
  }
}
