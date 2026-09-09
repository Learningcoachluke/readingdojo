// OpenAI Moderation calls, calibrated per Luke's explicit instruction:
// "not too restrictive... boys might pick some more juicy topics... license
// for creativity... just the obvious: no swear words or heavily
// inappropriate material." So hard-block only the severe categories
// (notably violence/graphic and harassment/threatening, NOT plain
// violence/harassment — mild peril, competitive trash-talk, and gross-out
// humor must pass freely). Soft-flag is a separate, wider, non-blocking
// check used only on stored transcripts/short-answers for human review.

const HARD_BLOCK_CATEGORIES = [
  "sexual",
  "sexual/minors",
  "hate",
  "hate/threatening",
  "violence/graphic",
  "self-harm/intent",
  "self-harm/instructions",
  "harassment/threatening",
  "illicit",
  "illicit/violent",
];

const SOFT_FLAG_CATEGORIES = [
  "self-harm",
  "self-harm/intent",
  "self-harm/instructions",
  "harassment",
  "harassment/threatening",
  "violence",
];

// Small, deliberately short list — defense-in-depth on top of the
// Moderation API, not a substitute for it. Whole-word, case-insensitive.
// Deliberately excludes words that double as common names/animals/objects
// (e.g. "dick", "cock", "pussy") — tested against real phrases ("Moby Dick
// is a novel", "the cockpit was loud", "a pussy willow") and those produced
// false positives, which cuts against the explicit "don't over-block"
// calibration. The Moderation API's "sexual"/"harassment" categories still
// catch genuinely inappropriate uses of those words in context.
const PROFANITY_WORDS = [
  "fuck", "shit", "bitch", "asshole", "cunt", "piss", "bastard",
  "slut", "whore", "nigger", "faggot", "retard",
];
const PROFANITY_RE = new RegExp(`\\b(${PROFANITY_WORDS.join("|")})\\b`, "i");

async function moderate(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error("Server is missing OPENAI_API_KEY.");
    err.statusCode = 500;
    throw err;
  }
  const res = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: "omni-moderation-latest", input: text }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Moderation request failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.results[0];
}

function categoriesTripped(result, categoryList) {
  if (!result || !result.categories) return [];
  return categoryList.filter((c) => result.categories[c]);
}

async function hardBlockCheck(text) {
  if (PROFANITY_RE.test(text)) return { blocked: true, categories: ["profanity-wordlist"] };
  const result = await moderate(text);
  const tripped = categoriesTripped(result, HARD_BLOCK_CATEGORIES);
  return { blocked: tripped.length > 0, categories: tripped };
}

async function softFlagCheck(text) {
  const result = await moderate(text);
  const tripped = categoriesTripped(result, SOFT_FLAG_CATEGORIES);
  return { flagged: tripped.length > 0, categories: tripped };
}

// Cheap, local, no-API-call check for single-word contexts (e.g. word-tap
// audio) where a full Moderation API round trip per click isn't worth the
// latency/cost — the wordlist alone is the realistic risk for one word.
function containsProfanity(text) {
  return PROFANITY_RE.test(text);
}

module.exports = { hardBlockCheck, softFlagCheck, containsProfanity };
