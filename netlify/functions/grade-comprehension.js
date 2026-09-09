// Grades a finished quiz: multiple-choice is compared server-side against
// the stored correct_option_index (never trusting a client-sent flag),
// short-answer is graded by one batched Claude call. Nothing in
// comprehension_responses is ever written by anything but this function.

const { getBoyId } = require("./_lib/auth");
const { selectOne, select, updateOne, insertMany, insertOne } = require("./_lib/supabaseRest");
const { checkAndLog } = require("./_lib/rateLimit");
const { softFlagCheck } = require("./_lib/moderation");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
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

    const { sessionId, answers } = body;
    if (!sessionId || !Array.isArray(answers) || answers.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing sessionId or answers." }) };
    }

    const session = await selectOne("reading_sessions", `id=eq.${sessionId}&boy_id=eq.${boyId}`);
    if (!session) {
      return { statusCode: 404, body: JSON.stringify({ error: "Session not found." }) };
    }
    if (session.status !== "reading_submitted") {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: "This quiz has already been graded, or the reading hasn't been submitted yet." }),
      };
    }

    const logUsage = await checkAndLog(boyId, "grade-comprehension");

    const questions = await select("comprehension_questions", `session_id=eq.${sessionId}&order=question_index.asc`);
    const questionById = Object.fromEntries(questions.map((q) => [q.id, q]));

    const mcResults = [];
    const shortAnswerItems = [];

    for (const a of answers) {
      const q = questionById[a.questionId];
      if (!q) continue;
      if (q.question_type === "multiple_choice") {
        const selectedIdx = parseInt(a.answer, 10);
        const isCorrect = selectedIdx === q.correct_option_index;
        mcResults.push({
          questionId: q.id,
          isCorrect,
          feedback: q.explanation || (isCorrect ? "Correct!" : "Not quite."),
          boyAnswer: String(a.answer),
        });
      } else {
        shortAnswerItems.push({ question: q, boyAnswer: (a.answer || "").toString() });
      }
    }

    const shortAnswerResults = shortAnswerItems.length
      ? await gradeShortAnswers({ apiKey, passage: session.passage_text, items: shortAnswerItems })
      : [];

    // Soft-flag each short-answer text — best-effort, never blocks grading.
    for (const item of shortAnswerItems) {
      try {
        const flagResult = await softFlagCheck(item.boyAnswer);
        if (flagResult.flagged) {
          await insertOne("flagged_content", {
            boy_id: boyId,
            session_id: sessionId,
            source: "short_answer_response",
            content_snippet: item.boyAnswer.slice(0, 500),
            category: flagResult.categories.join(","),
          });
        }
      } catch (e) {
        // Ignore moderation hiccups — grading must still complete.
      }
    }

    const responseRows = [
      ...mcResults.map((r) => ({
        session_id: sessionId,
        question_id: r.questionId,
        boy_answer: r.boyAnswer,
        is_correct: r.isCorrect,
        ai_feedback: r.feedback,
      })),
      ...shortAnswerResults.map((r) => ({
        session_id: sessionId,
        question_id: r.questionId,
        boy_answer: r.boyAnswer,
        is_correct: r.isCorrect,
        ai_feedback: r.feedback,
      })),
    ];

    await insertMany("comprehension_responses", responseRows);
    await updateOne("reading_sessions", `id=eq.${sessionId}`, {
      status: "completed",
      completed_at: new Date().toISOString(),
    });
    await logUsage();

    const allResults = [...mcResults, ...shortAnswerResults];
    const correctCount = allResults.filter((r) => r.isCorrect).length;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        results: allResults.map((r) => ({ questionId: r.questionId, isCorrect: r.isCorrect, feedback: r.feedback })),
        correctCount,
        total: allResults.length,
      }),
    };
  } catch (err) {
    const statusCode = err.statusCode || 500;
    return { statusCode, body: JSON.stringify({ error: err.message || "Something went wrong." }) };
  }
};

async function gradeShortAnswers({ apiKey, passage, items }) {
  const systemPrompt = `You grade a boy's short-answer responses to comprehension questions about a reading passage, for a kids' reading app called Reading Dojo. Be encouraging but honest — mark it correct if it captures the key idea of the model answer, even with different wording; don't require exact phrasing. Output ONLY valid JSON, no markdown fences, no commentary, matching exactly this shape: {"results":[{"index":0,"isCorrect":true,"feedback":"one short encouraging sentence, under 20 words"}]}`;

  const userPrompt = `Passage:\n${passage}\n\nQuestions and answers to grade:\n${items
    .map(
      (item, i) =>
        `${i}. Question: ${item.question.question_text}\nModel answer: ${item.question.model_answer}\nBoy's answer: ${
          item.boyAnswer || "(no answer given)"
        }`
    )
    .join("\n\n")}\n\nGrade all ${items.length} now as JSON only.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: Math.min(2048, 200 + items.length * 100),
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Comprehension grading failed (${response.status}): ${bodyText.slice(0, 300)}`);
  }

  const data = await response.json();
  const textBlocks = (data.content || []).filter((b) => b.type === "text").map((b) => b.text);
  let raw = textBlocks.join("").trim();
  raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Grading response wasn't valid JSON.");
    parsed = JSON.parse(match[0]);
  }

  if (!Array.isArray(parsed.results)) throw new Error("Grading response was missing results.");

  return parsed.results
    .filter((r) => items[r.index])
    .map((r) => ({
      questionId: items[r.index].question.id,
      boyAnswer: items[r.index].boyAnswer,
      isCorrect: !!r.isCorrect,
      feedback: r.feedback || "",
    }));
}
