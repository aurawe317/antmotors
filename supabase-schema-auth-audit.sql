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
-- 登录失败限流表（同一份 SQL，一次跑齐）
--
-- 为什么不在后端用内存计数？因为 Cloudflare Pages 每次请求可能落在不同 isolate，
-- 内存里的失败次数不会被共享 —— 实测同一个账号连错 9 次，9 次都是 401、一次都没锁，
-- 攻击者只要把请求打散到不同实例就完全绕过了限流。计数必须放在共享的 Postgres。
-- ============================================================================

-- ⚠️ 这张表已经不用了，留在这里只是为了不让你白跑一次。
-- 计数最终落在 auth_events 上（失败次数 = 该账号 15 分钟内 ok=0 的行数），
-- 原因见文件末尾说明；本表会一直空着。如果你不留着做别的用途，直接：
--   drop table if exists public.auth_throttle;

create table if not exists public.auth_throttle (
  k     text primary key,                              -- 账号(小写) | IP
  n     integer not null default 0,                    -- 连续失败次数
  until bigint,                                        -- 锁到哪个毫秒时间戳；null = 没锁
  at    bigint not null default (extract(epoch from now())::bigint*1000),
  ip    text
);
-- 清理已过期的锁（限流表比日志小得多，但一样会涨）
create index if not exists auth_throttle_until_idx on public.auth_throttle (until);

-- 显式授权。缺 GRANT 时 PostgREST 会把这张表从 schema cache 里整个藏起来，
-- 查询和写入都回 PGRST205「Could not find the table … in the schema cache」——
-- 看起来像"表没建"，其实是"建了但当前 role 没权限"。PGRST205 就出自这里。
grant usage on schema public to anon, authenticated, service_role;
grant all on public.auth_events to anon, authenticated, service_role;
grant all on public.auth_throttle to anon, authenticated, service_role;
-- auth_events.id 是 bigserial，取序列值同样需要授权
grant all on sequence public.auth_events_id_seq to anon, authenticated, service_role;

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
-- 限流为什么最后落在 auth_events 上（两次失败的尝试，别再踩）
--
-- 1) 后端用内存 Map 计数：Cloudflare Pages 每次请求可能落在不同 isolate，计数不共享。
--    实测同一个账号连错 9 次，9 次都是 401、一次都没锁 —— 看起来有防护，实际全放过去。
-- 2) 改成上面 auth_throttle 用 upsert 累加：计数永远停在 1（每次都 insert、从不 update），
--    第 8 次失败照样不锁。单独自测 insert+upsert 又是通过的，所以函数本身不像有问题。
--
-- 于是干脆不维护第二份计数：失败次数 = auth_events 里"该账号近 15 分钟 ok=0 的行数"。
-- 每次失败本来就要记一行，计数就是它，零额外写入，也不再依赖 upsert。
-- 窗口是滑动的，旧记录自己滑出去，不需要清理任务，也没有"解锁时间"字段会算错。
--
-- 登录成功的那一瞬间会清掉该账号窗口内的失败行（authPass），
-- 免得某人输错 7 次、第 8 次登进去了，还要因为那 7 次被锁。
-- ============================================================================

-- ============================================================================
-- 清理：日志会无限增长，建议每月执行一次（保留 90 天）
--   delete from public.auth_events where at < extract(epoch from now())::bigint*1000 - 90*86400*1000;
--
-- 顺带一提：登录成功也会写一行，所以这张表涨得比想象快。
-- 如果只想保留失败记录（限流和排障只看失败），把成功行也清掉：
--   delete from public.auth_events where ok = 1 and at < extract(epoch from now())::bigint*1000 - 30*86400*1000;
-- ============================================================================
