// api/send-deadline-reminders.js
//
// Finds appeals whose deadline is coming up in ~5 days, and haven't been
// mailed yet (status = 'draft'), and emails the user a reminder. Each
// appeal is only ever reminded once, tracked via the new
// `reminder_sent_at` column on the `appeals` table (added in Supabase's
// Table Editor before this file is used).
//
// This is meant to be triggered automatically once a day by Vercel Cron
// (configured separately in vercel.json) — not called by the frontend.
// It's still protected below so a stranger can't trigger it manually and
// spam your users' inboxes.

import { createClient } from '@supabase/supabase-js';
import { sendEmail } from './_send-email.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

function reminderEmailHtml({ insurer, deadline }) {
  const formattedDeadline = new Date(deadline).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color: #0f766e;">Your appeal deadline is coming up</h2>
      <p>Your appeal to <strong>${insurer}</strong> has a deadline of
      <strong>${formattedDeadline}</strong> — that's about 5 days from now.</p>
      <p>If you haven't sent your appeal letter yet, now's a good time to
      finish and mail it.</p>
      <p><a href="https://appealist.vercel.app/#my-appeals"
            style="color: #0f766e;">View your appeal in Appealist &rarr;</a></p>
    </div>
  `;
}

export default async function handler(req, res) {
  // Only Vercel's own cron (or someone who knows CRON_SECRET) can trigger this.
  const authHeader = req.headers['authorization'] || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('send-deadline-reminders: missing Supabase env vars.');
    return res.status(200).json({ ran: false, reason: 'not_configured' });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // "5 days from now", as a plain date (no time component) so it matches
  // the `deadline` column, which is a date, not a timestamp.
  const target = new Date();
  target.setDate(target.getDate() + 5);
  const targetDateStr = target.toISOString().split('T')[0];

  const { data: appeals, error: fetchError } = await supabaseAdmin
    .from('appeals')
    .select('id, user_id, insurer, deadline')
    .eq('status', 'draft')
    .eq('deadline', targetDateStr)
    .is('reminder_sent_at', null);

  if (fetchError) {
    console.error('send-deadline-reminders: failed to fetch appeals.', fetchError);
    return res.status(500).json({ error: 'fetch_failed' });
  }

  if (!appeals || appeals.length === 0) {
    return res.status(200).json({ ran: true, sent: 0 });
  }

  let sentCount = 0;

  for (const appeal of appeals) {
    const { data: userData, error: userError } =
      await supabaseAdmin.auth.admin.getUserById(appeal.user_id);

    if (userError || !userData || !userData.user || !userData.user.email) {
      console.error('send-deadline-reminders: could not find email for user', appeal.user_id, userError);
      continue;
    }

    const email = userData.user.email;

    const result = await sendEmail({
      to: email,
      subject: `Your appeal deadline is in 5 days`,
      html: reminderEmailHtml({ insurer: appeal.insurer, deadline: appeal.deadline }),
    });

    if (result.ok) {
      sentCount += 1;
      await supabaseAdmin
        .from('appeals')
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq('id', appeal.id);
    } else {
      console.error('send-deadline-reminders: failed to send email for appeal', appeal.id, result.error);
    }
  }

  return res.status(200).json({ ran: true, sent: sentCount, checked: appeals.length });
}
