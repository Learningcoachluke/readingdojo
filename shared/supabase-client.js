// Supabase client + small helpers, shared by every page via a plain
// <script src="shared/supabase-client.js"> tag (supabase-js itself loads
// from a pinned CDN UMD build — no npm/build step anywhere in this app).
//
// SUPABASE_URL/SUPABASE_ANON_KEY are safe to be public literals here: access
// is controlled by Row Level Security, not by keeping these secret.

const SUPABASE_URL = "https://cyswopxbjflcdwfzegjr.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5c3dvcHhiamZsY2R3ZnplZ2pyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5NTA5NTQsImV4cCI6MjEwNDUyNjk1NH0.tPsLYjNVxIGmMBnNQBzgcXcRI0ti6UqOXdgI0O-t03k";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function requireAuth() {
  const {
    data: { session },
  } = await sb.auth.getSession();
  if (!session) {
    window.location.href = "/index.html";
    return null;
  }
  return session;
}

async function logout() {
  await sb.auth.signOut();
  window.location.href = "/index.html";
}

// Calls one of our Netlify functions with the boy's access token attached,
// and normalizes error handling (including the moderation "blocked" flag).
async function authedFetch(path, options = {}) {
  const {
    data: { session },
  } = await sb.auth.getSession();
  if (!session) {
    window.location.href = "/index.html";
    throw new Error("Not logged in");
  }
  const headers = Object.assign({}, options.headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer " + session.access_token,
  });
  const res = await fetch(path, Object.assign({}, options, { headers }));
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    /* no JSON body */
  }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `Request failed (${res.status})`);
    err.statusCode = res.status;
    err.blocked = !!(data && data.blocked);
    throw err;
  }
  return data;
}

// Same as authedFetch, but for endpoints that return binary audio instead
// of JSON (e.g. speak-word) — resolves to a Blob on success.
async function authedFetchBlob(path, options = {}) {
  const {
    data: { session },
  } = await sb.auth.getSession();
  if (!session) {
    window.location.href = "/index.html";
    throw new Error("Not logged in");
  }
  const headers = Object.assign({}, options.headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer " + session.access_token,
  });
  const res = await fetch(path, Object.assign({}, options, { headers }));
  if (!res.ok) {
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      /* no JSON body */
    }
    const err = new Error((data && (data.message || data.error)) || `Request failed (${res.status})`);
    err.statusCode = res.status;
    throw err;
  }
  return res.blob();
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
