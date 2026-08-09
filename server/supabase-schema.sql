-- Ant Motors — Supabase mirror schema (Phase 0/1 dual-track migration)
-- Run this in the Supabase SQL editor of the project you want to use as the
-- eventual primary datastore. Columns are 1:1 with server/server.js SQLite
-- tables. The `data` column is kept as TEXT (the exact JSON string SQLite
-- stores) so the mirror is lossless and the client keeps parsing it as JSON
-- unchanged. (If you prefer JSONB, change `data text` -> `data jsonb`; the
-- rest is identical.)
--
-- The mirror is driven by the SERVICE ROLE key, which bypasses Row-Level
-- Security, so writes always succeed. When you later flip reads to Supabase
-- (Phase 3) you can enable RLS + a per-company policy — a commented template
-- is at the bottom.

create table if not exists companies (
  id text primary key,
  name text not null,
  logo text,
  owner_id text,
  code text unique not null,
  plan text not null default 'trial',
  status text not null default 'active',
  permanent integer not null default 0,
  created_at bigint not null,
  bio text,
  trial_ends_at bigint,
  plan_started_at bigint,
  current_period_end bigint,
  alipay_trade_no text,
  subscription_id text,
  last_paid_at bigint
);

create table if not exists cars (
  id text not null,
  company_id text not null default 'co_default',
  data text not null,
  listed_at text,
  updated_at bigint not null,
  updated_by text,
  deleted integer not null default 0,
  primary key (id, company_id)
);

create table if not exists employees (
  id text not null,
  company_id text not null default 'co_default',
  data text not null,
  pin_hash text,
  updated_at bigint not null,
  deleted integer not null default 0,
  email text,
  cred_kind text not null default 'pin',
  fail_count integer not null default 0,
  locked_until bigint not null default 0,
  pw_changed_at bigint,
  primary key (id, company_id)
);

create table if not exists showrooms (
  id text not null,
  company_id text not null default 'co_default',
  data text not null,
  updated_at bigint not null,
  primary key (id, company_id)
);

create table if not exists orders (
  out_trade_no text primary key,
  company_id text not null,
  plan_id text not null,
  amount integer not null,
  status text not null default 'pending',
  created_at bigint not null,
  paid_at bigint
);

-- ---------------------------------------------------------------------------
-- (Optional, recommended for Phase 3) Row-Level Security: a company can never
-- read another company's rows even if the app layer forgets the filter.
-- The service role bypasses RLS, so mirror writes are unaffected. To use with
-- an authenticated client, set `app.company_id` per request, e.g.:
--
--   alter table companies enable row level security;
--   alter table cars       enable row level security;
--   alter table employees  enable row level security;
--   alter table showrooms  enable row level security;
--   alter table orders      enable row level security;
--
--   create policy tenant_isolation on cars for all
--     using (company_id = current_setting('app.company_id', true));
--   create policy tenant_isolation on employees for all
--     using (company_id = current_setting('app.company_id', true));
--   create policy tenant_isolation on showrooms for all
--     using (company_id = current_setting('app.company_id', true));
--   create policy tenant_isolation on orders for all
--     using (company_id = current_setting('app.company_id', true));
--   create policy tenant_isolation on companies for all
--     using (id = current_setting('app.company_id', true));
-- ---------------------------------------------------------------------------
