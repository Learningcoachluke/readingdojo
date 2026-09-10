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

// Shared between stats.html (a boy's own stats) and admin.html (the
// coach's drill-down into a student's stats) — same row shape from
// my_reading_stats / my_reading_stats_by_year either way.
function renderStatBoxes(stats, sessionLabel) {
  if (!stats) {
    return '<div class="hint" style="text-align:center;">No completed sessions yet.</div>';
  }
  return (
    '<div class="stat-grid">' +
    statBox(stats.session_count, sessionLabel) +
    statBox(stats.total_words, 'Words read') +
    statBox(stats.avg_accuracy_pct != null ? stats.avg_accuracy_pct + '%' : '—', 'Avg accuracy') +
    statBox(stats.avg_wpm != null ? stats.avg_wpm : '—', 'Avg words/min') +
    statBox(stats.avg_correct_wpm != null ? stats.avg_correct_wpm : '—', 'Avg correct words/min') +
    statBox(formatDuration(stats.total_reading_seconds), 'Time reading') +
    statBox(stats.questions_correct, 'Questions correct') +
    statBox(stats.questions_incorrect, 'Questions missed') +
    '</div>'
  );
}

// Renders a row of year-level tab buttons plus a single stats area below
// them that swaps content when a different year is picked, into
// containerEl — no scrolling through a stack of separate year cards.
// Shared by stats.html and admin.html's per-student drill-down.
function renderYearTabs(containerEl, byYear) {
  if (!byYear || byYear.length === 0) {
    containerEl.innerHTML = '';
    return;
  }
  containerEl.innerHTML =
    '<div class="year-tab-row">' +
    byYear
      .map(function (row, i) {
        return '<button type="button" class="year-tab-btn' + (i === 0 ? ' selected' : '') + '" data-index="' + i + '">Y' + row.year_level + '</button>';
      })
      .join('') +
    '</div>' +
    '<div class="year-tab-content"></div>';

  var contentEl = containerEl.querySelector('.year-tab-content');
  function showTab(row) {
    contentEl.innerHTML =
      '<h3 style="text-align:center; font-family:var(--display); margin:14px 0 4px;">Year ' + row.year_level + '</h3>' +
      renderStatBoxes(row, 'Texts read');
  }
  containerEl.querySelectorAll('.year-tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      containerEl.querySelectorAll('.year-tab-btn').forEach(function (b) { b.classList.remove('selected'); });
      btn.classList.add('selected');
      showTab(byYear[Number(btn.dataset.index)]);
    });
  });
  showTab(byYear[0]);
}

function statBox(value, label) {
  return '<div class="stat-box"><div class="stat-num">' + value + '</div><div class="stat-label">' + escapeHtml(label) + '</div></div>';
}

function formatDuration(totalSeconds) {
  const s = Math.round(Number(totalSeconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return h + 'h ' + m + 'm ' + sec + 's';
  if (m > 0) return m + 'm ' + sec + 's';
  return sec + 's';
}
