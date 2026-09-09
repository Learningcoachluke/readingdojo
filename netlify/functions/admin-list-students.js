// Returns every non-admin student with their aggregate reading stats, for
// the coach's dashboard. Excludes the coach's own (is_admin) account.

const { requireAdminId } = require("./_lib/requireAdmin");
const { select } = require("./_lib/supabaseRest");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    await requireAdminId(event);

    const [profiles, stats] = await Promise.all([
      select("profiles", "is_admin=eq.false&select=id,username,display_name,active,created_at&order=display_name.asc"),
      select("my_reading_stats", "select=*"),
    ]);

    const statsById = Object.fromEntries(stats.map((s) => [s.boy_id, s]));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        students: profiles.map((p) => {
          const s = statsById[p.id];
          return {
            id: p.id,
            username: p.username,
            displayName: p.display_name,
            active: p.active,
            createdAt: p.created_at,
            sessionCount: s ? s.session_count : 0,
            totalWords: s ? s.total_words : 0,
            avgAccuracyPct: s && s.avg_accuracy_pct != null ? Number(s.avg_accuracy_pct) : null,
            avgWpm: s && s.avg_wpm != null ? Number(s.avg_wpm) : null,
          };
        }),
      }),
    };
  } catch (err) {
    const statusCode = err.statusCode || 500;
    return { statusCode, body: JSON.stringify({ error: err.message || "Something went wrong." }) };
  }
};
