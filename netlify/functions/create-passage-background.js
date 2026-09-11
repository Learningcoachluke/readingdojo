// Does the actual passage + quiz generation. Triggered by create-passage.js
// immediately after it creates a 'generating' reading_sessions row — never
// called directly by the client. Background Functions get a 15-minute
// execution budget (vs. ~10s for a normal synchronous function), which is
// what actually fixes Year 9-10's much bigger completion (16 questions,
// several times what a Year 2-4 request needs) timing out.
//
// This function's own return value is ignored by Netlify (background
// functions always answer the original request with an immediate 202), so
// every outcome — success, a blocked passage, or an unexpected error — is
// communicated the only way the client can see it: by writing the result
// into the reading_sessions row for get-passage-status.js to read back.

const { getBoyId } = require("./_lib/auth");
const { selectOne, insertOne, insertMany, updateOne } = require("./_lib/supabaseRest");
const { hardBlockCheck } = require("./_lib/moderation");
const { wordTargetForYear, questionMixForYear } = require("./_lib/yearLevels");

exports.handler = async function (event) {
  let sessionId;
  try {
    const body = JSON.parse(event.body || "{}");
    sessionId = body.sessionId;
    const topic = (body.topic || "").trim();
    const yearLevel = parseInt(body.yearLevel, 10);
    const genre = body.genre === "fiction" ? "fiction" : "nonfiction";

    if (!sessionId) return { statusCode: 202, body: "" };

    // Re-validates the forwarded JWT and confirms the session actually
    // belongs to whoever triggered this — this endpoint is a public URL
    // like any other Netlify function, so it can't just trust its inputs.
    const boyId = await getBoyId(event);
    const session = await selectOne("reading_sessions", `id=eq.${sessionId}&select=id,boy_id,status`);
    if (!session || session.boy_id !== boyId || session.status !== "generating") {
      return { statusCode: 202, body: "" };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const { shortAnswerCount, multipleChoiceCount } = questionMixForYear(yearLevel);
    const wordTarget = wordTargetForYear(yearLevel);

    let generated;
    try {
      generated = await generatePassage({ apiKey, topic, yearLevel, genre, wordTarget, multipleChoiceCount, shortAnswerCount });
    } catch (genErr) {
      // Log the real reason server-side (visible to Luke in the Supabase
      // table) without leaking it to the boy, who just gets a generic retry.
      await updateOne("reading_sessions", `id=eq.${sessionId}`, {
        status: "failed",
        error_message: `Generation error: ${genErr.message}`.slice(0, 500),
      });
      return { statusCode: 202, body: "" };
    }

    // Single check, no retry: even with the 15-minute budget, a second
    // sequential Claude call just to regenerate on a flagged passage isn't
    // worth the wait for the boy — if it trips, he just submits again.
    const passageCheck = await hardBlockCheck(generated.passage);
    if (passageCheck.blocked) {
      await updateOne("reading_sessions", `id=eq.${sessionId}`, {
        status: "blocked",
        error_message: "Couldn't build a passage for that topic — try again.",
      });
      return { statusCode: 202, body: "" };
    }

    const wordCount = generated.passage.trim().split(/\s+/).filter(Boolean).length;

    const questionRows = generated.questions.map((q, i) => ({
      session_id: sessionId,
      question_index: i,
      question_type: q.type,
      question_text: q.question,
      options: q.type === "multiple_choice" ? q.options : null,
      correct_option_index: q.type === "multiple_choice" ? q.correctIndex : null,
      model_answer: q.type === "short_answer" ? q.modelAnswer : null,
      explanation: q.explanation || null,
    }));
    // Insert the questions BEFORE flipping status to 'generated' — the
    // client stops polling the instant it sees that status, so if the rows
    // went in afterward there'd be a real window where it could grab zero
    // questions and then silently break when the boy reaches the quiz.
    await insertMany("comprehension_questions", questionRows);

    await updateOne("reading_sessions", `id=eq.${sessionId}`, {
      passage_title: generated.title,
      passage_text: generated.passage,
      word_count: wordCount,
      status: "generated",
    });

    // Only logged now that generation has genuinely succeeded — a blocked
    // or failed attempt doesn't count against the boy's daily quota.
    await insertOne("ai_usage_log", { boy_id: boyId, endpoint: "create-passage" });

    return { statusCode: 202, body: "" };
  } catch (err) {
    if (sessionId) {
      try {
        await updateOne("reading_sessions", `id=eq.${sessionId}`, {
          status: "failed",
          error_message: "Something went wrong building that passage — try again.",
        });
      } catch (e) {
        // Nothing more we can do — the client's poll will eventually time out on its own.
      }
    }
    return { statusCode: 202, body: "" };
  }
};

async function generatePassage({ apiKey, topic, yearLevel, genre, wordTarget, multipleChoiceCount, shortAnswerCount, strict }) {
  const total = multipleChoiceCount + shortAnswerCount;
  const outputBudget = Math.min(4096, 900 + total * 150);

  const genreInstructions =
    genre === "fiction"
      ? `- Write a short FICTION story that uses the topic as its subject, setting, or central plot device. It must read like an actual story, not a factual explanation: invent named characters, give them a clear problem or conflict to face, include some dialogue in quotation marks, and use descriptive/sensory language. For Year 5+, work in at least one language feature such as personification, simile, or metaphor. It needs a real beginning, middle, and end — not just a slice of action.`
      : `- Write a short NON-FICTION informational text — factually accurate and precise, not a story. Do not invent characters, dialogue, or fictional events. Structure it with 2-4 short subheadings marking distinct sections: each subheading goes on its own line starting with "## " (e.g. "## How Motocross Bikes Are Built"), followed by a blank line, then that section's paragraph(s). Make it genuinely interesting by including specific real numbers, statistics, percentages, dates, or measurements where they're relevant to the topic (e.g. speeds, sizes, record counts, years) — concrete facts, not vague generalities. Stick to well-established, verifiable information; if you're not confident about a specific fact, keep that part general rather than inventing a number or detail.`;

  const questionStyle =
    genre === "fiction"
      ? `Base questions on plot, character, setting, and (for year 5+) inference about characters' feelings or motives.`
      : `Base questions on a mix of literal recall, vocabulary-in-context, and (for year 5+) inference; for year 7+ also include some analysis/author's-purpose style questions.`;

  const systemPrompt = `You write short reading passages and comprehension quizzes for a kids' reading practice app called Reading Dojo, used by boys aged roughly 7-15 (Year 2-10).

Rules:
- Write in an engaging, fun voice for a boy this age — this audience enjoys gaming, sports, competition, gross/wild facts, and pop culture. Don't be preachy or overly sanitized.
- Keep it free of explicit sexual content, sexual content involving minors, graphic gore or extreme violence, hate speech, self-harm promotion, illegal drug instructions, and swearing. Mild peril, competitive/game violence, and gross-out humor are all fine.
${strict ? "- The previous attempt was flagged as inappropriate. Be noticeably more conservative this time while still being fun and on-topic.\n" : ""}- If the requested topic is unsafe or not age-appropriate, quietly redirect to the closest safe, appropriate angle on that topic without mentioning that you changed it.
${genreInstructions}
- Match reading difficulty (vocabulary, sentence length, sentence complexity, idea density) to the given year level. Year 9-10 passages can use longer sentences and more sophisticated vocabulary and ideas than Year 2-4.
- Output ONLY valid JSON as a single line, no markdown fences, no commentary, matching exactly this shape:
{"title":"string","passage":"string; use the two-character escape sequence \\n\\n between paragraphs — do NOT put a literal line break inside the JSON string, it must stay valid single-line JSON","questions":[{"type":"multiple_choice","question":"string","options":["string","string","string","string"],"correctIndex":0,"explanation":"under 10 words"}]}
  (short-answer questions instead use: {"type":"short_answer","question":"string","modelAnswer":"one concise sentence covering what a correct answer needs to include","explanation":"under 10 words"})
- Write exactly ${multipleChoiceCount} questions with "type":"multiple_choice" and exactly ${shortAnswerCount} questions with "type":"short_answer", in any order.
- ${questionStyle} Keep wording age-appropriate.
- Multiple-choice: exactly one correct option, options short and plausible (no joke/throwaway options).
- Short-answer: the modelAnswer is one concise sentence (not a paragraph) capturing what a correct answer needs to include, since it'll be used to grade the boy's own written answer.
- Be direct and efficient throughout — no padding, no restating the question, no throat-clearing before getting to the point. This matters most for higher year levels, which have the most questions to get through.
- Keep each question, option, explanation, and model answer concise so the full response stays compact.
- Do not include any text outside the JSON object.`;

  const userPrompt = `Topic: ${topic}\nGenre: ${genre === "fiction" ? "Fiction (story)" : "Non-fiction (factual, with subheadings)"}\nYear level: Year ${yearLevel}\nTarget passage length: ${wordTarget} words.\nGenerate the passage and questions now as JSON only.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: outputBudget,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Passage generation failed (${response.status}): ${bodyText.slice(0, 300)}`);
  }

  const data = await response.json();
  const textBlocks = (data.content || []).filter((b) => b.type === "text").map((b) => b.text);
  let raw = textBlocks.join("").trim();
  raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

  if (!raw) throw new Error("Empty response while generating the passage.");

  // Despite the prompt instruction, the model sometimes writes a literal
  // newline inside a string value (e.g. between passage paragraphs) instead
  // of the escaped \n sequence, which is invalid JSON. Escape any raw
  // control characters found INSIDE string literals before parsing —
  // tracking string boundaries so we never touch structural whitespace
  // outside strings.
  raw = escapeControlCharsInStrings(raw);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(
        `The passage response wasn't valid JSON (stop_reason=${data.stop_reason}). Raw: ${raw.slice(0, 500)}`
      );
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch (e2) {
      throw new Error(
        `The passage response wasn't valid JSON, even after cleanup (stop_reason=${data.stop_reason}, parse error: ${e2.message}). Raw: ${raw.slice(0, 800)}`
      );
    }
  }

  if (!parsed.passage || !Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new Error("The passage response was missing the passage or questions.");
  }

  return parsed;
}

// Walks the text tracking whether we're inside a JSON string literal
// (respecting backslash escapes), and escapes raw control characters
// (newline/tab/carriage-return) only when found inside one. Leaves
// structural whitespace between JSON tokens untouched.
function escapeControlCharsInStrings(text) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        result += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        result += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        result += ch;
        inString = false;
        continue;
      }
      if (ch === "\n") { result += "\\n"; continue; }
      if (ch === "\r") { result += "\\r"; continue; }
      if (ch === "\t") { result += "\\t"; continue; }
      result += ch;
    } else {
      if (ch === '"') inString = true;
      result += ch;
    }
  }
  return result;
}
