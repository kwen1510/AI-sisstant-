-- AI(ttention) — User login tracking schema
-- Run this in the Supabase SQL Editor or psql.

-- 1) Extensions (uuid generation)
create extension if not exists pgcrypto;

-- 2) Raw login events table
create table if not exists public.user_logins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  logged_at timestamptz not null default now(),
  user_agent text
);

-- Helpful indexes
create index if not exists idx_user_logins_user_id on public.user_logins(user_id);
create index if not exists idx_user_logins_logged_at on public.user_logins(logged_at desc);

-- Row Level Security
alter table public.user_logins enable row level security;

-- Drop and recreate policy for compatibility (IF NOT EXISTS not supported)
drop policy if exists user_logins_insert_own on public.user_logins;
create policy user_logins_insert_own
  on public.user_logins for insert
  with check (auth.uid() = user_id);

-- Users may view their own events
drop policy if exists user_logins_select_own on public.user_logins;
create policy user_logins_select_own
  on public.user_logins for select
  using (auth.uid() = user_id);

-- 3) Aggregated stats per user
create table if not exists public.user_login_stats (
  user_id uuid primary key references auth.users(id) on delete cascade,
  login_count bigint not null default 0,
  last_login_at timestamptz
);

alter table public.user_login_stats enable row level security;

-- Users may view their own stats
drop policy if exists user_login_stats_select_own on public.user_login_stats;
create policy user_login_stats_select_own
  on public.user_login_stats for select
  using (auth.uid() = user_id);

-- 4) Trigger to keep stats table up to date
create or replace function public.tg_logins_aggregate()
returns trigger
language plpgsql
security definer as $$
begin
  insert into public.user_login_stats as s (user_id, login_count, last_login_at)
  values (new.user_id, 1, new.logged_at)
  on conflict (user_id)
  do update set
    login_count = s.login_count + 1,
    last_login_at = excluded.last_login_at;
  return new;
end;
$$;

drop trigger if exists trg_user_logins_aggregate on public.user_logins;
create trigger trg_user_logins_aggregate
after insert on public.user_logins
for each row execute function public.tg_logins_aggregate();

-- 5) Example admin queries (run in SQL editor as a service role; not from client)
-- -- Totals by email
-- select email, count(*) as times, max(logged_at) as last_login
-- from public.user_logins
-- group by email
-- order by times desc;

-- -- Per-user last login and count
-- select u.email, s.login_count, s.last_login_at
-- from public.user_login_stats s
-- join auth.users u on u.id = s.user_id
-- order by s.last_login_at desc nulls last;
