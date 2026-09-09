// Creates one student account: derives a username from the display name
// (de-duplicating against existing usernames), generates a PIN, creates
// the Supabase Auth user, and inserts the matching profiles row. Mirrors
// admin/create-boys.js's logic, just reachable from the coach dashboard
// instead of a local script.

const { requireAdminId } = require("./_lib/requireAdmin");
const { select, insertOne } = require("./_lib/supabaseRest");
const { createAuthUser, randomPin } = require("./_lib/authAdmin");

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

    const displayName = (body.displayName || "").trim();
    if (!displayName || displayName.length > 60) {
      return { statusCode: 400, body: JSON.stringify({ error: "Name must be 1-60 characters." }) };
    }

    const username = await pickUniqueUsername(displayName);
    const pin = randomPin();
    const email = `${username}@reading.blackbelt`;

    const authUser = await createAuthUser({ email, password: pin, displayName });
    await insertOne("profiles", { id: authUser.id, username, display_name: displayName, is_admin: false });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, pin, displayName }),
    };
  } catch (err) {
    const statusCode = err.statusCode || 500;
    return { statusCode, body: JSON.stringify({ error: err.message || "Something went wrong." }) };
  }
};

async function pickUniqueUsername(displayName) {
  const base =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "student";

  let candidate = base;
  let suffix = 2;
  while (true) {
    const existing = await select("profiles", `username=eq.${encodeURIComponent(candidate)}&select=id&limit=1`);
    if (existing.length === 0) return candidate;
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
}
