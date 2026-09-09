// Thin fetch() wrapper around Supabase's REST (PostgREST) API using the
// service-role key. Deliberately no @supabase/supabase-js dependency here —
// this repo has never had a package.json for its functions, and plain REST
// calls are all this app's simple CRUD needs.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function requireEnv() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    const err = new Error(
      "Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Add them in Netlify → Site configuration → Environment variables."
    );
    err.statusCode = 500;
    throw err;
  }
}

async function supabaseFetch(path, options = {}) {
  requireEnv();
  const headers = Object.assign(
    {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    options.headers
  );
  const res = await fetch(`${SUPABASE_URL}${path}`, Object.assign({}, options, { headers }));
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Supabase request failed (${res.status}): ${text.slice(0, 300)}`);
    err.statusCode = 502;
    throw err;
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function insertOne(table, row) {
  const inserted = await supabaseFetch(`/rest/v1/${table}`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  return inserted[0];
}

async function insertMany(table, rows) {
  return supabaseFetch(`/rest/v1/${table}`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(rows),
  });
}

async function select(table, filterQuery) {
  return supabaseFetch(`/rest/v1/${table}?${filterQuery}`, { method: "GET" });
}

async function selectOne(table, filterQuery) {
  const rows = await select(table, `${filterQuery}&limit=1`);
  return rows[0] || null;
}

async function updateOne(table, filterQuery, patch) {
  return supabaseFetch(`/rest/v1/${table}?${filterQuery}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
}

module.exports = { supabaseFetch, insertOne, insertMany, select, selectOne, updateOne, SUPABASE_URL, SERVICE_ROLE_KEY };
