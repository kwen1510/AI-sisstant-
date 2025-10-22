-- Danger zone: removes all classroom data. Execute inside Supabase SQL editor when you
-- need a clean slate. This keeps the schema intact but wipes every row.

begin;

  truncate table
    public.checkbox_results,
    public.checkbox_progress,
    public.checkbox_criteria,
    public.checkbox_sessions,
    public.mindmap_nodes,
    public.mindmap_archives,
    public.mindmap_sessions,
    public.session_logs,
    public.session_prompts,
    public.transcripts,
    public.summaries,
    public.groups,
    public.sessions,
    public.prompt_library,
    public.teacher_prompts,
    public.user_login_stats,
    public.user_logins
  restart identity cascade;

commit;
