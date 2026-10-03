-- ============================================================================
-- Antoto 平台 — 员工 ID 全局唯一
--
-- 怎么跑：Supabase 后台 → 左侧 SQL Editor → New query → 整段运行
--
-- 背景：employees 的主键是 (id, company_id)，也就是「同公司内唯一、跨公司可重复」。
--       但 id 同时是登录账号，而登录查询是不带 company_id 的全局查找 ——
--       两家公司的 id 撞名时，用户会随机登进其中一家，属于多租户串号风险。
--       另外登录匹配忽略大小写（ilike），所以 `boss` 与 `Boss` 实际上也是同一个账号。
--       因此唯一性必须建立在 lower(id) 上，而不是原始 id 上。
-- ============================================================================

-- 1) 先体检：把重复的 id 找出来（正常应返回 0 行）
select lower(id)                as id_key,
       count(*)                 as 用量,
       array_agg(company_id)   as 所属公司,
       array_agg(id)            as 原始写法
from public.employees
where deleted = 0
group by lower(id)
having count(*) > 1;

-- 1.1) 同样体检大小写冲突（`boss` / `Boss` / `BOSS` 会在这里并成一行）
select lower(id) as id_key,
       count(distinct id) as 不同写法,
       array_agg(distinct id) as 写法列表
from public.employees
where deleted = 0
group by lower(id)
having count(distinct id) > 1;

-- ============================================================================
-- 2) 确认上面两段都是 0 行之后，再执行下面这句建唯一索引。
--    ⚠️ 如果第 1 步查出了重复，这句会直接报错（duplicate key）——
--       那是好事，说明它挡住了脏数据。请先人工改名（例如把重复的那家改成 xxx-2）再执行。
--
--    用「部分唯一索引」而不是 alter ... unique：已删除的员工（deleted=1）不占用账号，
--    这样离职员工的 ID 可以回收复用，而不会因为历史删除记录把新同事挡在门外。
-- ============================================================================
create unique index if not exists employees_id_global_unique
  on public.employees (lower(id))
  where deleted = 0;

-- 3) 校验：应能建出索引
-- select indexname, indexdef from pg_indexes
--   where tablename='employees' and indexname='employees_id_global_unique';

-- ============================================================================
-- 4) 应用层也做了同样的校验（注册 / 新增员工时会返回 id_taken 并提示已被哪家公司占用），
--    这里加索引是第二道保险 —— 索引能挡住并发写入，绕开应用层的任何路径。
-- ============================================================================
