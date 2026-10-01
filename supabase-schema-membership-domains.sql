-- ============================================================================
-- Antoto 平台 — 租户子域名 / 会员档位 / 二维码永久短码
--
-- 怎么跑：Supabase 后台 → 左侧 SQL Editor → New query → 整段粘贴 → Run（或 ⌘⏎）
-- 幂等：可重复执行，不会重复建表也不会覆盖已有数据。
-- 权限：后端 functions/api/[[route]].js 用 service_role key 访问，绕过 RLS，
--       建表即可生效，不需要额外授权语句。
--
-- ⚠️ 运行顺序：先跑 supabase-schema-patch.sql，再跑本文件。
--
-- 域名口径（2026-10-01 定稿，与代码一致）：
--   平台主域名      antoto.app（另有 www / app / api / go 四个子域）
--   租户平台子域名  <slug>.antoto.app   例：antmotors.antoto.app
--   租户自有域名    客户自己买的域名     例：antmotors.autos
--   ⚠️ 不要用 xxx.antmotors.autos 给别家租户做子域名 —— 会让别家车行的链接
--      里带上 "antmotors" 字样。antmotors.autos 只是本公司自己的域名。
-- ============================================================================

-- 1) 公司标识 slug —— 用于 <slug>.antoto.app
--    规则：小写字母 / 数字 / 连字符，2~30 位。一旦对外使用就不再改动
--    （二维码、名片、广告牌上印的都是它）。
alter table public.companies add column if not exists slug text;
create unique index if not exists companies_slug_key
  on public.companies (lower(slug)) where slug is not null;

-- 2) 会员档位：free / standard / premium（新注册默认 free；额度不落库，由代码按档位计算）
alter table public.companies alter column plan set default 'free';

-- 3) 二维码永久短码表
--    会印到传单 / 广告牌上 —— 规则是「码一次生成、永不改动」，只有服务端映射可以改。
--    所以：code 是主键且永不复用；car_id 指向车辆（为空表示"公司入口"码）。
create table if not exists public.qr_codes (
  code        text primary key,                  -- 短码，如 "a7k2m9fq"（随机、不可猜测、永不复用）
  company_id  text not null references public.companies(id) on delete cascade,
  car_id      text,                              -- 车辆 id；null = 公司入口码
  kind        text not null default 'car',       -- car | company
  label       text,                              -- 备注（车名等），仅内部使用
  target_url  text,                              -- 可选：覆盖默认跳转；留空则按规则生成
  created_at  bigint not null default (extract(epoch from now()) * 1000)::bigint,
  created_by  text,
  disabled    integer not null default 0         -- 仅用于作废；正常情况永不变
);
create index if not exists qr_codes_company_idx on public.qr_codes (company_id);
create index if not exists qr_codes_car_idx     on public.qr_codes (company_id, car_id);

-- 4) 域名绑定表 —— 「访问域名 → 公司」的唯一真相来源。
--    两种形态都支持：
--      kind='sub'     平台子域名，如 antmotors.antoto.app
--      kind='custom'  客户自有域名，如 antmotors.autos
--    一家公司可绑多个域名；一个域名只能属于一家公司。
--    ⚠️ 本表只负责「映射」。域名要真正能访问，还得满足：
--       ① DNS 有解析（平台子域名可用一条通配 CNAME *.antoto.app 一劳永逸）
--       ② Cloudflare Pages 项目里添加了这个自定义域名（Pages 不支持通配，需逐个加）
create table if not exists public.company_domains (
  host        text primary key,                  -- 小写、无端口，如 "antmotors.autos"
  company_id  text not null references public.companies(id) on delete cascade,
  kind        text not null default 'custom',    -- custom(自有域名) | sub(平台子域名)
  created_at  bigint not null default (extract(epoch from now()) * 1000)::bigint
);
create index if not exists company_domains_company_idx on public.company_domains (company_id);

-- 4.1) 绑定现有公司「Ant motors」= co_a4812811971e
--      ⚠️ 下面这条 slug 就是该公司的对外标识，会决定 antmotors.antoto.app 这个地址。
--         想换别的前缀，改这一行的 'antmotors' 即可（改完重跑本文件不会覆盖，
--         需手动 update，见 4.3）。
insert into public.company_domains (host, company_id, kind)
values ('antmotors.autos', 'co_a4812811971e', 'custom')
on conflict (host) do update set company_id = excluded.company_id;

update public.companies
   set slug = 'antmotors'
 where id = 'co_a4812811971e' and slug is null;

-- 4.2) 若该公司 slug 已被设成旧值（例如 'ant'），用这条改过来：
-- update public.companies set slug = 'antmotors' where id = 'co_a4812811971e';

-- 4.3) 给新租户接域名的模板（按需复制，替换三处占位符）：
-- insert into public.company_domains (host, company_id, kind)
-- values ('valor.autos', 'co_xxxxxxxx', 'custom')          -- ① 自有域名
-- on conflict (host) do update set company_id = excluded.company_id;
-- insert into public.company_domains (host, company_id, kind)
-- values ('valor.antoto.app', 'co_xxxxxxxx', 'sub')        -- ② 平台子域名
-- on conflict (host) do update set company_id = excluded.company_id;
-- update public.companies set slug = 'valor' where id = 'co_xxxxxxxx';

-- 5) 老账号兜底 —— 新额度规则上线后，别让已有库存的公司被卡住。
--    下面两条按需执行（把「Ant motors」设成高级/永久）：
-- update public.companies set plan = 'premium' where id = 'co_a4812811971e';
-- update public.companies set permanent = 1   where id = 'co_a4812811971e';

-- 6) 公司对外联系信息 —— 展示在租户自有域名浏览页（如 antmotors.autos）的客户底部联系栏。
--    由 App 后台「公司设置 → Public contact」编辑；直访公司域名的客户（非销售分享链接进入）
--    看到该联系人。通过销售分享链接进入的，仍显示该销售本人（见前端 customerContact()）。
alter table public.companies
  add column if not exists contact_name  text,   -- 公司对外联系人姓名
  add column if not exists contact_phone text,   -- 公司对外电话（tel: 拨号，含国家码）
  add column if not exists contact_wa    text;   -- 公司对外 WhatsApp（含国家码，不含 +）

comment on column public.companies.contact_name  is '公司对外联系人姓名（客户浏览页底部联系栏）';
comment on column public.companies.contact_phone is '公司对外电话（tel: 拨号，建议含国家码如 233xxxx）';
comment on column public.companies.contact_wa    is '公司对外 WhatsApp 号码（含国家码，不含 +，如 233xxxx）';

-- ============================================================================
-- 7) 跑完后校验 —— 复制这一段单独执行一次，确认结果正确
-- ============================================================================

-- 7.1) 三列应存在（期望 3 行）
-- select column_name, data_type from information_schema.columns
--   where table_schema='public' and table_name='companies'
--     and column_name in ('contact_name','contact_phone','contact_wa')
--   order by column_name;

-- 7.2) slug 应为 antmotors（期望 1 行，slug=antmotors）
-- select id, name, slug, plan from public.companies order by created_at;

-- 7.3) 域名映射应有一条 antmotors.autos → co_a4812811971e
-- select host, company_id, kind from public.company_domains order by host;

-- 7.4) 所有公司都应有 slug（期望 0 行 —— 有结果说明还有公司没设标识）
-- select id, name from public.companies where slug is null;

-- ============================================================================
-- 8) 端到端验证（SQL 跑完后，在浏览器里确认）
--    https://antmotors.autos/api/public/cars      → company 应为 co_a4812811971e
--    https://antoto.app/api/public/cars           → company 应为 null（平台不属于任何租户）
-- ============================================================================
