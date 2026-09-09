# Reading Dojo

Boys log in to their own account, get an AI-generated reading passage on a topic they pick, read it aloud (recorded, transcribed, never stored as audio), get accuracy/WPM stats, then answer AI-graded comprehension questions.

## Stack
- **Frontend:** plain HTML/CSS/JS, no build step. `supabase-js` loads from a pinned CDN build.
- **Backend:** Netlify Functions (Node, no npm dependencies — plain `fetch`).
- **Database/Auth:** Supabase (Postgres + Row Level Security). Project: `reading-dojo` (`cyswopxbjflcdwfzegjr`, region `ap-southeast-2`).
- **AI:** Anthropic Claude (passage generation, comprehension grading), OpenAI (`gpt-4o-transcribe` for read-aloud transcription, Moderation API for safety checks).

## One-time Supabase dashboard setup
Do this once in the [Supabase dashboard](https://supabase.com/dashboard/project/cyswopxbjflcdwfzegjr) — not exposed via the MCP tools used to build this:
1. **Authentication → Providers → Email** → turn **off** "Allow new users to sign up" (accounts are admin-provisioned only).
2. Same page → turn **off** "Confirm email" (boys log in with a synthetic `@reading.blackbelt` address that can't receive real mail).

## Environment variables (set in Netlify → Site configuration → Environment variables)
| Variable | Used by | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | create-passage, grade-comprehension | Claude Messages API |
| `OPENAI_API_KEY` | transcribe-and-score, moderation | Transcription + Moderation |
| `SUPABASE_URL` | all functions | `https://cyswopxbjflcdwfzegjr.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | all functions | From Supabase dashboard → Project Settings → API → service_role/secret key. **Never commit this.** |
| `DAILY_AI_CALL_LIMIT` | rate limiting | Optional, defaults to 15/boy/day/endpoint |

The frontend's Supabase URL/anon key are hardcoded in `shared/supabase-client.js` — safe to be public, since access is controlled by Row Level Security, not secrecy.

## Provisioning boy accounts
1. Fill in `admin/boys-roster.csv` (`username,display_name`, one boy per row).
2. Run: `SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node admin/create-boys.js`
3. Hand out the logins from the generated `admin/boys-credentials-output.csv` (gitignored — never commit it). Login is `username` + the 6-digit PIN.

## Closing an account
Supabase dashboard → Authentication → Users → ban or delete the boy's row. No custom admin UI — this is a rare, low-volume action for ~40 accounts.

## Local development
```
netlify dev
```
Run via git-bash or cmd, not PowerShell, if `npm`/`netlify` CLI commands are blocked by execution policy on Windows.

## Safety design
- **Hard-block** moderation (topic + generated passage): explicit sexual content, hate speech, graphic violence, self-harm promotion, illegal-drug instructions, hard profanity. Mild violence, competitive/gaming content, and gross-out humor are intentionally allowed through — see `netlify/functions/_lib/moderation.js`.
- **Soft-flag** (never blocks): transcripts and short-answer responses are checked for self-harm/distress/harassment signals and logged to the `flagged_content` table for manual review in the Supabase dashboard — never shown to the boy.
- **Anti-cheat:** every score, transcript, and AI grade is written server-side with the service-role key. Clients can only ever *read* their own rows (Row Level Security) — see `supabase/schema.sql`.
- **No audio retention:** recordings are transcribed in-memory inside `transcribe-and-score.js` and discarded — never written to Storage, Blobs, or disk.
