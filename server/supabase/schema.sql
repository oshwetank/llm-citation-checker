-- CitoSkeleton server schema (0.82.0). Run once in the Supabase SQL editor.
--
-- Every table has row-level security on and no policy for the public (anon)
-- role, so the only way in is the server's service key. The one exception:
-- a signed-in person may read and update their own profile row.

create table if not exists public.subscribers (
  email           text primary key check (email = lower(email) and position('@' in email) > 1),
  consent         boolean not null default false,
  source          text,
  token           text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unsubscribed_at timestamptz
);
alter table public.subscribers enable row level security;

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 60),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "own profile: read" on public.profiles;
create policy "own profile: read" on public.profiles for select to authenticated using (auth.uid() = id);
drop policy if exists "own profile: update" on public.profiles;
create policy "own profile: update" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

create table if not exists public.shared_campaigns (
  code       text primary key check (code ~ '^[A-HJ-NP-Z2-9]{10}$'),
  owner      uuid not null references auth.users (id) on delete cascade,
  name       text not null,
  bytes      integer not null check (bytes > 0 and bytes <= 26214400),
  counts     jsonb,
  from_name  text,
  ready      boolean not null default false,
  downloads  integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists shared_campaigns_owner on public.shared_campaigns (owner, created_at desc);
alter table public.shared_campaigns enable row level security;

-- The files themselves: a private bucket, reached only through short-lived
-- signed addresses the server hands out.
insert into storage.buckets (id, name, public, file_size_limit)
values ('shares', 'shares', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = 26214400;
