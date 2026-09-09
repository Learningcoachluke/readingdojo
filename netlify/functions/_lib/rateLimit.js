// Daily per-boy, per-endpoint call cap so an open-ended topic field can't be
// used to run up an unbounded AI bill. Returns a logUsage() closure so a
// failed AI call never counts against the boy's quota.

const { select, insertOne } = require("./supabaseRest");

const DEFAULT_DAILY_LIMIT = 15;

async function checkAndLog(boyId, endpoint) {
  const limit = Number(process.env.DAILY_AI_CALL_LIMIT) || DEFAULT_DAILY_LIMIT;
  const startOfDayUtc = new Date();
  startOfDayUtc.setUTCHours(0, 0, 0, 0);

  const rows = await select(
    "ai_usage_log",
    `boy_id=eq.${boyId}&endpoint=eq.${endpoint}&created_at=gte.${startOfDayUtc.toISOString()}&select=id`
  );

  if (rows.length >= limit) {
    const err = new Error("Daily practice limit reached for today — come back tomorrow!");
    err.statusCode = 429;
    throw err;
  }

  return async function logUsage() {
    await insertOne("ai_usage_log", { boy_id: boyId, endpoint });
  };
}

module.exports = { checkAndLog };
