-- =============================================================
-- 公司对外联系信息（展示在租户自有域名浏览页的底部联系栏）
-- -------------------------------------------------------------
-- 由 App 后台「公司设置」编辑；客户在 antmotors.autos 这类公司域名
-- 直接浏览时（非销售分享链接进入），底部联系栏显示该联系人。
-- 通过销售分享链接进入的，仍显示该销售本人（见前端 customerContact()）。
--
-- 幂等：可重复执行（Postgres 15 支持 ADD COLUMN IF NOT EXISTS）。
-- 执行位置：Supabase 后台 → SQL Editor → 粘贴运行。
-- =============================================================

alter table if exists public.companies
  add column if not exists contact_name  text,   -- 公司对外联系人姓名
  add column if not exists contact_phone text,   -- 公司对外电话（tel: 拨号，含国家码）
  add column if not exists contact_wa    text;   -- 公司对外 WhatsApp（含国家码，不含 +）

comment on column public.companies.contact_name  is '公司对外联系人姓名（客户浏览页底部联系栏）';
comment on column public.companies.contact_phone is '公司对外电话（tel: 拨号，建议含国家码如 233xxxx）';
comment on column public.companies.contact_wa    is '公司对外 WhatsApp 号码（含国家码，不含 +，如 233xxxx）';

-- 校验：应看到三列已存在
select column_name, data_type
from information_schema.columns
where table_schema='public' and table_name='companies'
  and column_name in ('contact_name','contact_phone','contact_wa')
order by column_name;
