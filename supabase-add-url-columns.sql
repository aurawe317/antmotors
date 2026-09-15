-- Ant Motors — 照片/视频迁移到对象存储所需的 schema 变更
-- 运行位置：Supabase 控制台 → 项目 mcjvlohnyfkvkftrvxeq → SQL Editor → 粘贴运行
-- 作用：给 photos / videos 表加 url 列。加完后再部署新 worker 并触发 /api/migrate-photos
--       一次性把历史 base64 上传到 Supabase Storage 并写回 url 列。
-- 注意：ALTER 之后老代码(writePhotos 存 data)仍可用，新代码(writePhotos 存 url)也能跑；
--       未加列时新 worker 会自动回退到 data 列，不会炸，但照片不会进 Storage。

ALTER TABLE public.photos ADD COLUMN IF NOT EXISTS url text;
ALTER TABLE public.videos ADD COLUMN IF NOT EXISTS url text;

COMMENT ON COLUMN public.photos.url IS 'Supabase Storage public URL. New writes store only the URL; base64 lives in data only for legacy rows pre-migration.';
COMMENT ON COLUMN public.videos.url IS 'Supabase Storage public URL. Same convention as photos.url.';
