-- =============================================================
-- 把「Ant motors」(co_a4812811971e) 设为高级会员 + 永久
-- -------------------------------------------------------------
-- 用途：让该车行的分享链接走自有域名 antmotors.autos（而非平台
--       域名 antoto.app）。前端 shareOrigin() 判定
--       (co.permanent || co.plan='premium') && co.domain 才用自有域。
--       domain 绑定已在 supabase-schema-membership-domains.sql 里
--       预置（antmotors.autos -> co_a4812811971e, kind='custom'）。
--
-- 幂等：可重复执行，不产生副作用。
-- 执行位置：Supabase 后台 → SQL Editor → 粘贴运行；或 psql / supabase CLI。
-- =============================================================

-- 1) 升级档位 + 永久（两条合并为一条，原子执行）
update public.companies
set
  plan      = 'premium',
  permanent = 1
where id = 'co_a4812811971e';

-- 2) 校验结果（应返回 1 行，plan=premium、permanent=true）
select id, name, plan, permanent,
       (select host from public.company_domains
         where company_id = c.id and kind = 'custom' limit 1) as custom_domain
from public.companies c
where id = 'co_a4812811971e';
