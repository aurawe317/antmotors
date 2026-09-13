# Ant Motors — 部署到 Cloudflare Pages（Supabase 后端）

本仓库结构：
- `app/`            前端静态站点（index.html 等），原样部署，无需改动
- `functions/api/[[route]].js`  后端 API（替代原 server.js），直连 Supabase
- `package.json`    声明 `@supabase/supabase-js`（Cloudflare 构建时会打包）
- `supabase-schema.sql`   已在 Supabase SQL Editor 执行的多租户 schema + RLS
- `migrate-to-supabase.html` / `migrate-console.js`   浏览器数据 → Supabase 迁移工具

## 前提
1. Supabase 项目已建好，且已执行 `supabase-schema.sql`（你已完成）。
2. 已拿到 **Project URL** 和 **service_role key**（Supabase → Settings → API，注意是 service_role 不是 anon）。
3. GitHub 仓库已推送到远程（本机可连 GitHub）。

## 步骤
### 1. 设置 Cloudflare Pages
- 登录 Cloudflare Dashboard → Workers & Pages → Create → Pages → 连接 Git 仓库。
- 构建配置：
  - Framework preset: `None`
  - Build command: **留空**
  - Build output directory: **`app`**
- 创建后，进入 Settings → Environment variables，添加：
  - `SUPABASE_URL` = `https://<ref>.supabase.co`（普通变量）
  - `SUPABASE_SERVICE_ROLE_KEY` = `<service_role key>`（**Encrypt / Secret** 形式）
- 保存，触发一次部署。

### 2. 拿到新域名
部署完成后 Cloudflare 会给你一个 `*.pages.dev` 域名（也可绑定自定义域名）。**请使用这个新域名**——
它的浏览器 localStorage 是独立的，前端会自动探测同源 `/api/health` 并连上 Functions，不会去连已死的 Railway。

### 3. 迁移浏览器里的客户数据
Railway 已死，浏览器 localStorage 是目前唯一一份客户数据。用之前给你的两个工具把它推进 Supabase：
- 优先：打开 `migrate-to-supabase.html`（需在**曾装过 App 的同一浏览器/域名**下，否则读不到 localStorage）。
- 兜底（数据被困在已安装的 PWA / 旧域名）：在 App 页面 F12 控制台粘贴 `migrate-console.js` 内容执行（同源，绕过域名限制）。
- 迁移完成后，到 Supabase → Settings → API **轮换**那把 anon key（迁移工具里硬编码过）。

### 4. 登录 / 账号
- 登录走 Supabase Auth（邮箱+密码）。曾做迁移的人已有 Supabase Auth 账号 → 用当时注册的邮箱+密码登录，首次登录自动按"老板"建档并关联公司。
- 新同事：在 App 内注册（填邮箱+密码+公司邀请码）→ 自动建 Supabase Auth 账号，可直接登录。
- 旧 PIN 已无法使用（存在已死的 Railway 库里，没带过来）。

### 5. 冒烟测试（部署后必做）
沙箱无法连 Supabase，以下需你这边验证：
1. 打开新域名 → 应能加载（离线缓存或同源 API）。
2. 用邮箱+密码登录 → 看到公司 + 车辆列表。
3. 新增/编辑一辆车 → 刷新后仍在（说明已写入 Supabase）。
4. 把某辆车的分享链接发给加纳同事 → 对方能打开看图。
5. 有任何报错，把浏览器控制台 / 网络面板的报错发我，我来修。

## 备注
- 加纳客户走 Cloudflare 阿克拉(Accra)边缘节点，首屏与图片都快。
- Supabase Free 项目闲置 1 周会暂停；生产稳定后建议升 Pro（$25/月）避免休眠。
- 照片目前仍是 base64 存 `photos` 表（与迁移格式一致）。数据稳定后建议改存 Supabase Storage、DB 只留路径。
