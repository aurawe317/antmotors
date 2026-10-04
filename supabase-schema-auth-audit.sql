-- ============================================================================
-- Antoto 平台 — 认证审计日志（P1）
--
-- 怎么跑：Supabase 后台 → 左侧 SQL Editor → New query → 整段粘贴 → Run
--
-- 用途：记录每一次登录尝试（成功/失败）、注册、密码重置，并带上 IP。
--       排障时不再靠猜 —— "昨天谁登不上""是不是有人在试密码"都能查证。
--
-- 说明：后端全部走 service_role 写入，**本表不开 RLS**（与项目其它表一致）。
--       开启 RLS 反而会像 support_messages 那样把唯一写入路径堵死。
-- ============================================================================

create table if not exists public.auth_events (
  id         bigserial primary key,
  at         bigint not null,                          -- 毫秒时间戳（与项目其它表一致）
  account    text,                                     -- 用户输入的账号（可为空串）
  company_id text,                                     -- 成功时所属公司
  ip         text,
  ua         text,                                     -- User-Agent 截断 160 字符
  event      text not null default 'signin',           -- signin | signup | reset | deny
  ok         integer not null default 0,               -- 1 成功 / 0 失败
  code       text                                      -- 失败原因：bad_credentials / no_such_account / locked …
);

-- 主查询路径：按时间倒序看最近事件
create index if not exists auth_events_at_idx on public.auth_events (at desc);
-- 排查撞库：按账号聚合失败次数
create index if not exists auth_events_account_idx on public.auth_events (account, at desc);
-- 统计成功率
create index if not exists auth_events_ok_idx on public.auth_events (ok, at desc);

-- ============================================================================
-- 查询示例（只读，随时可用）
-- ============================================================================

-- 最近 30 条登录事件
-- select at, account, ok, code, ip from public.auth_events order by at desc limit 30;

-- 某个账号的失败记录（排"是不是有人在猜他的密码"）
-- select to_char(to_timestamp(at/1000), 'YYYY-MM-DD HH24:MI:SS') as 时间,
--        ok, code, ip, ua
-- from public.auth_events
-- where account = 'marina'
-- order by at desc limit 50;

-- 近 7 天每日成功/失败次数
-- select date_trunc('day', to_timestamp(at/1000))::date as 日期,
--        count(*) filter (where ok=1) as 成功,
--        count(*) filter (where ok=0) as 失败
-- from public.auth_events
-- where at > extract(epoch from now())::bigint * 1000 - 7*86400*1000
-- group by 1 order by 1 desc;

-- 失败最多的 IP（前 10，撞库排查）
-- select ip, count(*) as 失败次数, max(at) as 最后一次
-- from public.auth_events
-- where ok = 0
-- group by ip order by 2 desc limit 10;

-- ============================================================================
-- 清理：日志会无限增长，建议每月执行一次（保留 90 天）
--   delete from public.auth_events where at < extract(epoch from now())::bigint*1000 - 90*86400*1000;
-- ============================================================================
