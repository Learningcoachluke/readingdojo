// Synthesizes a single word as speech via ElevenLabs, so a boy can tap a
// word in the passage he's stuck on and hear it read aloud. Deliberately
// lightweight compared to the other functions: no DB row is written (this
// is a pronunciation aid, not part of the reading record), and the safety
// check is a local wordlist rather than a full Moderation API call — a
// single word has nowhere near the risk surface of a whole passage, and
// this endpoint may be called very frequently per session.

const { getBoyId } = require("./_lib/auth");
const { checkAndLog } = require("./_lib/rateLimit");
const { containsProfanity } = require("./_lib/moderation");

const DEFAULT_VOICE_ID = "pNInz6obpgDQGcFmaJgB"; // ElevenLabs premade voice "Adam"
const DAILY_WORD_AUDIO_LIMIT = 300;
const WORD_PATTERN = /^[a-zA-Z0-9'-]{1,50}$/;

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Server is missing ELEVENLABS_API_KEY. Add it in Netlify → Site configuration → Environment variables.",
      }),
    };
  }

  try {
    const boyId = await getBoyId(event);

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
    }

    const word = (body.word || "").trim();
    if (!WORD_PATTERN.test(word)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid word." }) };
    }
    if (containsProfanity(word)) {
      return { statusCode: 422, body: JSON.stringify({ error: "That word can't be read aloud." }) };
    }

    const logUsage = await checkAndLog(
      boyId,
      "speak-word",
      Number(process.env.DAILY_WORD_AUDIO_LIMIT) || DAILY_WORD_AUDIO_LIMIT
    );

    const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: word,
        model_id: "eleven_flash_v2_5", // ElevenLabs' lowest-latency model — right fit for single words at high click volume
      }),
    });

    if (!ttsRes.ok) {
      const detail = await ttsRes.text();
      return { statusCode: 502, body: JSON.stringify({ error: "Speech generation failed.", detail: detail.slice(0, 300) }) };
    }

    const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
    await logUsage();

    return {
      statusCode: 200,
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=86400" },
      body: audioBuffer.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    const statusCode = err.statusCode || 500;
    return { statusCode, body: JSON.stringify({ error: err.message || "Something went wrong." }) };
  }
};
