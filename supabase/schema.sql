-- Supabase migration schema for Smart Classroom application
-- Run inside Supabase SQL editor or any Postgres-compatible client.

create extension if not exists "pgcrypto";

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  code text not null unique,
  mode text not null default 'summary',
  strictness integer not null default 2,
  interval_ms integer not null default 30000,
  active boolean not null default false,
  main_topic text,
  mindmap_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  start_time timestamptz,
  end_time timestamptz,
  ended_at timestamptz,
  total_duration_seconds integer,
  final_node_count integer,
  final_duration_seconds integer,
  archived boolean not null default false,
  last_updated timestamptz
);
create index if not exists sessions_owner_idx on public.sessions(owner_id);
create index if not exists sessions_mode_idx on public.sessions(mode);
create index if not exists sessions_active_idx on public.sessions(active);
create index if not exists sessions_created_idx on public.sessions(created_at desc);

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  number integer not null,
  display_name text,
  created_at timestamptz not null default now(),
  unique (session_id, number)
);
create index if not exists groups_session_idx on public.groups(session_id, number);

create table if not exists public.session_prompts (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  prompt text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.session_logs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  type text not null,
  content text,
  ai_response jsonb,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index if not exists session_logs_session_idx on public.session_logs(session_id, created_at);
create index if not exists session_logs_type_idx on public.session_logs(type);

create table if not exists public.transcripts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  payload jsonb not null default jsonb_build_object(
    'segments', '[]'::jsonb,
    'stats', jsonb_build_object(
      'total_segments', 0,
      'total_words', 0,
      'total_duration', 0
    )
  ),
  segment_cursor integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, group_id)
);
create index if not exists transcripts_session_group_idx on public.transcripts(session_id, group_id);
create index if not exists transcripts_updated_idx on public.transcripts(updated_at desc);

create table if not exists public.summaries (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create unique index if not exists summaries_group_unique on public.summaries(group_id);

create table if not exists public.mindmap_sessions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references public.sessions(id) on delete cascade,
  main_topic text not null,
  current_mindmap jsonb,
  chat_history jsonb not null default '[]'::jsonb,
  final_metadata jsonb,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists public.mindmap_archives (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  session_code text not null,
  main_topic text not null,
  start_time timestamptz,
  end_time timestamptz,
  duration_seconds integer,
  duration_formatted text,
  node_count integer,
  speech_inputs integer,
  mindmap_data jsonb not null,
  chat_history jsonb not null default '[]'::jsonb,
  version text,
  saved_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists mindmap_archives_session_idx on public.mindmap_archives(session_id, saved_at desc);
create index if not exists mindmap_archives_code_idx on public.mindmap_archives(session_code);

create table if not exists public.checkbox_sessions (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  scenario text,
  released_groups jsonb not null default '{}'::jsonb,
  release_timestamps jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.checkbox_criteria (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  description text not null,
  rubric text,
  weight numeric(6,2) not null default 1,
  order_index integer not null,
  created_at timestamptz not null default now()
);
create index if not exists checkbox_criteria_session_idx on public.checkbox_criteria(session_id, order_index);

create table if not exists public.checkbox_progress (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  criteria_id uuid not null references public.checkbox_criteria(id) on delete cascade,
  group_number integer not null,
  status text not null default 'grey',
  completed boolean not null default false,
  quote text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create unique index if not exists checkbox_progress_unique on public.checkbox_progress(session_id, criteria_id, group_number);
create index if not exists checkbox_progress_session_idx on public.checkbox_progress(session_id, group_number);

create table if not exists public.prompt_library (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.teacher_prompts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  content text not null,
  category text,
  mode text not null default 'summary',
  tags text[] not null default '{}',
  is_public boolean not null default true,
  author_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  views integer not null default 0,
  last_viewed timestamptz,
  usage_count integer not null default 0,
  last_used timestamptz
);
create index if not exists teacher_prompts_category_idx on public.teacher_prompts(category);
create index if not exists teacher_prompts_mode_idx on public.teacher_prompts(mode);
create index if not exists teacher_prompts_public_idx on public.teacher_prompts(is_public);
create index if not exists teacher_prompts_created_idx on public.teacher_prompts(created_at desc);
create index if not exists teacher_prompts_usage_idx on public.teacher_prompts(usage_count desc);
create index if not exists teacher_prompts_tags_idx on public.teacher_prompts using gin(tags);

create table if not exists public.mindmap_nodes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  node_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists mindmap_nodes_session_idx on public.mindmap_nodes(session_id, created_at);

create table if not exists public.checkbox_results (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  group_number integer not null,
  results jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists checkbox_results_session_idx on public.checkbox_results(session_id, created_at);

/* ---------- Row Level Security ---------- */

alter table public.sessions enable row level security;
alter table public.groups enable row level security;
alter table public.session_prompts enable row level security;
alter table public.session_logs enable row level security;
alter table public.transcripts enable row level security;
alter table public.summaries enable row level security;
alter table public.mindmap_sessions enable row level security;
alter table public.mindmap_archives enable row level security;
alter table public.mindmap_nodes enable row level security;
alter table public.checkbox_sessions enable row level security;
alter table public.checkbox_criteria enable row level security;
alter table public.checkbox_progress enable row level security;
alter table public.checkbox_results enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies 
    where schemaname = 'public' and tablename = 'sessions' and policyname = 'sessions_select_owner'
  ) then
    create policy "sessions_select_owner"
      on public.sessions
      for select
      using (owner_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies 
    where schemaname = 'public' and tablename = 'sessions' and policyname = 'sessions_insert_owner'
  ) then
    create policy "sessions_insert_owner"
      on public.sessions
      for insert
      with check (owner_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies 
    where schemaname = 'public' and tablename = 'sessions' and policyname = 'sessions_update_owner'
  ) then
    create policy "sessions_update_owner"
      on public.sessions
      for update
      using (owner_id = auth.uid())
      with check (owner_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies 
    where schemaname = 'public' and tablename = 'sessions' and policyname = 'sessions_delete_owner'
  ) then
    create policy "sessions_delete_owner"
      on public.sessions
      for delete
      using (owner_id = auth.uid());
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'groups' and policyname = 'groups_select_owner'
  ) then
    create policy "groups_select_owner"
      on public.groups
      for select
      using (
        exists (
          select 1 from public.sessions s
          where s.id = groups.session_id
            and s.owner_id = auth.uid()
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'groups' and policyname = 'groups_modify_owner'
  ) then
    create policy "groups_modify_owner"
      on public.groups
      for all
      using (
        exists (
          select 1 from public.sessions s
          where s.id = groups.session_id
            and s.owner_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.sessions s
          where s.id = groups.session_id
            and s.owner_id = auth.uid()
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'session_prompts' and policyname = 'session_prompts_owner'
  ) then
    create policy "session_prompts_owner"
      on public.session_prompts
      for all
      using (
        exists (
          select 1 from public.sessions s
          where s.id = session_prompts.session_id
            and s.owner_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.sessions s
          where s.id = session_prompts.session_id
            and s.owner_id = auth.uid()
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'session_logs' and policyname = 'session_logs_owner'
  ) then
    create policy "session_logs_owner"
      on public.session_logs
      for all
      using (
        exists (
          select 1 from public.sessions s
          where s.id = session_logs.session_id
            and s.owner_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.sessions s
          where s.id = session_logs.session_id
            and s.owner_id = auth.uid()
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'transcripts' and policyname = 'transcripts_owner'
  ) then
    create policy "transcripts_owner"
      on public.transcripts
      for all
      using (
        exists (
          select 1 from public.sessions s
          where s.id = transcripts.session_id
            and s.owner_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.sessions s
          where s.id = transcripts.session_id
            and s.owner_id = auth.uid()
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'summaries' and policyname = 'summaries_owner'
  ) then
    create policy "summaries_owner"
      on public.summaries
      for all
      using (
        exists (
          select 1 from public.sessions s
          where s.id = summaries.session_id
            and s.owner_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.sessions s
          where s.id = summaries.session_id
            and s.owner_id = auth.uid()
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'mindmap_sessions' and policyname = 'mindmap_sessions_owner'
  ) then
    create policy "mindmap_sessions_owner"
      on public.mindmap_sessions
      for all
      using (
        exists (
          select 1 from public.sessions s
          where s.id = mindmap_sessions.session_id
            and s.owner_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.sessions s
          where s.id = mindmap_sessions.session_id
            and s.owner_id = auth.uid()
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'mindmap_archives' and policyname = 'mindmap_archives_owner'
  ) then
    create policy "mindmap_archives_owner"
      on public.mindmap_archives
      for all
      using (
        exists (
          select 1 from public.sessions s
          where s.id = mindmap_archives.session_id
            and s.owner_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.sessions s
          where s.id = mindmap_archives.session_id
            and s.owner_id = auth.uid()
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'mindmap_nodes' and policyname = 'mindmap_nodes_owner'
  ) then
    create policy "mindmap_nodes_owner"
      on public.mindmap_nodes
      for all
      using (
        exists (
          select 1 from public.sessions s
          where s.id = mindmap_nodes.session_id
            and s.owner_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.sessions s
          where s.id = mindmap_nodes.session_id
            and s.owner_id = auth.uid()
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'checkbox_sessions' and policyname = 'checkbox_sessions_owner'
  ) then
    create policy "checkbox_sessions_owner"
      on public.checkbox_sessions
      for all
      using (
        exists (
          select 1 from public.sessions s
          where s.id = checkbox_sessions.session_id
            and s.owner_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.sessions s
          where s.id = checkbox_sessions.session_id
            and s.owner_id = auth.uid()
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'checkbox_criteria' and policyname = 'checkbox_criteria_owner'
  ) then
    create policy "checkbox_criteria_owner"
      on public.checkbox_criteria
      for all
      using (
        exists (
          select 1 from public.sessions s
          where s.id = checkbox_criteria.session_id
            and s.owner_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.sessions s
          where s.id = checkbox_criteria.session_id
            and s.owner_id = auth.uid()
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'checkbox_progress' and policyname = 'checkbox_progress_owner'
  ) then
    create policy "checkbox_progress_owner"
      on public.checkbox_progress
      for all
      using (
        exists (
          select 1 from public.sessions s
          where s.id = checkbox_progress.session_id
            and s.owner_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.sessions s
          where s.id = checkbox_progress.session_id
            and s.owner_id = auth.uid()
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'checkbox_results' and policyname = 'checkbox_results_owner'
  ) then
    create policy "checkbox_results_owner"
      on public.checkbox_results
      for all
      using (
        exists (
          select 1 from public.sessions s
          where s.id = checkbox_results.session_id
            and s.owner_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1 from public.sessions s
          where s.id = checkbox_results.session_id
            and s.owner_id = auth.uid()
        )
      );
  end if;
end $$;
