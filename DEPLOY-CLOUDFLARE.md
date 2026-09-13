# Ant Motors — 部署到 Cloudflare Pages（Supabase 后端）

本仓库结构：
- `app/`            前端静态站点（index.html 等），原样部署，无需改动
- `functions/api/[[route]].js`  后端 API（替代原 server.js），直连 Supabase
- `package.json`    声明 `@supabase/supabase-js`（Cloudflare 构建时会打包）
- `supabase-schema.sql`   多租户 schema + RLS（基础表结构）
- `supabase-schema-patch.sql`  **补丁 1：补齐代码用到但基础 schema 缺的列**（必须执行，见步骤 0）
- `migrate-to-supabase.html` / `migrate-console.js`   浏览器数据 → Supabase 迁移工具
- `native/`         Capacitor iOS/Android 壳（本地构建，已配置加载线上 URL）

## 前提
1. Supabase 项目已建好，且已执行 `supabase-schema.sql`（你已完成）。
2. 已拿到 **Project URL** 和 **service_role key**（Supabase → Settings → API，注意是 service_role 不是 anon）。
3. GitHub 仓库已推送到远程（本机可连 GitHub）。

## 步骤
### 0. 补齐 Schema（必做，一次性）
打开 Supabase → SQL Editor → 粘贴 `supabase-schema-patch.sql` 全部内容 → Run。
它用 `add column if not exists` 补齐后端代码依赖但基础 schema 没有的列：
- `companies`: `bio / trial_ends_at / plan_started_at / current_period_end / alipay_trade_no / subscription_id / last_paid_at`
- `employees`: `email`
- `tokens`: `expires_at`

**不做这一步，注册会在建公司那一步失败**（`column companies.trial_ends_at does not exist`）。脚本幂等，可重复执行。

### 1. 设置 Cloudflare Pages
- 登录 Cloudflare Dashboard → Workers & Pages → Create → Pages → 连接 Git 仓库。
- 构建配置：
  - Framework preset: `None`
  - Build command: **留空**（或填 `npm install`，效果一样）
  - Build output directory: **`app`**
- 创建后，进入 **Settings → Variables and secrets**，添加下面 **这一个 Secret**（Cloudflare 的 Git 连接部署**不会**注入 `wrangler.toml` 的 `[vars]`，变量必须在这里加）：
  - **Name**: `SUPABASE_SERVICE_ROLE_KEY`
  - **Value**: Supabase 后台 → Settings → API → `service_role` 那一行（点眼睛复制，**不是** anon）
  - **Type**: **Secret / Encrypt**（务必选 Secret）

  > **项目 URL 已写死在代码里**（`functions/api/[[route]].js` 的 `SUPABASE_URL_FIXED = https://mcjvlohnyfkvkftrvxeq.supabase.co`），**代码不再读取 `SUPABASE_URL` 环境变量**。这是刻意的：历史上曾因一个拼错的 ref（`…fkvm…` 而非 `…fkvk…`）指向**不存在的主机**，导致所有请求被 Cloudflare 回 `error 1016 / HTTP 530`，排查了很久。换项目时改这一行常量即可。**另请确认 Cloudflare 里没有残留旧的 `SUPABASE_URL` 变量**（有则删掉）。

- ⚠️ **关键坑：必须同时加到 Production 与 Preview 两个环境。** 在 Environment variables 页面顶部有 `Production` / `Preview` 切换，**两个环境都要各加一次**这个 Secret，否则你访问的线上域名可能落在没配置变量的那个环境，仍报 `config_missing`。
- 加好后保存，并触发一次部署（**Deployments → Retry deployment**）。如果之前加变量时控制台弹出红色 `API Request Failed`，说明没保存成功——重试直到列表里能看到这条变量为止。

### 2. 拿到新域名
部署完成后 Cloudflare 会给你一个 `*.pages.dev` 域名（也可绑定自定义域名）。**请使用这个新域名**——
它的浏览器 localStorage 是独立的，前端会自动探测同源 `/api/health` 并连上 Functions，不会去连已死的 Railway。

如果 Cloudflare 给的域名**不是** `antmotors.pages.dev`，请同步修改：
- `native/capacitor.config.json` 里的 `server.url`
- `native/ios/App/App/capacitor.config.json` 里的 `server.url`
- 然后重新跑 `cd native && npx cap sync ios`。

### 3. 迁移浏览器里的客户数据
Railway 已死，浏览器 localStorage 是目前唯一一份客户数据。用之前给你的两个工具把它推进 Supabase：
- 优先：打开 `migrate-to-supabase.html`（需在**曾装过 App 的同一浏览器/域名**下，否则读不到 localStorage）。
- 兜底（数据被困在已安装的 PWA / 旧域名）：在 App 页面 F12 控制台粘贴 `migrate-console.js` 内容执行（同源，绕过域名限制）。
- 迁移完成后，到 Supabase → Settings → API **轮换**那把 anon key（迁移工具里硬编码过）。

### 4. 登录 / 账号（v1.2.36 起改为自包含鉴权）
- **注册与登录不再依赖 Supabase Auth。**会话 token 由后端自己签发（`tokens` 表），密码以 PBKDF2-SHA256（10 万次迭代 + 随机 salt）哈希后存在员工记录的 `data._pw` 字段里（服务端专有，任何 API 响应都会剔除）。
- 原因：部分 Supabase 项目的 Auth 服务会持续返回 `HTTP 530` 且重启无效；应用因此改为「Supabase Auth 尽力而为（best-effort）+ 本地哈希兜底」，Auth 挂了也不影响注册登录。
- 若 Supabase Auth 恢复正常，注册时仍会顺带创建 Auth 账号（用于以后接邮件找回），失败则静默跳过并继续。
- 旧 PIN 已失效（存在已死的 Railway 库里）。新账号直接用 App 内注册的邮箱+密码登录。

### 5. 冒烟测试（部署后必做）
沙箱无法连 Supabase，以下需你这边验证：
1. 打开新域名 → 应能加载（离线缓存或同源 API）。
2. 用邮箱+密码登录 → 看到公司 + 车辆列表。
3. 新增/编辑一辆车 → 刷新后仍在（说明已写入 Supabase）。
4. 把某辆车的分享链接发给加纳同事 → 对方能打开看图。
5. iOS 壳：Xcode 运行后应直接加载线上页面（不是本地旧 v36 内容）。
6. 有任何报错，把浏览器控制台 / 网络面板的报错发我，我来修。

## 备注
- 加纳客户走 Cloudflare 阿克拉(Accra)边缘节点，首屏与图片都快。
- Supabase Free 项目闲置 1 周会暂停；生产稳定后建议升 Pro（$25/月）避免休眠。
- 照片目前仍是 base64 存 `photos` 表（与迁移格式一致）。数据稳定后建议改存 Supabase Storage、DB 只留路径。
