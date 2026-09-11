// Kicks off passage generation and returns immediately — the actual AI call
// happens in create-passage-background.js, a Netlify Background Function
// with a 15-minute budget instead of this function's ~10s synchronous
// limit. Year 9-10 requests (16 questions, the biggest single completion
// this app asks for) were routinely blowing past that 10s ceiling, which
// is what this split fixes. The client polls get-passage-status.js (see
// that file) using the sessionId this returns, while the existing loading
// screen (with its mini-games) keeps the boy occupied in the meantime.

const { getBoyId } = require("./_lib/auth");
const { insertOne, updateOne } = require("./_lib/supabaseRest");
const { checkAndLog } = require("./_lib/rateLimit");
const { hardBlockCheck } = require("./_lib/moderation");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Server is missing ANTHROPIC_API_KEY. Add it in Netlify → Site configuration → Environment variables.",
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

    const topic = (body.topic || "").trim();
    const yearLevel = parseInt(body.yearLevel, 10);
    const genre = body.genre === "fiction" ? "fiction" : body.genre === "nonfiction" ? "nonfiction" : null;
    if (!topic || topic.length > 200) {
      return { statusCode: 400, body: JSON.stringify({ error: "Topic must be 1-200 characters." }) };
    }
    if (!Number.isInteger(yearLevel) || yearLevel < 2 || yearLevel > 10) {
      return { statusCode: 400, body: JSON.stringify({ error: "Year level must be between 2 and 10." }) };
    }
    if (!genre) {
      return { statusCode: 400, body: JSON.stringify({ error: "Genre must be 'fiction' or 'nonfiction'." }) };
    }

    // Checked here so an over-quota boy never gets a session row created at
    // all. Actual usage is logged by the background function once
    // generation genuinely succeeds — not here, since nothing has run yet.
    await checkAndLog(boyId, "create-passage");

    const topicCheck = await hardBlockCheck(topic);
    if (topicCheck.blocked) {
      return {
        statusCode: 422,
        body: JSON.stringify({ blocked: true, message: "That topic isn't one we can build a passage for — try a different one." }),
      };
    }

    const session = await insertOne("reading_sessions", {
      boy_id: boyId,
      topic,
      year_level: yearLevel,
      genre,
      status: "generating",
    });

    const authHeader = event.headers.authorization || event.headers.Authorization;
    const triggerUrl = `${process.env.URL}/.netlify/functions/create-passage-background`;
    let triggerRes;
    try {
      triggerRes = await fetch(triggerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ sessionId: session.id, topic, yearLevel, genre }),
      });
    } catch (e) {
      triggerRes = null;
    }
    if (!triggerRes || !triggerRes.ok) {
      await updateOne("reading_sessions", `id=eq.${session.id}`, {
        status: "failed",
        error_message: "Couldn't start generating that passage — try again.",
      });
      return { statusCode: 502, body: JSON.stringify({ error: "Couldn't start generating that passage — try again." }) };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.id }),
    };
  } catch (err) {
    const statusCode = err.statusCode || 500;
    return { statusCode, body: JSON.stringify({ error: err.message || "Something went wrong." }) };
  }
};
