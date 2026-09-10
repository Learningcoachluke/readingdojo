// Full stats breakdown for one student, for the coach dashboard's
// drill-down view: profile, overall aggregate, per-year-level breakdown,
// and the latest completed session — the same shape a boy sees on his
// own stats.html, just fetched for an arbitrary student by the coach.

const { requireAdminId } = require("./_lib/requireAdmin");
const { select, selectOne } = require("./_lib/supabaseRest");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    await requireAdminId(event);

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
    }

    const studentId = body.studentId;
    if (!studentId) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing studentId." }) };
    }

    const [profile, overall, byYear, latestRows] = await Promise.all([
      selectOne("profiles", `id=eq.${studentId}&select=id,username,display_name`),
      selectOne("my_reading_stats", `boy_id=eq.${studentId}`),
      select("my_reading_stats_by_year", `boy_id=eq.${studentId}&order=year_level.asc`),
      select(
        "reading_sessions",
        `boy_id=eq.${studentId}&status=eq.completed&order=created_at.desc&limit=1&select=topic,year_level,passage_title,accuracy_pct,wpm,created_at`
      ),
    ]);

    if (!profile) {
      return { statusCode: 404, body: JSON.stringify({ error: "Student not found." }) };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: profile.display_name,
        username: profile.username,
        overall: overall || null,
        byYear: byYear || [],
        latest: latestRows[0] || null,
      }),
    };
  } catch (err) {
    const statusCode = err.statusCode || 500;
    return { statusCode, body: JSON.stringify({ error: err.message || "Something went wrong." }) };
  }
};
