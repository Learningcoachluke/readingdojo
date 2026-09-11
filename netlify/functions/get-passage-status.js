// Polled by the client (every ~1.5s, see dojo.html's pollForPassage) while
// create-passage-background.js is working. Deliberately does not let the
// client read comprehension_questions directly via Supabase RLS: RLS only
// controls which ROWS a boy can see, not which COLUMNS — and that table's
// correct_option_index/model_answer must never reach the browser. This
// function shapes the response the same safe way the old single-call
// create-passage.js used to.

const { getBoyId } = require("./_lib/auth");
const { selectOne, select } = require("./_lib/supabaseRest");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const boyId = await getBoyId(event);

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
    }
    const sessionId = body.sessionId;
    if (!sessionId) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing sessionId." }) };
    }

    const session = await selectOne(
      "reading_sessions",
      `id=eq.${sessionId}&boy_id=eq.${boyId}&select=id,status,passage_title,passage_text,error_message`
    );
    if (!session) {
      return { statusCode: 404, body: JSON.stringify({ error: "Session not found." }) };
    }

    if (session.status === "blocked" || session.status === "failed") {
      // 'blocked' stores a message that's already friendly enough to show
      // as-is. 'failed' stores the real technical reason for Luke to check
      // in the Supabase table — the boy always gets a generic retry instead.
      const message =
        session.status === "blocked"
          ? session.error_message || "Couldn't build that passage — try again."
          : "Couldn't build that passage — try again.";
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: session.status, blocked: session.status === "blocked", message: message }),
      };
    }

    if (session.status !== "generated") {
      // Still 'generating' — nothing more to report yet.
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "generating" }),
      };
    }

    const questions = await select(
      "comprehension_questions",
      `session_id=eq.${sessionId}&select=id,question_index,question_type,question_text,options&order=question_index.asc`
    );

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "generated",
        sessionId: session.id,
        title: session.passage_title,
        passage: session.passage_text,
        questions: questions.map((q) => ({
          id: q.id,
          index: q.question_index,
          type: q.question_type,
          question: q.question_text,
          options: q.options || undefined,
        })),
      }),
    };
  } catch (err) {
    const statusCode = err.statusCode || 500;
    return { statusCode, body: JSON.stringify({ error: err.message || "Something went wrong." }) };
  }
};
