-- ============================================================================
-- Ant Motors — 会员档位 / 子域名 / 二维码永久短码
-- 幂等，可重复执行。在 Supabase → SQL Editor 里整段运行。
--
-- ⚠️ 运行顺序：先跑 supabase-schema-patch.sql（公司会员列：trial_ends_at /
--    plan_started_at / current_period_end / alipay_trade_no / subscription_id /
--    last_paid_at），再跑本文件。
-- ============================================================================

-- 1) 公司标识 slug —— 子域名用：xxx.antmotors.autos（如 ant.antmotors.autos / valor.antmotors.autos）
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
--    支持两种形态：平台子域名（ant.antmotors.autos）和客户自有域名（antmotors.autos）。
--    一家公司可绑多个域名；一个域名只能属于一家公司。
create table if not exists public.company_domains (
  host        text primary key,                  -- 小写、无端口，如 "antmotors.autos"
  company_id  text not null references public.companies(id) on delete cascade,
  kind        text not null default 'custom',    -- custom(自有域名) | sub(平台子域名)
  created_at  bigint not null default (extract(epoch from now()) * 1000)::bigint
);
create index if not exists company_domains_company_idx on public.company_domains (company_id);

-- 4.1) 绑定「Ant motors」—— 已购域名 antmotors.autos 指向 co_a4812811971e
insert into public.company_domains (host, company_id, kind)
values ('antmotors.autos', 'co_a4812811971e', 'custom')
on conflict (host) do update set company_id = excluded.company_id;

update public.companies set slug = 'ant' where id = 'co_a4812811971e' and slug is null;

-- 5) 老账号兜底 —— 新额度规则上线后，别让已有库存的公司被卡住。
--    下面两条按需执行（把「Ant motors」设成高级/永久）：
-- update public.companies set plan = 'premium' where id = 'co_a4812811971e';
-- update public.companies set permanent = 1   where id = 'co_a4812811971e';
