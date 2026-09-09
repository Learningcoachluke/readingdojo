// Thin wrapper around Supabase Auth's admin endpoints (create/update/delete
// a user), used by the coach's admin functions. Same service-role key as
// supabaseRest.js, just a different base path (/auth/v1/admin/... instead
// of /rest/v1/...).

const { SUPABASE_URL, SERVICE_ROLE_KEY } = require("./supabaseRest");

async function authAdminFetch(path, options = {}) {
  const headers = Object.assign(
    {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    options.headers
  );
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, Object.assign({}, options, { headers }));
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Supabase Auth admin request failed (${res.status}): ${text.slice(0, 300)}`);
    err.statusCode = 502;
    throw err;
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function createAuthUser({ email, password, displayName }) {
  return authAdminFetch("/users", {
    method: "POST",
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: displayName } }),
  });
}

function setAuthUserPassword(userId, password) {
  return authAdminFetch(`/users/${userId}`, {
    method: "PUT",
    body: JSON.stringify({ password }),
  });
}

function deleteAuthUser(userId) {
  return authAdminFetch(`/users/${userId}`, { method: "DELETE" });
}

function randomPin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

module.exports = { createAuthUser, setAuthUserPassword, deleteAuthUser, randomPin };
