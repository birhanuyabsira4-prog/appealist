// api/send-mail.js
//
// Vercel serverless function. Takes the finished appeal letter plus a
// sender and recipient address, and hands it to Lob's Print & Mail API,
// which prints it and physically mails it via USPS.
//
// The Lob API key lives only in this file's environment — never in the
// browser, for the same reason as the Anthropic key in generate-appeal.js.

import { checkRateLimit } from "./_rateLimit.js";
import { applyCors } from "./_cors.js";

const LOB_API_KEY = process.env.LOB_API_KEY;

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Wraps the plain letter text in simple, print-friendly HTML. Lob renders
// this HTML to a PDF and mails it — no separate PDF generation needed here.
function letterToHtml(letterText) {
  const body = escapeHtml(letterText).replace(/\n/g, "<br>");
  return `<html>
    <body style="font-family: Georgia, 'Times New Roman', serif; font-size: 12pt; line-height: 1.6; padding: 0.85in; color: #111;">
      ${body}
    </body>
  </html>`;
}

export default async function handler(req, res) {
  if (!applyCors(req, res)) return; // handles OPTIONS + blocks other origins

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  // Stricter limits here than generate-appeal: every successful call to
  // this endpoint costs real money via Lob (roughly $1-2/letter once you're
  // on a live key), on top of the AI cost that already happened. A tighter
  // per-IP limit and a low global daily ceiling protect against both a
  // runaway bug and a bad actor specifically targeting the expensive step.
  const allowed = await checkRateLimit(req, res, {
    name: "send-mail",
    perIpLimit: 3,
    perIpWindowSeconds: 60 * 60 * 24, // 3 per day per IP
    globalDailyLimit: 25, // hard daily ceiling across ALL users combined
  });
  if (!allowed) return; // checkRateLimit already sent the response

  try {
    const { letterText, to, from } = req.body || {};

    if (!letterText || !to || !from) {
      return res.status(400).json({ error: "Missing letter text, sender address, or recipient address." });
    }
    if (typeof letterText !== "string" || letterText.length < 20 || letterText.length > 20000) {
      return res.status(400).json({ error: "Letter text looks invalid (too short, too long, or not text)." });
    }

    const requiredFields = ["name", "address_line1", "address_city", "address_state", "address_zip"];
    for (const addr of [to, from]) {
      for (const field of requiredFields) {
        if (!addr[field]) {
          return res.status(400).json({ error: `Missing ${field} in one of the addresses.` });
        }
      }
    }

    const authHeader = "Basic " + Buffer.from(LOB_API_KEY + ":").toString("base64");

    const lobResponse = await fetch("https://api.lob.com/v1/letters", {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        description: "Appealist appeal letter",
        to: { ...to, address_country: "US" },
        from: { ...from, address_country: "US" },
        file: letterToHtml(letterText),
        color: false,
        double_sided: false,
      }),
    });

    const data = await lobResponse.json();

    if (!lobResponse.ok) {
      // Lob's error messages are usually specific enough to show directly
      // (e.g. "address_zip is not a valid zip code").
      const message = data?.error?.message || "Lob rejected this request.";
      return res.status(lobResponse.status).json({ error: message });
    }

    return res.status(200).json({
      success: true,
      id: data.id,
      expected_delivery_date: data.expected_delivery_date || null,
      trackingUrl: data.url || null,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong sending your letter. Please try again." });
  }
}
