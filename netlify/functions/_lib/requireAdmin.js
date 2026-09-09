// Verifies the caller is the coach account (profiles.is_admin = true)
// before an admin function does anything. Every admin function must call
// this first — none of them are safe to expose to a regular boy account.

const { getBoyId } = require("./auth");
const { selectOne } = require("./supabaseRest");

async function requireAdminId(event) {
  const userId = await getBoyId(event);
  const profile = await selectOne("profiles", `id=eq.${userId}&select=is_admin`);
  if (!profile || !profile.is_admin) {
    const err = new Error("Admin access required.");
    err.statusCode = 403;
    throw err;
  }
  return userId;
}

module.exports = { requireAdminId };
