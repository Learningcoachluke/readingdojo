// Generates a reading passage + comprehension quiz for the given topic and
// year level, moderates both the topic and the output, and stores the
// session server-side (the client never gets to write its own passage/
// score rows — see reading_sessions RLS in supabase/schema.sql).

const { getBoyId } = require("./_lib/auth");
const { insertOne, insertMany } = require("./_lib/supabaseRest");
const { checkAndLog } = require("./_lib/rateLimit");
const { hardBlockCheck } = require("./_lib/moderation");
const { wordTargetForYear, questionMixForYear } = require("./_lib/yearLevels");

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

    const topic = (body.topic || "").trim();
    const yearLevel = parseInt(body.yearLevel, 10);
    if (!topic || topic.length > 200) {
      return { statusCode: 400, body: JSON.stringify({ error: "Topic must be 1-200 characters." }) };
    }
    if (!Number.isInteger(yearLevel) || yearLevel < 2 || yearLevel > 10) {
      return { statusCode: 400, body: JSON.stringify({ error: "Year level must be between 2 and 10." }) };
    }

    const logUsage = await checkAndLog(boyId, "create-passage");

    const topicCheck = await hardBlockCheck(topic);
    if (topicCheck.blocked) {
      return {
        statusCode: 422,
        body: JSON.stringify({ blocked: true, message: "That topic isn't one we can build a passage for — try a different one." }),
      };
    }

    const { shortAnswerCount, multipleChoiceCount } = questionMixForYear(yearLevel);
    const wordTarget = wordTargetForYear(yearLevel);

    const generated = await generatePassage({ apiKey, topic, yearLevel, wordTarget, multipleChoiceCount, shortAnswerCount });

    // Single check, no retry: Netlify's ~10s synchronous function timeout
    // doesn't leave room for a second sequential Claude call. The topic was
    // already hard-blocked above and the system prompt itself instructs
    // Claude to redirect unsafe topics, so this is a backstop, not the
    // primary defense — if it trips, the boy just submits again (a fresh
    // generation), rather than this function retrying internally.
    const passageCheck = await hardBlockCheck(generated.passage);
    if (passageCheck.blocked) {
      return {
        statusCode: 422,
        body: JSON.stringify({ blocked: true, message: "Couldn't build a passage for that topic — try again." }),
      };
    }

    const wordCount = generated.passage.trim().split(/\s+/).filter(Boolean).length;

    const session = await insertOne("reading_sessions", {
      boy_id: boyId,
      topic,
      year_level: yearLevel,
      passage_title: generated.title,
      passage_text: generated.passage,
      word_count: wordCount,
      status: "generated",
    });

    const questionRows = generated.questions.map((q, i) => ({
      session_id: session.id,
      question_index: i,
      question_type: q.type,
      question_text: q.question,
      options: q.type === "multiple_choice" ? q.options : null,
      correct_option_index: q.type === "multiple_choice" ? q.correctIndex : null,
      model_answer: q.type === "short_answer" ? q.modelAnswer : null,
      explanation: q.explanation || null,
    }));
    // Run independently of each other to trim one round trip off the total.
    const [insertedQuestions] = await Promise.all([insertMany("comprehension_questions", questionRows), logUsage()]);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.id,
        title: generated.title,
        passage: generated.passage,
        questions: insertedQuestions
          .slice()
          .sort((a, b) => a.question_index - b.question_index)
          .map((q) => ({
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

async function generatePassage({ apiKey, topic, yearLevel, wordTarget, multipleChoiceCount, shortAnswerCount, strict }) {
  const total = multipleChoiceCount + shortAnswerCount;
  const outputBudget = Math.min(4096, 900 + total * 150);

  const systemPrompt = `You write short reading passages and comprehension quizzes for a kids' reading practice app called Reading Dojo, used by boys aged roughly 7-15 (Year 2-10).

Rules:
- Write in an engaging, fun voice for a boy this age — this audience enjoys gaming, sports, competition, gross/wild facts, and pop culture. Don't be preachy or overly sanitized.
- Keep it free of explicit sexual content, sexual content involving minors, graphic gore or extreme violence, hate speech, self-harm promotion, illegal drug instructions, and swearing. Mild peril, competitive/game violence, and gross-out humor are all fine.
${strict ? "- The previous attempt was flagged as inappropriate. Be noticeably more conservative this time while still being fun and on-topic.\n" : ""}- If the requested topic is unsafe or not age-appropriate, quietly redirect to the closest safe, appropriate angle on that topic without mentioning that you changed it.
- Match reading difficulty (vocabulary, sentence length, sentence complexity, idea density) to the given year level. Year 9-10 passages can use longer sentences and more sophisticated vocabulary and ideas than Year 2-4.
- Output ONLY valid JSON as a single line, no markdown fences, no commentary, matching exactly this shape:
{"title":"string","passage":"string; use the two-character escape sequence \\n\\n between paragraphs — do NOT put a literal line break inside the JSON string, it must stay valid single-line JSON","questions":[{"type":"multiple_choice","question":"string","options":["string","string","string","string"],"correctIndex":0,"explanation":"one short sentence, under 15 words"}]}
  (short-answer questions instead use: {"type":"short_answer","question":"string","modelAnswer":"string — a full reference answer for grading","explanation":"one short sentence, under 15 words"})
- Write exactly ${multipleChoiceCount} questions with "type":"multiple_choice" and exactly ${shortAnswerCount} questions with "type":"short_answer", in any order.
- Base questions on a mix of literal recall, vocabulary-in-context, and (for year 5+) inference; for year 7+ also include some analysis/author's-purpose style questions. Keep wording age-appropriate.
- Multiple-choice: exactly one correct option, options short and plausible (no joke/throwaway options).
- Short-answer: the modelAnswer should be a full sentence or two capturing what a correct answer needs to include, since it'll be used to grade the boy's own written answer.
- Keep each question, option, and explanation concise so the full response stays compact.
- Do not include any text outside the JSON object.`;

  const userPrompt = `Topic: ${topic}\nYear level: Year ${yearLevel}\nTarget passage length: ${wordTarget} words.\nGenerate the passage and questions now as JSON only.`;

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
