-- ============================================================
-- Ant Motors — Supabase 多租户 Schema + RLS
-- 登录模型：Supabase Auth（选项 A，用户已确认）
-- 项目 ref：mcjvlohnyfkvmftrvxeq  (antmotors)
-- 执行：Supabase Dashboard → SQL Editor → 粘贴全部 → Run
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------------- 公司 ----------------
create table if not exists public.companies (
  id          text primary key,
  name        text not null,
  logo        text,
  owner_id    uuid,
  code        text unique not null,
  plan        text not null default 'trial',
  status      text not null default 'active',
  permanent   integer not null default 0,
  created_at  bigint not null default extract(epoch from now())::bigint
);

-- 公司与用户的归属（多租户隔离核心）
create table if not exists public.company_members (
  user_id     uuid not null references auth.users(id) on delete cascade,
  company_id  text not null references public.companies(id) on delete cascade,
  role        text not null default 'member', -- owner | admin | member
  created_at  bigint not null default extract(epoch from now())::bigint,
  primary key (user_id, company_id)
);

-- ---------------- 车辆 ----------------
create table if not exists public.cars (
  id          text not null,
  company_id  text not null references public.companies(id) on delete cascade,
  data        jsonb not null,
  listed_at   text,
  updated_at  bigint not null default extract(epoch from now())::bigint,
  updated_by  uuid,
  deleted     integer not null default 0,
  primary key (id, company_id)
);
create index if not exists idx_cars_updated on public.cars(company_id, updated_at);

-- ---------------- 照片 ----------------
create table if not exists public.photos (
  car_id      text not null,
  company_id  text not null references public.companies(id) on delete cascade,
  idx         integer not null,
  data        text not null, -- 建议后续改存 Storage 路径（见说明）
  primary key (car_id, idx, company_id)
);

-- ---------------- 视频 ----------------
create table if not exists public.videos (
  car_id      text not null,
  company_id  text not null references public.companies(id) on delete cascade,
  idx         integer not null,
  data        text not null,
  primary key (car_id, idx, company_id)
);

-- ---------------- 员工 ----------------
create table if not exists public.employees (
  id          text not null,
  company_id  text not null references public.companies(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  data        jsonb not null,
  pin_hash    text, -- 选 A 后可保留作二次验证，或废弃
  updated_at  bigint not null default extract(epoch from now())::bigint,
  deleted     integer not null default 0,
  primary key (id, company_id)
);
create index if not exists idx_emp_updated on public.employees(company_id, updated_at);

-- ---------------- 登录 token（兼容保留，主登录走 Supabase Auth）--------
create table if not exists public.tokens (
  token       text primary key,
  emp_id      text not null,
  company_id  text not null references public.companies(id) on delete cascade,
  created_at  bigint not null default extract(epoch from now())::bigint
);

-- ---------------- 杂项 / 审计 / 展厅 / 订单 / 重置码 ----------------
create table if not exists public.meta (k text primary key, v text);

create table if not exists public.audit (
  id          bigint generated always as identity primary key,
  ts          bigint,
  emp_id      text,
  company_id  text,
  action      text,
  target      text,
  detail      text
);

create table if not exists public.showrooms (
  id          text not null,
  company_id  text not null references public.companies(id) on delete cascade,
  data        jsonb not null,
  updated_at  bigint not null default extract(epoch from now())::bigint,
  primary key (id, company_id)
);

create table if not exists public.orders (
  out_trade_no text primary key,
  company_id   text not null references public.companies(id) on delete cascade,
  plan_id      text not null,
  amount       integer not null,
  status       text not null default 'pending',
  created_at   bigint not null default extract(epoch from now())::bigint,
  paid_at      bigint
);

create table if not exists public.reset_codes (
  id          bigint generated always as identity primary key,
  emp_id      text not null,
  company_id  text not null references public.companies(id) on delete cascade,
  code_hash   text not null,
  channel     text,
  sent_to     text,
  expires_at  bigint not null,
  attempts    integer not null default 0,
  used        integer not null default 0,
  created_at  bigint not null default extract(epoch from now())::bigint
);
create index if not exists idx_reset_emp on public.reset_codes(emp_id, used, expires_at);

-- ============================================================
-- RLS 行级安全（多租户隔离）
-- ============================================================
-- 判断当前用户是否属于某公司（security definer 避免策略递归）
create or replace function public.is_company_member(_company_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.company_members cm
    where cm.user_id = auth.uid() and cm.company_id = _company_id
  );
$$;

alter table public.companies       enable row level security;
alter table public.company_members enable row level security;
alter table public.cars            enable row level security;
alter table public.photos          enable row level security;
alter table public.videos          enable row level security;
alter table public.employees       enable row level security;
alter table public.tokens          enable row level security;
alter table public.meta            enable row level security;
alter table public.audit           enable row level security;
alter table public.showrooms       enable row level security;
alter table public.orders          enable row level security;
alter table public.reset_codes     enable row level security;

-- companies: 公开读（车页显示公司名/logo）；写限成员/owner
create policy companies_select_public on public.companies for select using (true);
create policy companies_insert_owner  on public.companies for insert with check (owner_id = auth.uid());
create policy companies_update_member on public.companies for update using (public.is_company_member(id)) with check (public.is_company_member(id));
create policy companies_delete_owner  on public.companies for delete using (owner_id = auth.uid());

-- company_members: 用户只看/管自己的归属记录
create policy cm_select_self on public.company_members for select using (user_id = auth.uid());
create policy cm_insert_self on public.company_members for insert with check (user_id = auth.uid());
create policy cm_update_self on public.company_members for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy cm_delete_self on public.company_members for delete using (user_id = auth.uid());

-- cars: 公开读（隐藏已删）；写限成员
create policy cars_select_public on public.cars for select using (deleted = 0 or deleted is null);
create policy cars_write_member on public.cars for all
  using (public.is_company_member(company_id)) with check (public.is_company_member(company_id));

-- photos / videos: 公开读；写限成员
create policy photos_select_public on public.photos for select using (true);
create policy photos_write_member on public.photos for all
  using (public.is_company_member(company_id)) with check (public.is_company_member(company_id));

create policy videos_select_public on public.videos for select using (true);
create policy videos_write_member on public.videos for all
  using (public.is_company_member(company_id)) with check (public.is_company_member(company_id));

-- showrooms: 公开读；写限成员
create policy showrooms_select_public on public.showrooms for select using (true);
create policy showrooms_write_member on public.showrooms for all
  using (public.is_company_member(company_id)) with check (public.is_company_member(company_id));

-- employees / tokens / audit / orders / reset_codes: 仅本公司成员
create policy employees_all_member on public.employees for all
  using (public.is_company_member(company_id)) with check (public.is_company_member(company_id));

create policy tokens_all_member on public.tokens for all
  using (public.is_company_member(company_id)) with check (public.is_company_member(company_id));

create policy audit_all_member on public.audit for all
  using (public.is_company_member(company_id)) with check (public.is_company_member(company_id));

create policy orders_all_member on public.orders for all
  using (public.is_company_member(company_id)) with check (public.is_company_member(company_id));

create policy reset_codes_all_member on public.reset_codes for all
  using (public.is_company_member(company_id)) with check (public.is_company_member(company_id));

-- meta: 全局配置，限已登录用户
create policy meta_auth_all on public.meta for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
