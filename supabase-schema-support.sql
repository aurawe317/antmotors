-- ============================================================================
-- Antoto 平台 — App 内客服聊天（support_messages）
--
-- 怎么跑：Supabase 后台 → 左侧 SQL Editor → New query → 整段粘贴 → Run
-- 幂等：可重复执行。
--
-- 用途：车行老板在 App 内直接联系平台客服（不依赖装 WhatsApp），
--       平台客服在 antoto.app/admin.html 集中查看与回复。
-- ============================================================================

-- 1) 会话消息表
--    side: 'user'   车行一侧发出
--          'support' 平台客服回复
create table if not exists public.support_messages (
  id          bigserial primary key,
  company_id  text not null,                    -- 哪家公司（多租户隔离维度）
  user_id     text,                             -- 发送人 employee id（客服侧回复时为空）
  user_name   text,                             -- 发送人展示名（冗余存一份，便于后台直接显示）
  side        text not null,                    -- user | support
  body        text,                             -- 文字内容（可与 photo 至少有一个）
  photo       text,                             -- 图片：Supabase Storage URL（复用 car-photos bucket）
  read        integer not null default 0,       -- 客服侧已读标记（后台可按此筛选未读）
  created_at  bigint not null default (extract(epoch from now()) * 1000)::bigint
);

-- 拉取历史/增量消息的主查询路径：某公司 + 按时间排序
create index if not exists support_messages_company_idx
  on public.support_messages (company_id, created_at);
-- 后台按未读优先列出待处理会话
create index if not exists support_messages_unread_idx
  on public.support_messages (side, read) where read = 0;

comment on column public.support_messages.side   is 'user=车行发出，support=平台客服回复';
comment on column public.support_messages.photo   is '图片的 Supabase Storage URL（与车辆照片同 bucket）';
comment on column public.support_messages.read    is '客服侧是否已读（后台未读筛选用）';

-- 2) 保持与其它表一致：不开启 RLS。
--    ⚠️ 这里曾一度 `enable row level security`，结果 42501「new row violates
--    row-level security policy」把**唯一合法的写入路径堵死了** —— 因为本项目的
--    访问模型是「service_role 只在 Cloudflare 后端使用，浏览器端不持有任何
--    Supabase 凭据」，cars / photos / employees 等表**全部都没有开 RLS**。
--    在这套模型里 RLS 起不到保护作用（匿名用户没有 key，请求根本到不了
--    PostgREST），只会把 service_role 的正常写入拒之门外。
--    需要纵深防御时，用下面「显式放行 service_role」的方式，不要开裸 RLS：
--      drop policy if exists "support_service_role_all" on public.support_messages;
--      create policy "support_service_role_all" on public.support_messages
--        for all to service_role using (true) with check (true);
alter table public.support_messages disable row level security;

-- 3) 校验：期望 id / company_id / side / body / photo / read / created_at 七列
-- select column_name, data_type from information_schema.columns
--   where table_schema='public' and table_name='support_messages'
--   order by ordinal_position;

-- ============================================================================
-- 4) 客服后台登录账号（可选但推荐）
--     admin.html 复用现有登录接口 + 白名单公司校验，所以需要一个「平台公司」的
--     owner 账号。Ant motors (co_a4812811971e) 即为平台自营公司，直接用它的
--     boss 账号登录即可，无需新建。
--     如果想用一个独立邮箱，插入下面这条（注册后用该邮箱+密码登录）：
-- insert into public.employees (id, company_id, email, data, updated_at, deleted)
-- values ('support_admin', 'co_a4812811971e', 'support@antoto.app',
--         '{"name":"Platform Support","av":"S","tier":"boss","role":"Platform Support"}',
--         (extract(epoch from now()) * 1000)::bigint, 0);
-- ============================================================================
