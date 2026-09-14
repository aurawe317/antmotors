-- ============================================================
-- Ant Motors — Schema 补丁 1（补齐后端代码用到、但原 schema 缺失的列）
-- 项目 ref：mcjvlohnyfkvkftrvxeq (antmotors)
-- 执行：Supabase Dashboard → SQL Editor → 粘贴全部 → Run
-- 幂等：全部用 add column if not exists，可安全重复执行
-- ============================================================

-- ---- companies：会员周期 / 公司简介相关（代码里在写，原表没有）----
alter table public.companies add column if not exists bio                text;
alter table public.companies add column if not exists trial_ends_at      bigint;
alter table public.companies add column if not exists plan_started_at    bigint;
alter table public.companies add column if not exists current_period_end bigint;
alter table public.companies add column if not exists alipay_trade_no    text;
alter table public.companies add column if not exists subscription_id    text;
alter table public.companies add column if not exists last_paid_at       bigint;

-- ---- employees：登录用邮箱（代码里大量按 email 查询）----
alter table public.employees add column if not exists email text;
create index if not exists idx_employees_email on public.employees(lower(email));

-- ---- tokens：会话过期时间（代码里在写、在读）----
alter table public.tokens add column if not exists expires_at bigint;

-- ---- cars：updated_by 从 uuid 改为 text，与 employees.id 一致 ----
-- 修复：后端 applyPush 写入 cars.updated_by 时用的是 employees.id（text 类型，
--      如 'Marina'），但原 schema 中 cars.updated_by 是 uuid，导致 upsert 失败。
--      该列无外键约束，可安全改类型。
alter table public.cars alter column updated_by type text;

-- ============================================================
-- 完成。回到 Cloudflare 重新部署一次即可。
-- ============================================================
