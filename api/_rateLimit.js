// api/_rateLimit.js
//
// Shared rate limiting for both api/generate-appeal.js and api/send-mail.js.
//
// WHY THIS NEEDS A SEPARATE SERVICE (plain-language explanation):
// Each call to your Vercel API can run on a different physical server.
// A normal in-memory counter (a JS variable that goes up by 1 each request)
// would get reset constantly and wouldn't be shared between those servers —
// so it would not actually stop anyone. Upstash is a tiny, free, hosted
// database built exactly for this. It's the standard fix for this problem
// on Vercel, and its free tier (10,000 commands/day) is far more than
// enough for an early-stage product.
//
// WHAT THIS FILE DOES
// Two layers of protection:
//   1. PER-IP limit — stops one person/bot from hammering the endpoint.
//   2. GLOBAL DAILY BUDGET CAP — a hard ceiling on total calls per day
//      across ALL users combined. This is the one that actually protects
//      your wallet: even if 50 different people each stay under their own
//      per-IP limit, the global cap still stops the total spend from
//      running away while you have near-zero budget.
//
// Uses Upstash's REST API directly via fetch — no extra npm package
// needed, so there's nothing new to install.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Runs one Redis command via Upstash's REST API.
// Docs: https://upstash.com/docs/redis/features/restapi
async function redis(command) {
  const res = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

// Increments a counter key and sets its expiry the FIRST time it's created.
// Returns the new count after incrementing.
async function incrWithExpiry(key, windowSeconds) {
  const count = await redis(["INCR", key]);
  if (count === 1) {
    // Only set the expiry right when the key is first created, so we
    // don't keep pushing the window forward on every request.
    await redis(["EXPIRE", key, String(windowSeconds)]);
  }
  return count;
}

function getClientIp(req) {
  // Vercel sets x-forwarded-for. It can contain a list ("client, proxy1,
  // proxy2") — the first entry is the real client.
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

/**
 * Checks both the per-IP and global limits for a given endpoint.
 * If a limit is exceeded, sends a 429 response itself and returns false.
 * If everything is fine, returns true and the caller should proceed.
 *
 * @param {object} req
 * @param {object} res
 * @param {object} opts
 * @param {string} opts.name          Short name for this endpoint, e.g. "generate-appeal"
 * @param {number} opts.perIpLimit    Max requests per IP within the window
 * @param {number} opts.perIpWindowSeconds
 * @param {number} opts.globalDailyLimit  Max requests total, per calendar day (UTC)
 */
export async function checkRateLimit(req, res, opts) {
  const { name, perIpLimit, perIpWindowSeconds, globalDailyLimit } = opts;

  // If Upstash isn't configured yet, FAIL CLOSED with a clear error rather
  // than silently allowing unlimited requests. This makes it obvious during
  // setup if the env vars are missing, instead of quietly having no
  // protection at all.
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.error(
      "Rate limiting is not configured: missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN env vars."
    );
    res.status(503).json({
      error:
        "This service is temporarily unavailable (rate limiting not configured). Please try again later.",
    });
    return false;
  }

  try {
    const ip = getClientIp(req);
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC

    const ipKey = `rl:${name}:ip:${ip}`;
    const globalKey = `rl:${name}:global:${today}`;

    const [ipCount, globalCount] = await Promise.all([
      incrWithExpiry(ipKey, perIpWindowSeconds),
      incrWithExpiry(globalKey, 60 * 60 * 24), // resets ~daily
    ]);

    if (globalCount > globalDailyLimit) {
      res.status(429).json({
        error:
          "Appealist has hit its daily usage limit while we're still in early testing. Please try again tomorrow, or contact us if this is urgent.",
      });
      return false;
    }

    if (ipCount > perIpLimit) {
      res.status(429).json({
        error: `You've reached the limit of ${perIpLimit} requests per ${Math.round(
          perIpWindowSeconds / 60
        )} minutes. Please wait and try again.`,
      });
      return false;
    }

    return true;
  } catch (err) {
    // If Upstash itself errors (network blip, etc.), fail closed too —
    // better to briefly refuse real users than to open the door wide open
    // on a service outage.
    console.error("Rate limit check failed:", err);
    res.status(503).json({
      error: "Something went wrong checking request limits. Please try again in a moment.",
    });
    return false;
  }
}
