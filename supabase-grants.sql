-- ============================================================
-- Ant Motors — 表级授权（GRANT）补丁
-- 项目 ref：mcjvlohnyfkvkftrvxeq (antmotors)
-- 执行：Supabase Dashboard → SQL Editor → 粘贴全部 → Run
--
-- 症状：后端/工具报 `permission denied for table companies`（错误码 42501）
-- 原因：业务表缺少 anon / authenticated / service_role 的表级 GRANT。
--      注意 "service_role 绕过 RLS" ≠ "有表级权限"：BYPASSRLS 与 GRANT 是两回事，
--      表级权限缺失时连 service_role 也会被拒。
-- 安全性：RLS 已启用，真正的行级隔离由策略负责，这里授权是安全的。
-- 幂等：可安全重复执行。
-- ============================================================

grant usage on schema public to anon, authenticated, service_role;

-- service_role（后端 worker 使用的角色）：全量权限
grant all privileges on all tables    in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant all privileges on all functions in schema public to service_role;

-- authenticated（浏览器登录用户，供直连/迁移工具使用）
grant select, insert, update, delete on all tables    in schema public to authenticated;
grant usage, select                   on all sequences in schema public to authenticated;
grant execute                         on all functions in schema public to authenticated;

-- anon（未登录访客，只读公开内容：车源/公司名/照片）
grant select  on all tables    in schema public to anon;
grant execute on all functions in schema public to anon;

-- 以后新建的对象也自动带上同样的授权，避免再次踩坑
alter default privileges in schema public grant all privileges on tables    to service_role;
alter default privileges in schema public grant all privileges on sequences to service_role;
alter default privileges in schema public grant all privileges on functions to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables    to authenticated;
alter default privileges in schema public grant usage, select                   on sequences to authenticated;
alter default privileges in schema public grant execute                         on functions to authenticated;
alter default privileges in schema public grant select  on tables    to anon;
alter default privileges in schema public grant execute on functions to anon;

-- 让 PostgREST 立刻刷新 schema 缓存
notify pgrst, 'reload schema';

-- ============================================================
-- 完成。回 Cloudflare 重新部署一次即可。
-- ============================================================
