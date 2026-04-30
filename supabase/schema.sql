create extension if not exists "pgcrypto";

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (username ~ '^[a-z0-9_]{3,32}$'),
  display_name text not null check (char_length(display_name) between 1 and 32),
  password_hash text not null,
  color text,
  member_group text,
  created_at timestamptz not null default now()
);

create table if not exists auth_sessions (
  token_hash text primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists learning_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  color text not null default '#64748b',
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists usage_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references learning_accounts(id) on delete set null,
  user_id uuid not null references app_users(id) on delete cascade,
  username text not null,
  display_name text not null,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text,
  duration_ms integer
);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references learning_accounts(id) on delete set null,
  user_id uuid references app_users(id) on delete set null,
  name text not null,
  text text not null check (char_length(text) between 1 and 500),
  to_session_id uuid references usage_sessions(id) on delete set null,
  to_name text,
  system boolean not null default false,
  created_at timestamptz not null default now()
);

insert into learning_accounts (name, color, sort_order)
values ('学习账号 A', '#2563eb', 1), ('学习账号 B', '#16a34a', 2)
on conflict (name) do nothing;

create unique index if not exists one_active_user_per_account
  on usage_sessions (user_id, account_id)
  where ended_at is null and account_id is not null;

create index if not exists usage_sessions_started_at_idx on usage_sessions(started_at desc);
create index if not exists usage_sessions_active_idx on usage_sessions(ended_at) where ended_at is null;
create index if not exists usage_sessions_account_idx on usage_sessions(account_id);
create index if not exists chat_messages_created_at_idx on chat_messages(created_at desc);
create index if not exists chat_messages_account_idx on chat_messages(account_id);
create index if not exists auth_sessions_user_id_idx on auth_sessions(user_id);
