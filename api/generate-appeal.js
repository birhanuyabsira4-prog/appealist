// api/generate-appeal.js
//
// Vercel serverless function. Deploy this file inside an /api folder in a
// Vercel project and it becomes a live endpoint at /api/generate-appeal.
//
// What it does, in order:
//   1. Takes the uploaded denial letter (and optional EOB / plan policy)
//      as base64, sent directly from the browser.
//   2. EXTRACT step: asks Claude to read the document(s) and return only
//      structured facts as JSON — no letter yet, no persuasion, just facts.
//   3. DRAFT step: asks Claude to write the actual appeal letter, but only
//      allowed to use the facts extracted in step 2. This is what stops
//      the model from inventing a policy citation that was never there.
//
// The Anthropic API key lives only in this file's environment (server
// side). The browser never sees it.

import Anthropic from "@anthropic-ai/sdk";
import { checkRateLimit } from "./_rateLimit.js";
import { applyCors } from "./_cors.js";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Use a current Claude model. Sonnet is the right balance of quality and
// cost for reading documents and writing a multi-paragraph letter.
const MODEL = "claude-sonnet-5";

// ---------- Helpers ----------

// Claude accepts PDFs and images as native document/image content blocks.
// This turns an uploaded file (base64 + mime type) into the right block.
function fileToContentBlock(file) {
  if (!file || !file.data) return null;
  const isPdf = file.mimeType === "application/pdf";
  return {
    type: isPdf ? "document" : "image",
    source: {
      type: "base64",
      media_type: file.mimeType,
      data: file.data, // base64 string, no "data:...;base64," prefix
    },
  };
}

// Defensive JSON parsing — models sometimes wrap JSON in markdown fences
// even when told not to. Strip that before parsing.
function parseJsonLoose(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

// ---------- Step 1: Extraction ----------

const EXTRACTION_SYSTEM_PROMPT = `You are a meticulous health insurance claims analyst.
You read denial letters and Explanation of Benefits (EOB) documents and extract
structured facts. You never guess or invent information. If a field is not
clearly present in the documents, set it to null. Output ONLY valid JSON matching
the schema below — no prose, no markdown code fences, nothing before or after it.

Schema:
{
  "insurer": string or null,
  "member_name": string or null,
  "claim_number": string or null,
  "date_of_denial": string or null (format: YYYY-MM-DD if a date is stated),
  "cpt_or_procedure_codes": array of strings (empty array if none found),
  "denial_reason_raw": string or null (the exact or near-exact reason as stated in the letter),
  "denial_reason_category": one of "not_medically_necessary" | "experimental_investigational" | "out_of_network" | "missing_prior_authorization" | "other" | "unclear",
  "appeal_deadline_date": string or null (YYYY-MM-DD; calculate from a stated timeframe like "180 days from this notice" if a base date is given, otherwise null),
  "policy_sections_cited_in_letter": array of strings (any policy numbers or section references the INSURER'S OWN LETTER mentions — do not invent any),
  "treatment_or_service_denied": string or null (plain description, e.g. "MRI of the lower back")
}`;

async function extractFacts({ denialFile, eobFile }) {
  const content = [];

  const denialBlock = fileToContentBlock(denialFile);
  if (denialBlock) {
    content.push({ type: "text", text: "Denial letter:" });
    content.push(denialBlock);
  }

  const eobBlock = fileToContentBlock(eobFile);
  if (eobBlock) {
    content.push({ type: "text", text: "Explanation of Benefits (EOB):" });
    content.push(eobBlock);
  }

  content.push({
    type: "text",
    text: "Extract the facts from the document(s) above and return the JSON object described in your instructions.",
  });

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });

  const text = response.content.find((b) => b.type === "text")?.text || "";
  return parseJsonLoose(text);
}

// ---------- Step 2: Letter drafting ----------

const DRAFTING_SYSTEM_PROMPT = `You are Appealist's letter-drafting assistant. You write clear,
plain-language appeal letters for denied health insurance claims. You are not a lawyer
and this is not legal advice — you draft a factual, respectful, firm letter requesting
reconsideration of a denied claim.

Rules you always follow:
1. Use only the facts you are given. Never invent a claim number, policy section, or
   clinical guideline that was not provided to you.
2. If no policy section or guideline was provided, make the medical-necessity or
   coverage argument in plain factual terms instead of fabricating a citation.
3. If the user provided patient context (e.g. "my doctor said this was the only
   option left"), weave it into the argument naturally.
4. Keep the tone calm and firm, never hostile.
5. Structure: a subject line referencing the claim, a clear statement that this is
   a formal appeal, the specific denial reason being contested, the argument against
   it, a request for full reversal, and a closing line asking for a response within
   the insurer's own required appeal timeframe.
6. Output only the letter text. No preamble, no explanation, no markdown formatting
   beyond plain paragraphs.`;

async function draftLetter({ extracted, userAnswers }) {
  const userMessage = `Here are the extracted facts from the patient's denial letter:
${JSON.stringify(extracted, null, 2)}

Here is what the patient told us themselves:
- This claim is for: ${userAnswers.who || "not specified"}
- Insurer (as selected by the patient): ${userAnswers.insurer || "not specified"}
- Denial reason category (as selected by the patient): ${userAnswers.reasonCategory || "not specified"}
- Additional context from the patient: ${userAnswers.context || "none provided"}

Write the appeal letter now, following your instructions exactly.`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: DRAFTING_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  return response.content.find((b) => b.type === "text")?.text || "";
}

// ---------- The actual endpoint ----------

export default async function handler(req, res) {
  if (!applyCors(req, res)) return; // handles OPTIONS + blocks other origins

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  // Rate limit BEFORE doing any AI work — this is the whole point: reject
  // over-limit requests before they cost you a single Anthropic API call.
  const allowed = await checkRateLimit(req, res, {
    name: "generate-appeal",
    perIpLimit: 8, // generous for a real user retrying/editing across a session
    perIpWindowSeconds: 60 * 60, // 1 hour
    globalDailyLimit: 150, // hard daily ceiling across ALL users combined
  });
  if (!allowed) return; // checkRateLimit already sent the response

  try {
    const { denialFile, eobFile, who, insurer, reasonCategory, context } = req.body || {};

    if (!denialFile) {
      return res.status(400).json({ error: "A denial letter file is required." });
    }

    // Basic backend input validation, independent of whatever the frontend
    // already checks — the frontend can always be bypassed by someone
    // calling the API directly, so these checks must live here too.
    if (typeof denialFile !== "object" || !denialFile.data || !denialFile.mimeType) {
      return res.status(400).json({ error: "denialFile must include base64 data and a mimeType." });
    }
    const ALLOWED_MIME_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
    if (!ALLOWED_MIME_TYPES.includes(denialFile.mimeType)) {
      return res.status(400).json({ error: "Denial letter must be a PDF, PNG, JPEG, or WEBP file." });
    }
    // Rough size guard: base64 is ~1.37x the original byte size. 15MB
    // original is already generous for a scanned letter.
    const MAX_BASE64_LENGTH = 15 * 1024 * 1024 * 1.37;
    if (denialFile.data.length > MAX_BASE64_LENGTH) {
      return res.status(400).json({ error: "Denial letter file is too large (max ~15MB)." });
    }
    if (eobFile && (typeof eobFile !== "object" || !eobFile.data || !eobFile.mimeType)) {
      return res.status(400).json({ error: "eobFile, if provided, must include base64 data and a mimeType." });
    }
    if (eobFile && !ALLOWED_MIME_TYPES.includes(eobFile.mimeType)) {
      return res.status(400).json({ error: "EOB must be a PDF, PNG, JPEG, or WEBP file." });
    }

    const extracted = await extractFacts({ denialFile, eobFile });
    const letter = await draftLetter({
      extracted,
      userAnswers: { who, insurer, reasonCategory, context },
    });

    return res.status(200).json({ extracted, letter });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Something went wrong generating your appeal. Please try again.",
    });
  }
}
