-- Run this once in the Supabase SQL editor.

create table if not exists public.gap_study_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.gap_study_sessions enable row level security;

create policy "Users can read their own Gap Study progress"
on public.gap_study_sessions
for select
to authenticated
using (auth.uid() = user_id);

create policy "Users can create their own Gap Study progress"
on public.gap_study_sessions
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "Users can update their own Gap Study progress"
on public.gap_study_sessions
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "Users can delete their own Gap Study progress"
on public.gap_study_sessions
for delete
to authenticated
using (auth.uid() = user_id);
