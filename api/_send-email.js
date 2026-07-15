// api/_send-email.js
//
// Small reusable helper: sends a single email via Resend's API.
// Not an endpoint by itself (starts with _) — other files (like the
// deadline-reminder job we'll build next) import and call this function.
//
// NOTE: Until you own a real domain, RESEND_FROM_ADDRESS defaults to
// Resend's shared test address, "onboarding@resend.dev". This only lets
// you send emails to YOUR OWN email address (the one on your Resend
// account) — not to real users yet. Once you buy a domain and verify it
// in Resend, we'll change RESEND_FROM_ADDRESS to something like
// "reminders@appealist.com" and it'll work for everyone. No other code
// needs to change when that day comes.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS || 'onboarding@resend.dev';

export async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.error('sendEmail: RESEND_API_KEY is not set — skipping send.');
    return { ok: false, error: 'not_configured' };
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM_ADDRESS,
        to: [to],
        subject,
        html,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('sendEmail: Resend API returned an error:', data);
      return { ok: false, error: data };
    }

    console.log('sendEmail: sent successfully to', to, '- Resend id:', data.id);
    return { ok: true, id: data.id };
  } catch (err) {
    console.error('sendEmail: request to Resend failed:', err);
    return { ok: false, error: String(err) };
  }
}
