#!/usr/bin/env node
// One-off bulk account provisioning for the boys. Run locally:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node admin/create-boys.js
//
// Reads admin/boys-roster.csv (username,display_name), creates each boy's
// Supabase Auth user (email = <username>@reading.blackbelt, password = a
// random 6-digit PIN) + a matching profiles row, and writes
// admin/boys-credentials-output.csv (gitignored) with the generated PINs
// for you to hand out. No npm dependencies — plain global fetch.

const fs = require("fs");
const path = require("path");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this script.");
  process.exit(1);
}

const rosterPath = path.join(__dirname, "boys-roster.csv");
const outputPath = path.join(__dirname, "boys-credentials-output.csv");

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const [header, ...rows] = lines;
  const cols = header.split(",").map((c) => c.trim());
  return rows.map((line) => {
    const values = line.split(",").map((v) => v.trim());
    const row = {};
    cols.forEach((c, i) => {
      row[c] = values[i];
    });
    return row;
  });
}

function randomPin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function createBoy(username, displayName) {
  const pin = randomPin();
  const email = `${username}@reading.blackbelt`;

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password: pin,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    }),
  });

  if (!userRes.ok) {
    const detail = await userRes.text();
    throw new Error(`Failed to create auth user for ${username}: ${userRes.status} ${detail}`);
  }
  const user = await userRes.json();

  const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ id: user.id, username, display_name: displayName }),
  });

  if (!profileRes.ok) {
    const detail = await profileRes.text();
    throw new Error(`Failed to create profile row for ${username}: ${profileRes.status} ${detail}`);
  }

  return { username, displayName, pin };
}

async function main() {
  if (!fs.existsSync(rosterPath)) {
    console.error(`No roster found at ${rosterPath}. Fill in the template first.`);
    process.exit(1);
  }
  const roster = parseCsv(fs.readFileSync(rosterPath, "utf8"));
  if (roster.length === 0) {
    console.error("boys-roster.csv has no rows.");
    process.exit(1);
  }

  const results = [];
  for (const row of roster) {
    if (!row.username || !row.display_name) {
      console.warn("Skipping row missing username/display_name:", row);
      continue;
    }
    try {
      const created = await createBoy(row.username.toLowerCase(), row.display_name);
      results.push(created);
      console.log(`Created ${created.username} (${created.displayName})`);
    } catch (e) {
      console.error(e.message);
    }
  }

  const csvLines = ["username,display_name,pin", ...results.map((r) => `${r.username},${r.displayName},${r.pin}`)];
  fs.writeFileSync(outputPath, csvLines.join("\n") + "\n", "utf8");
  console.log(
    `\nDone. ${results.length} accounts created. Credentials written to ${outputPath} — hand these out and keep the file out of git.`
  );
}

main();
