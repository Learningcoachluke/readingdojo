// Transcribes a boy's read-aloud recording via OpenAI, scores accuracy/WPM
// server-side, and stores the transcript + stats — never the audio itself.
// The decoded audio buffer lives only in this function's memory for the
// duration of the request; nothing writes it to Storage, Blobs, or disk.

const { getBoyId } = require("./_lib/auth");
const { selectOne, updateOne, insertOne } = require("./_lib/supabaseRest");
const { checkAndLog } = require("./_lib/rateLimit");
const { softFlagCheck } = require("./_lib/moderation");
const { computeAccuracy, computeWpm } = require("./_lib/readingAccuracy");

// Maps a MediaRecorder mimeType to the multipart filename extension/
// Content-Type OpenAI expects. Ported from reading-dojo-openai-deploy_1.zip's
// transcribe-reading.js, fixed to use the browser's ACTUAL negotiated
// mimeType instead of hardcoding "audio/webm" — Safari records audio/mp4,
// and hardcoding webm there silently breaks or garbles transcription.
const MIME_EXT = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Server is missing OPENAI_API_KEY. Add it in Netlify → Site configuration → Environment variables.",
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

    const { sessionId, audioBase64, mimeType, durationMs } = body;
    if (!sessionId || !audioBase64 || !durationMs) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing sessionId, audioBase64, or durationMs." }) };
    }

    const session = await selectOne("reading_sessions", `id=eq.${sessionId}&boy_id=eq.${boyId}`);
    if (!session) {
      return { statusCode: 404, body: JSON.stringify({ error: "Session not found." }) };
    }
    // Allow re-scoring the same session as many times as needed (the
    // "Read Again" flow) right up until the quiz is graded — each call
    // overwrites the previous attempt's transcript/accuracy/wpm, and only
    // the attempt still standing when the boy reaches "completed" ever
    // counts toward his stats (my_reading_stats filters on status).
    if (session.status === "completed") {
      return { statusCode: 409, body: JSON.stringify({ error: "This reading's quiz has already been graded." }) };
    }

    const logUsage = await checkAndLog(boyId, "transcribe-and-score");

    let audioBuffer;
    try {
      audioBuffer = Buffer.from(audioBase64, "base64");
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid audio data." }) };
    }
    if (audioBuffer.length > 24 * 1024 * 1024) {
      return { statusCode: 413, body: JSON.stringify({ error: "That recording is too large — try again." }) };
    }

    const baseMime = (mimeType || "audio/webm").split(";")[0];
    const ext = MIME_EXT[baseMime] || "webm";

    const boundary = "----ReadingDojoBoundary" + Math.random().toString(16).slice(2);
    const preFile = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="reading.${ext}"\r\nContent-Type: ${baseMime}\r\n\r\n`
    );
    const modelField = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-4o-transcribe\r\n--${boundary}--\r\n`
    );
    const multipartBody = Buffer.concat([preFile, audioBuffer, modelField]);

    const transcribeRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: multipartBody,
    });

    if (!transcribeRes.ok) {
      const errText = await transcribeRes.text();
      return { statusCode: 502, body: JSON.stringify({ error: "Transcription failed.", detail: errText.slice(0, 300) }) };
    }

    const transcribeData = await transcribeRes.json();
    const transcript = transcribeData.text || "";

    const durationSeconds = durationMs / 1000;
    const accuracyPct = computeAccuracy(session.passage_text, transcript);
    const wpm = computeWpm(transcript, durationSeconds);

    // Soft-flag on the transcript — best-effort, never fails the request.
    try {
      const flagResult = await softFlagCheck(transcript);
      if (flagResult.flagged) {
        await insertOne("flagged_content", {
          boy_id: boyId,
          session_id: sessionId,
          source: "transcript",
          content_snippet: transcript.slice(0, 500),
          category: flagResult.categories.join(","),
        });
      }
    } catch (e) {
      // A moderation hiccup should never block the boy from seeing his result.
    }

    await updateOne("reading_sessions", `id=eq.${sessionId}`, {
      transcript,
      accuracy_pct: accuracyPct,
      wpm,
      reading_duration_seconds: durationSeconds,
      status: "reading_submitted",
    });

    await logUsage();

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accuracyPct, wpm, durationSeconds, transcript }),
    };
  } catch (err) {
    const statusCode = err.statusCode || 500;
    return { statusCode, body: JSON.stringify({ error: err.message || "Something went wrong." }) };
  }
};
