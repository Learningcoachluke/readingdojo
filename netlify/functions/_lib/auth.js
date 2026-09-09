// Resolves the logged-in boy's id from the Authorization: Bearer <jwt> header
// a page sends, by asking Supabase's Auth API to validate the token. The
// service-role key doubles as a valid `apikey` header value here, so no
// separate anon-key env var is needed server-side.

const { SUPABASE_URL, SERVICE_ROLE_KEY } = require("./supabaseRest");

async function getBoyId(event) {
  const header = event.headers.authorization || event.headers.Authorization;
  if (!header || !header.startsWith("Bearer ")) {
    const err = new Error("Missing or invalid Authorization header.");
    err.statusCode = 401;
    throw err;
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    const err = new Error("Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    err.statusCode = 500;
    throw err;
  }
  const token = header.slice(7);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SERVICE_ROLE_KEY },
  });
  if (!res.ok) {
    const err = new Error("Your session has expired — please log in again.");
    err.statusCode = 401;
    throw err;
  }
  const user = await res.json();
  return user.id;
}

module.exports = { getBoyId };
