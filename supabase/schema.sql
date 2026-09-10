-- Reading Dojo — full schema
-- Run once against a fresh Supabase project (SQL editor, or the apply_migration MCP tool).

-- ── profiles ────────────────────────────────────────────────────────────
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text unique not null,     -- e.g. "jake-t" — used to build the synthetic login email
  display_name text not null,            -- e.g. "Jake"
  active       boolean not null default true,
  is_admin     boolean not null default false,  -- true only for the coach account
  created_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
-- No insert/update/delete policy → clients can never write here.
-- The service-role key bypasses RLS, so admin/create-boys.js can insert.

-- ── reading_sessions ────────────────────────────────────────────────────
create table public.reading_sessions (
  id                        uuid primary key default gen_random_uuid(),
  boy_id                    uuid not null references public.profiles(id) on delete cascade,
  topic                     text not null,
  year_level                int not null check (year_level between 2 and 10),
  passage_title             text,
  passage_text              text,
  word_count                int,
  status                    text not null default 'generated'
                              check (status in ('generated','reading_submitted','completed','failed')),
  transcript                text,
  accuracy_pct              numeric(5,2),
  wpm                       numeric(6,2),
  reading_duration_seconds  numeric(8,2),
  created_at                timestamptz not null default now(),
  completed_at              timestamptz
);
alter table public.reading_sessions enable row level security;
create policy "reading_sessions_select_own" on public.reading_sessions
  for select using (auth.uid() = boy_id);
-- No client insert/update/delete policy → all writes (topic/passage/transcript/
-- accuracy/wpm/status) happen only via the service-role key inside Netlify functions.
-- This is the core anti-cheat control: a boy can never write his own score.
create index reading_sessions_boy_created_idx on public.reading_sessions (boy_id, created_at desc);

-- ── comprehension_questions ─────────────────────────────────────────────
create table public.comprehension_questions (
  id                    uuid primary key default gen_random_uuid(),
  session_id            uuid not null references public.reading_sessions(id) on delete cascade,
  question_index        int not null,
  question_type         text not null check (question_type in ('multiple_choice','short_answer')),
  question_text         text not null,
  options               jsonb,           -- multiple_choice only, e.g. ["A","B","C","D"]
  correct_option_index  int,             -- multiple_choice only
  model_answer          text,            -- short_answer only — reference answer for AI grading
  explanation           text
);
alter table public.comprehension_questions enable row level security;
create policy "questions_select_own" on public.comprehension_questions
  for select using (
    exists (select 1 from public.reading_sessions rs
            where rs.id = session_id and rs.boy_id = auth.uid())
  );
-- No client insert/update/delete. correct_option_index/model_answer are never
-- sent to the browser by create-passage.js — only question text + options.
create index comprehension_questions_session_idx on public.comprehension_questions (session_id);

-- ── comprehension_responses ─────────────────────────────────────────────
create table public.comprehension_responses (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.reading_sessions(id) on delete cascade,
  question_id  uuid not null references public.comprehension_questions(id) on delete cascade,
  boy_answer   text,             -- MC: stringified option index. Short-answer: free text.
  is_correct   boolean,
  ai_feedback  text,             -- short-answer AI grading feedback (also used for MC explanation echo)
  graded_at    timestamptz not null default now()
);
alter table public.comprehension_responses enable row level security;
create policy "responses_select_own" on public.comprehension_responses
  for select using (
    exists (select 1 from public.reading_sessions rs
            where rs.id = session_id and rs.boy_id = auth.uid())
  );
-- No client insert/update/delete — grade-comprehension.js writes these via service role,
-- computing is_correct server-side. This is the control that stops fake quiz scores.
create index comprehension_responses_session_idx on public.comprehension_responses (session_id);

-- ── flagged_content (soft-flag review queue, service-role only) ────────
create table public.flagged_content (
  id              uuid primary key default gen_random_uuid(),
  boy_id          uuid references public.profiles(id) on delete set null,
  session_id      uuid references public.reading_sessions(id) on delete set null,
  source          text not null check (source in ('transcript','short_answer_response')),
  content_snippet text not null,
  category        text not null,      -- e.g. 'self-harm', 'harassment'
  reviewed        boolean not null default false,
  created_at      timestamptz not null default now()
);
alter table public.flagged_content enable row level security;
-- Deliberately zero policies. RLS-enabled + no policies = deny-all to anon/authenticated.
-- Only the service-role key (which bypasses RLS) can read/write. Luke reviews via the
-- Supabase Table Editor directly — no client page ever touches this table.

-- ── ai_usage_log (rate limiting, service-role only) ─────────────────────
create table public.ai_usage_log (
  id         bigint generated always as identity primary key,
  boy_id     uuid not null references public.profiles(id) on delete cascade,
  endpoint   text not null,   -- 'create-passage' | 'transcribe-and-score' | 'grade-comprehension'
  created_at timestamptz not null default now()
);
alter table public.ai_usage_log enable row level security;
-- No policies → deny-all to clients; functions read/write via service role only.
create index ai_usage_log_boy_endpoint_idx on public.ai_usage_log (boy_id, endpoint, created_at);

-- ── aggregate stats view (RLS-respecting) ───────────────────────────────
-- Overall (all-time) stats per boy, and the same breakdown split by year
-- level. avg_correct_wpm is "correct words per minute" (wpm adjusted for
-- accuracy) — a standard reading-fluency metric distinct from raw wpm.
create view public.my_reading_stats
  with (security_invoker = true) as
  with session_stats as (
    select
      boy_id,
      count(*) filter (where status = 'completed')                                          as session_count,
      coalesce(sum(word_count) filter (where status = 'completed'), 0)                       as total_words,
      round(avg(accuracy_pct) filter (where status = 'completed'), 1)                        as avg_accuracy_pct,
      round(avg(wpm) filter (where status = 'completed'), 1)                                 as avg_wpm,
      round(avg(wpm * accuracy_pct / 100.0) filter (where status = 'completed'), 1)          as avg_correct_wpm,
      coalesce(sum(reading_duration_seconds) filter (where status = 'completed'), 0)         as total_reading_seconds
    from public.reading_sessions
    group by boy_id
  ),
  question_stats as (
    select
      rs.boy_id,
      count(*)                             as questions_answered,
      count(*) filter (where cr.is_correct) as questions_correct
    from public.comprehension_responses cr
    join public.reading_sessions rs on rs.id = cr.session_id
    group by rs.boy_id
  )
  select
    s.boy_id,
    s.session_count,
    s.total_words,
    s.avg_accuracy_pct,
    s.avg_wpm,
    s.avg_correct_wpm,
    s.total_reading_seconds,
    coalesce(q.questions_answered, 0)                                        as questions_answered,
    coalesce(q.questions_correct, 0)                                         as questions_correct,
    coalesce(q.questions_answered, 0) - coalesce(q.questions_correct, 0)     as questions_incorrect
  from session_stats s
  left join question_stats q on q.boy_id = s.boy_id;

create view public.my_reading_stats_by_year
  with (security_invoker = true) as
  with session_stats as (
    select
      boy_id,
      year_level,
      count(*) filter (where status = 'completed')                                          as session_count,
      coalesce(sum(word_count) filter (where status = 'completed'), 0)                       as total_words,
      round(avg(accuracy_pct) filter (where status = 'completed'), 1)                        as avg_accuracy_pct,
      round(avg(wpm) filter (where status = 'completed'), 1)                                 as avg_wpm,
      round(avg(wpm * accuracy_pct / 100.0) filter (where status = 'completed'), 1)          as avg_correct_wpm,
      coalesce(sum(reading_duration_seconds) filter (where status = 'completed'), 0)         as total_reading_seconds
    from public.reading_sessions
    group by boy_id, year_level
  ),
  question_stats as (
    select
      rs.boy_id,
      rs.year_level,
      count(*)                              as questions_answered,
      count(*) filter (where cr.is_correct) as questions_correct
    from public.comprehension_responses cr
    join public.reading_sessions rs on rs.id = cr.session_id
    group by rs.boy_id, rs.year_level
  )
  select
    s.boy_id,
    s.year_level,
    s.session_count,
    s.total_words,
    s.avg_accuracy_pct,
    s.avg_wpm,
    s.avg_correct_wpm,
    s.total_reading_seconds,
    coalesce(q.questions_answered, 0)                                        as questions_answered,
    coalesce(q.questions_correct, 0)                                         as questions_correct,
    coalesce(q.questions_answered, 0) - coalesce(q.questions_correct, 0)     as questions_incorrect
  from session_stats s
  left join question_stats q on q.boy_id = s.boy_id and q.year_level = s.year_level
  where s.session_count > 0
  order by s.year_level;
