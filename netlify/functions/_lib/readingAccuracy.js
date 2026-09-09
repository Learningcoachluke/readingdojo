// Ported from reading-dojo_1.html's computeAccuracy()/normalizeWords() —
// an LCS (longest-common-subsequence) word diff. Originally scored Web
// Speech API output client-side; here it runs server-side against the
// OpenAI transcript instead, which is why it lives in a Netlify function.

function normalizeWords(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function computeAccuracy(passageText, transcriptText) {
  const p = normalizeWords(passageText);
  const t = normalizeWords(transcriptText);
  if (p.length === 0 || t.length === 0) return 0;

  const m = p.length;
  const n = t.length;
  const dp = new Array(m + 1);
  for (let i = 0; i <= m; i++) dp[i] = new Uint16Array(n + 1);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (p[i - 1] === t[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return Math.round((dp[m][n] / m) * 100);
}

// Actual words the boy said ÷ actual reading time — not the passage's
// target word count, since we now have a real transcript to count.
function computeWpm(transcriptText, durationSeconds) {
  const words = normalizeWords(transcriptText);
  const minutes = Math.max(durationSeconds / 60, 1 / 60);
  return Math.round(words.length / minutes);
}

module.exports = { normalizeWords, computeAccuracy, computeWpm };
