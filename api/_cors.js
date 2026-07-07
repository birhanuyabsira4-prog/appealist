// api/_cors.js
//
// Restricts who is allowed to call your API endpoints from a browser.
// Without this, anyone could build their own page that calls your
// /api/generate-appeal or /api/send-mail directly and burn your API budget,
// even if they never visit appealist itself.
//
// Set ALLOWED_ORIGIN in your Vercel environment variables to your real
// site's URL, e.g. https://appealist.com or https://appealist.vercel.app
// (no trailing slash). While testing locally you can leave it unset and
// it will fall back to allowing localhost only.

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:3000";

/**
 * Call this at the very top of every API handler.
 * Returns true if the request should continue, false if it was rejected
 * (a response has already been sent in that case).
 */
export function applyCors(req, res) {
  const origin = req.headers.origin;

  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Browsers send a preflight OPTIONS request before the real POST for
  // requests like this. Answer it and stop — no further work needed.
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return false;
  }

  // Note: this check is a courtesy for real browsers, not a hard security
  // wall — a request made with curl/Postman doesn't send an Origin header
  // and won't be blocked by CORS at all. That's expected and fine: CORS
  // stops a random OTHER WEBSITE from using a visitor's browser to call
  // your API on their behalf. The rate limiter is what protects you from
  // direct/scripted abuse, which is why both layers matter together.
  if (origin && origin !== ALLOWED_ORIGIN) {
    res.status(403).json({ error: "Requests from this origin are not allowed." });
    return false;
  }

  return true;
}
