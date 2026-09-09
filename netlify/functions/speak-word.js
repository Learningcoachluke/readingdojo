// Synthesizes a word OR a dragged-selection phrase as speech via
// ElevenLabs, so a boy can tap a single word, or drag across several, and
// hear it read aloud. Deliberately lightweight compared to the other
// functions: no DB row is written (this is a pronunciation aid, not part
// of the reading record), and the safety check is a local wordlist rather
// than a full Moderation API call — this endpoint may be called very
// frequently per session and the content is always short.

const { getBoyId } = require("./_lib/auth");
const { checkAndLog } = require("./_lib/rateLimit");
const { containsProfanity } = require("./_lib/moderation");

const DEFAULT_VOICE_ID = "pNInz6obpgDQGcFmaJgB"; // ElevenLabs premade voice "Adam"
const DAILY_WORD_AUDIO_LIMIT = 300;
// Letters/digits/apostrophes/hyphens for single words, plus spaces and
// common sentence punctuation for dragged multi-word phrases (keeping the
// original punctuation gives ElevenLabs natural pauses/intonation). Capped
// at 300 chars — comfortably a sentence or two, not a whole passage.
const TEXT_PATTERN = /^[a-zA-Z0-9\s'".,!?;:()-]{1,300}$/;

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

    const text = (body.text || body.word || "").trim();
    if (!TEXT_PATTERN.test(text)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid text." }) };
    }
    if (containsProfanity(text)) {
      return { statusCode: 422, body: JSON.stringify({ error: "That can't be read aloud." }) };
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
        text,
        model_id: "eleven_flash_v2_5", // ElevenLabs' lowest-latency model — right fit for short clips at high click volume
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
