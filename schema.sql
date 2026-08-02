-- ============================================================================
-- Workshop Tool Tracker — Database Schema
-- Run this once in your Supabase project's SQL Editor (Dashboard > SQL Editor)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. WORKSHOPS
-- ---------------------------------------------------------------------------
create table if not exists public.workshops (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  address     text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. PROFILES  (one row per login, extends Supabase's built-in auth.users)
--    role: 'admin'   -> full access, manages workshops/users/tools/transfers
--          'manager' -> can add/edit tools and record transfers
--          'viewer'  -> read-only access
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  full_name         text not null,
  role              text not null default 'viewer' check (role in ('admin','manager','viewer')),
  home_workshop_id  uuid references public.workshops(id) on delete set null,
  active            boolean not null default true,
  created_at        timestamptz not null default now()
);

-- Auto-create a profile row whenever an admin creates a new login in
-- Supabase Auth. New accounts start as an inactive 'viewer' until an
-- admin assigns a real role in the app.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role, active)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    'viewer',
    false
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 3. TOOLS
-- ---------------------------------------------------------------------------
create table if not exists public.tools (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  category            text,
  serial_number       text unique,
  description         text,
  status              text not null default 'available'
                        check (status in ('available','checked_out','in_maintenance','retired')),
  current_workshop_id uuid not null references public.workshops(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. TRANSFERS  (append-only audit log — never updated or deleted)
-- ---------------------------------------------------------------------------
create table if not exists public.transfers (
  id                uuid primary key default gen_random_uuid(),
  tool_id           uuid not null references public.tools(id),
  from_workshop_id  uuid references public.workshops(id),
  to_workshop_id    uuid not null references public.workshops(id),
  transferred_by    uuid not null references public.profiles(id),
  note              text,
  transferred_at    timestamptz not null default now()
);

-- Moving a tool is always done by inserting a transfer row; this trigger
-- keeps tools.current_workshop_id in sync automatically so the two can
-- never drift apart.
create or replace function public.apply_transfer()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.tools
     set current_workshop_id = new.to_workshop_id,
         updated_at = now()
   where id = new.tool_id;
  return new;
end;
$$;

drop trigger if exists on_transfer_created on public.transfers;
create trigger on_transfer_created
  after insert on public.transfers
  for each row execute function public.apply_transfer();

-- ---------------------------------------------------------------------------
-- 5. HELPER: read the caller's own role without triggering recursive RLS
-- ---------------------------------------------------------------------------
create or replace function public.my_role()
returns text
language sql
security definer set search_path = public
stable
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_active()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select coalesce((select active from public.profiles where id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------------
alter table public.workshops enable row level security;
alter table public.profiles  enable row level security;
alter table public.tools     enable row level security;
alter table public.transfers enable row level security;

-- Workshops: any signed-in, active user can view. Only admins manage them.
create policy "workshops_select" on public.workshops
  for select using (auth.uid() is not null and public.is_active());

create policy "workshops_write" on public.workshops
  for all using (public.my_role() = 'admin')
  with check (public.my_role() = 'admin');

-- Profiles: everyone can see names/roles (needed to show "transferred by"),
-- but only admins can change roles, and nobody can self-promote.
create policy "profiles_select" on public.profiles
  for select using (auth.uid() is not null and public.is_active());

create policy "profiles_update_self_name" on public.profiles
  for update using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from public.profiles where id = auth.uid()));

create policy "profiles_admin_write" on public.profiles
  for update using (public.my_role() = 'admin')
  with check (public.my_role() = 'admin');

-- Tools: everyone active can view. Admin + manager can create/edit.
-- Only admin can delete (retiring a tool should normally be a status change).
create policy "tools_select" on public.tools
  for select using (auth.uid() is not null and public.is_active());

create policy "tools_insert" on public.tools
  for insert with check (public.my_role() in ('admin','manager'));

create policy "tools_update" on public.tools
  for update using (public.my_role() in ('admin','manager'))
  with check (public.my_role() in ('admin','manager'));

create policy "tools_delete" on public.tools
  for delete using (public.my_role() = 'admin');

-- Transfers: everyone active can view the log. Admin + manager can record
-- a transfer. Nobody can edit or delete — it's a permanent audit trail.
create policy "transfers_select" on public.transfers
  for select using (auth.uid() is not null and public.is_active());

create policy "transfers_insert" on public.transfers
  for insert with check (public.my_role() in ('admin','manager') and transferred_by = auth.uid());

-- ---------------------------------------------------------------------------
-- 7. SEED DATA (optional — remove or edit before running in production)
-- ---------------------------------------------------------------------------
-- insert into public.workshops (name, address) values
--   ('Main Workshop', '1 Industrial Way'),
--   ('North Depot', '22 Harbour Road');
