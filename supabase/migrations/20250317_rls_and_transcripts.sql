-- Migration: add ownership model, consolidate transcripts, and enable RLS.
-- Run after purging legacy data, or ensure you have backups before executing.

begin;

  -- 1) Ownership column on sessions
  alter table public.sessions
    add column if not exists owner_id uuid references auth.users(id);

  -- If migrating existing rows, set owner_id here before enforcing NOT NULL.
  -- update public.sessions set owner_id = '<teacher-uuid>' where owner_id is null;

  alter table public.sessions
    alter column owner_id set not null;

  create index if not exists sessions_owner_idx on public.sessions(owner_id);

  -- 2) Rebuild transcripts table to store consolidated JSON payloads
  drop table if exists public.transcripts cascade;

  create table public.transcripts (
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

  -- 3) Ensure dependent tables exist (no-op if already in schema.sql)
  -- (Nothing else to rebuild here, but kept as an anchor section.)

  -- 4) Enable RLS and ownership policies (idempotent thanks to pg_policies checks)
  alter table public.sessions enable row level security;
  alter table public.groups enable row level security;
  alter table public.session_prompts enable row level security;
  alter table public.session_logs enable row level security;
  alter table public.transcripts enable row level security;
  alter table public.summaries enable row level security;
  alter table public.mindmap_sessions enable row level security;
  alter table public.mindmap_archives enable row level security;
  alter table public.checkbox_sessions enable row level security;
  alter table public.checkbox_criteria enable row level security;
  alter table public.checkbox_progress enable row level security;

  -- Policy helper
  do $$
  begin
    if not exists (
      select 1 from pg_policies where schemaname='public' and tablename='sessions' and policyname='sessions_select_owner'
    ) then
      create policy "sessions_select_owner"
        on public.sessions
        for select
        using (owner_id = auth.uid());
    end if;

    if not exists (
      select 1 from pg_policies where schemaname='public' and tablename='sessions' and policyname='sessions_insert_owner'
    ) then
      create policy "sessions_insert_owner"
        on public.sessions
        for insert
        with check (owner_id = auth.uid());
    end if;

    if not exists (
      select 1 from pg_policies where schemaname='public' and tablename='sessions' and policyname='sessions_update_owner'
    ) then
      create policy "sessions_update_owner"
        on public.sessions
        for update
        using (owner_id = auth.uid())
        with check (owner_id = auth.uid());
    end if;

    if not exists (
      select 1 from pg_policies where schemaname='public' and tablename='sessions' and policyname='sessions_delete_owner'
    ) then
      create policy "sessions_delete_owner"
        on public.sessions
        for delete
        using (owner_id = auth.uid());
    end if;
  end $$;

  -- Re-use same helper logic for child tables.
  -- groups
  do $$
  begin
    if not exists (
      select 1 from pg_policies where schemaname='public' and tablename='groups' and policyname='groups_select_owner'
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
      select 1 from pg_policies where schemaname='public' and tablename='groups' and policyname='groups_modify_owner'
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

  -- session_prompts
  do $$
  begin
    if not exists (
      select 1 from pg_policies where schemaname='public' and tablename='session_prompts' and policyname='session_prompts_owner'
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

  -- session_logs
  do $$
  begin
    if not exists (
      select 1 from pg_policies where schemaname='public' and tablename='session_logs' and policyname='session_logs_owner'
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

  -- transcripts
  do $$
  begin
    if not exists (
      select 1 from pg_policies where schemaname='public' and tablename='transcripts' and policyname='transcripts_owner'
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

  -- summaries
  do $$
  begin
    if not exists (
      select 1 from pg_policies where schemaname='public' and tablename='summaries' and policyname='summaries_owner'
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

  -- mindmap_sessions
  do $$
  begin
    if not exists (
      select 1 from pg_policies where schemaname='public' and tablename='mindmap_sessions' and policyname='mindmap_sessions_owner'
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

  -- mindmap_archives
  do $$
  begin
    if not exists (
      select 1 from pg_policies where schemaname='public' and tablename='mindmap_archives' and policyname='mindmap_archives_owner'
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

  -- checkbox_sessions
  do $$
  begin
    if not exists (
      select 1 from pg_policies where schemaname='public' and tablename='checkbox_sessions' and policyname='checkbox_sessions_owner'
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

  -- checkbox_criteria
  do $$
  begin
    if not exists (
      select 1 from pg_policies where schemaname='public' and tablename='checkbox_criteria' and policyname='checkbox_criteria_owner'
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

  -- checkbox_progress
  do $$
  begin
    if not exists (
      select 1 from pg_policies where schemaname='public' and tablename='checkbox_progress' and policyname='checkbox_progress_owner'
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

commit;
