# Antoto — App Store 上架交付包

> 用途：复制到 App Store Connect 对应字段。先填占位符（演示账号 / 隐私政策 URL）。

---

## A. 审核备注（App 审核信息 → 备注，建议中英双语）

```
【App 用途】本 App 是面向二手车出口商（中国 ↔ 加纳）的 B2B 销售与库存协同工具。
员工可调用设备相机拍摄车源照片、维护分级报价、向客户分享带归属的销售链接。

【原生能力】App 调用设备相机拍摄车源照片（Capacitor Camera 插件），照片本地压缩后
同步至云端；支持离线编辑与 Service Worker 缓存，弱网下仍可工作。

【订阅说明（重要）】依据 App Store 审核指南 3.1.1，数字商品订阅通过官方网站
antoto.app 完成。App 内不提供任何购买入口、价格或支付跳转，仅只读展示会员状态。
这是刻意的合规设计，并非功能缺失——审核员在 App 内看不到购买按钮属预期行为。
完整订阅流程请于浏览器访问 antoto.app 体验。

【演示账号（公司所有者 Marina，永久会员 premium+permanent，功能全开，不会触发额度/过期问题）】
  账号 / staff id：__________   （由老板提供；员工表有 RLS，本地无法直接读取，请填线上实际 staff id）
  密码 / PIN：__________   （PIN 在数据库以 PBKDF2-SHA256 哈希存储，无法从系统取得明文；请使用已知密码，或经 app/admin 走重置后再填）
```

---

## B. 商品页文案（App Store Connect → App 信息 / 描述）

### 英文
- **App 名称**：Antoto （≤30 字符）
- **副标题**：Used-car export sales & stock （≤30 字符）
- **关键词**：used cars,export,inventory,car dealer,Ghana,Africa,B2B,sales,CRM,vehicle
- **促销文本**（≤170 字符）：
  Capture vehicles, manage quotes, and share branded sales links with customers — built for China–Ghana used-car exporters.
- **描述**（纯文本，无 markdown）：
  Antoto is a B2B sales and inventory tool for used-car exporters trading between China and Ghana.
  - Snap vehicle photos with your camera and upload them straight from the app
  - Maintain multi-tier pricing (cost / floor / customer quote) by role
  - Share trackable sales links that attribute every customer to you
  - Work offline and sync automatically when back online
  - Manage your team, showrooms and membership from one place
  Antoto syncs your inventory across all devices via a shared backend, so every salesperson works from the same live stock. Subscriptions are managed on the Antoto website (antoto.app); the app itself contains no in-app purchases.

### 中文
- **App 名称**：Antoto
- **副标题**：二手车出口销售与库存
- **关键词**：二手车,出口,库存,车商,加纳,非洲,汽车销售,B2B,车源,贸易
- **促销文本**：
  拍照上传车源、维护分级报价、分享带归属的销售链接——专为中非二手车出口商打造。
- **描述**：
  Antoto 是面向中国—加纳二手车出口商的 B2B 销售与库存协同工具。
  - 用相机直接拍摄车源照片并从 App 上传
  - 按角色维护多级报价（成本 / 底价 / 客户报价）
  - 分享可追踪的销售链接，每位客户自动归属到你
  - 支持离线编辑，联网后自动同步
  - 统一管理团队、门店与会员
  Antoto 通过共享后端在各设备间实时同步库存，所有销售共用同一份活库存。会员订阅在 Antoto 网站（antoto.app）完成，App 内不含任何内购。

> 分类建议：**Business（商务）**；年龄分级 **4+**；需要登录账号（勾选"需要登录")。

---

## C. 4.2 web-wrapper 风险与应对

### 现状判定：高风险
`native/capacitor.config.json` 中 `server.url = https://antoto.app`（壳直接远程加载网页），且同一份 `index.html` 零改动包壳——最易被判定"仅是网站套壳"。

### 缓解优先级
| 优先级 | 动作 | 说明 |
|---|---|---|
| 🔴 必须 | 提供**已付费/永久**演示账号（老板账号即可） | 避免撞"额度已满/过期"被判功能不完整 |
| 🟠 高 | 准备"App 内相机拍照上传车源"真实录屏 | 用 `Camera` 原生能力做支点，证明非纯网页 |
| 🟡 中 | 补原生能力让壳更"真"（见下 D） | 推送 / 分享 / 生物识别 / 启动屏主题 |
| 🟡 中 | 隐私政策 URL + 服务条款 URL | 账户类 App 强制，缺了直接被拒 |
| 🟢 低 | 改 `server.url` 为本地打包（不远程加载） | 彻底脱离"网站套壳"观感，但改变零改动打包策略，需拍板 |

### D. 要补的原生能力清单（Capacitor 插件 + 接入点）

1. **@capacitor/push-notifications** — ✅ JS 调用点已写（v1.2.124 `registerPush()`）
   - 接入点：登录成功后 `registerPush()`（`inNativeShell()` 门控 + 插件存在性判断）：申请权限 → `register()` → 监听 `registration` 事件取 token → 本地存 `am_push_token` + POST `/api/device`。插件未装 / 非壳 / 权限拒绝 / 端点未部署 全部 inert（已 harness 验证）。
   - ⚠️ **后端待加**：需新增 `/api/device`（POST）端点接收并存储 token（见 D-3），原生工程 `npm i @capacitor/push-notifications` + `npx cap sync ios` 后才真触发。
   - 价值：证明用设备推送，非纯网页。
2. **@capacitor/share**
   - 接入点：原生壳内分享销售链接/车源改用 `Share.share()` 调系统分享面板（目前 app 用复制链接；在分享按钮处加 `inNativeShell()` 分支）。
   - 价值：原生分享是强原生信号。
3. **@capacitor-community/biometric**
   - 接入点：原生壳内登录页提供 FaceID/TouchID 解锁（读 Keychain 中保存的 PIN）。
   - 价值：原生生物识别，明显区别于网页。
4. **@capacitor/splash-screen + @capacitor/status-bar**
   - 接入点：native 项目配置品牌色启动屏（金属/玻璃/霓虹蓝粉紫）+ 状态栏主题，与 app 启动 loading 一致。
   - 价值：去"网页感"，贴合未来科技机甲风审美。
5. **@capacitor/filesystem** — ✅ JS 调用点已写（v1.2.124）
   - 接入点：`exportData()` 在壳内优先 `Capacitor.Plugins.Filesystem.writeFile({directory:'DOCUMENTS'})` 写入设备"文件"目录（原生文件能力）；无插件/浏览器/PWA 走原 `webExportBackup()` 下载分支（行为不变）。导入仍走原生 `<input type=file>` 桥（Capacitor 已桥接，无需额外插件）。
   - 价值：原生文件系统写入，区别于纯网页下载。

> 已有且务必保留：**@capacitor/camera** 拍照上传——当前最强 4.2 支点，录屏要突出。
> `@capacitor/.../Alipay` 插件壳内已无用（支付被 v1.2.121 gate 掉），可保留不影响，想瘦身可移除。

> ⚠️ 前提：原生 iOS 工程不在此仓库（仅 `native/capacitor.config.json`）。上述插件需加在 Capacitor 原生项目（`npm i` + `npx cap sync ios`）。JS 侧的调用点与 `inNativeShell()` 分支可在此仓库 `app/index.html` 写好（沿用现有 `Capacitor.Plugins.X` 存在性判断模式），Xcode/Pod 集成由你或原生同学执行。

### D-3. 后端待加端点：push 设备令牌（`/api/device`）
`registerPush()` 会把 token POST 到 `/api/device`。该端点在 `functions/api/[[route]].js` 中还不存在，需在原生工程集成 push 时一并加上（无需新建表，存入 `employees.data.devices` 数组即可，避免 DDL）：
```js
// 在 onRequest 的路由匹配段增加（参考现有 /api/company 写法，authOf/sb/send/now 均已存在）：
if (p === '/api/device' && method === 'POST') {
  const auth = await authOf(req, env);          // 复用现有 Bearer token 校验
  if (!auth) return send(401, { error: 'unauthorized' });
  const body = await readBody(req);
  const token = String(body.token || '').slice(0, 512);
  const platform = String(body.platform || 'ios').slice(0, 16);
  if (!token) return send(400, { error: 'missing token' });
  const { data: emp } = await sb.from('employees').select('data').eq('id', auth.id).eq('company_id', auth.companyId).maybeSingle();
  const data = (emp && emp.data) || {};
  const devices = Array.isArray(data.devices) ? data.devices : [];
  const idx = devices.findIndex(d => d.token === token);
  const rec = { token, platform, updated_at: now() };
  if (idx >= 0) devices[idx] = rec; else devices.push(rec);
  await sb.from('employees').update({ data: { ...data, devices } }).eq('id', auth.id).eq('company_id', auth.companyId);
  return send(200, { ok: true });
}
```
> 注：`authOf` / `readBody` / `send` / `now` / `sb` 在该文件中均已存在，可直接复用。上线前请确认写入符合现有 RLS 与字段模式。

---

## D-2. 隐私政策 / 服务条款（账户类 App 强制项）

> ✅ 线上已部署：`app/privacy.html` 与 `app/terms.html` 随 v1.2.123 已上线，访问 `https://antoto.app/privacy` 与 `https://antoto.app/terms` 即可，无需额外部署。
> ⚠️ 两份页面正文已含中英文摘要，联系方式统一为 **support@antoto.app**（与下方草稿一致）。发布前**务必请法务过目**。
> 合并草稿见同目录 **`Privacy-Terms.md`**（双语，中文为正本，联系方式已对齐为 support@antoto.app）。
> 填入 App Store Connect「隐私政策 URL」：`https://antoto.app/privacy`（服务条款 URL 同域可填 `/terms` 或留空由隐私页内链）。

---

## E. 发版状态（参考）
- v1.2.124（`待提交`）JS 侧原生调用点补全：① `exportData()` 壳内接 `Capacitor.Plugins.Filesystem`（原生文件写入，4.2 信号）；② `registerPush()` 登录成功触发（权限+注册+token→POST `/api/device`，插件未装 inert）。整段内联脚本语法 OK + harness `/tmp/am-native.cjs`（7/7：push 三种状态 inert/触发、导出原生/网页分支）。待 push 后端端点（D-3）+ 原生 `npm i` + `npx cap sync ios` 后真生效。
- v1.2.123（`4f0fb1a`）已上线：原生壳内生物识别解锁调用点。harness am-bio 10/10、am-shell 11/11、am-share 4/4。
- v1.2.122（`c908e13`）已上线：原生壳内真原生分享。harness am-share 4/4。
- v1.2.121（`b69cd45`）已上线：原生壳内隐藏全部购买入口（3.1.1 合规）。harness am-shell 11/11。
- ✅ 隐私政策/条款**已上线**：`app/privacy.html` + `app/terms.html` 随 v1.2.123 部署至 `antoto.app/privacy` 与 `/terms`，联系方式 support@antoto.app（仅需法务过目 + 填 App Store Connect「隐私政策 URL」）。
- **仍待原生工程集成**：`@capacitor/share` + `@capacitor-community/biometric` + `@capacitor/push-notifications`（+splash/filesystem）需加在 Capacitor 原生项目 `npm i` + `npx cap sync ios`，壳内 Share/Biometric/Push/Filesystem 才真生效。
- **仍待**：演示账号真实 staff id + PIN（A 段占位，需老板提供）；push 后端 `/api/device` 端点（D-3）；相机拍照录屏（4.2 最强证据）。

---

## F. 提交前最终检查清单（提交前逐项勾选）

**合规（3.1.1）**
- [ ] App 内无任何购买按钮/价格/支付跳转（v1.2.121 已收口，浏览器/PWA 不受影响）
- [ ] A 段审核备注已填「3.1.1 说明」，并附**已付费/永久演示账号**

**原生能力（4.2 抗 web-wrapper）**
- [ ] 相机拍照上传真实录屏准备就绪（最强证据）
- [ ] 原生工程已 `npm i` 并 `npx cap sync ios`：`@capacitor/camera`（已有）、`@capacitor/share`（v1.2.122）、`@capacitor-community/biometric`（v1.2.123）、`@capacitor/filesystem`（v1.2.124）、`@capacitor/push-notifications`（v1.2.124 + D-3 后端）
- [ ] 启动屏/状态栏主题（splash-screen + status-bar）在原生项目配置，去网页感
- [ ] 两域名 health build 与首页字节级一致，确认壳内原生分支真正触发（用真机/模拟器验证 Share/Biometric/Push 弹窗）

**隐私与法务**
- [ ] `antoto.app/privacy` 与 `/terms` 已上线且法务过目
- [ ] App Store Connect「隐私政策 URL」已填 `https://antoto.app/privacy`
- [ ] 隐私问卷（App Privacy / Privacy Nutrition）按实际数据收集填写（相机/照片/设备ID/可能推送令牌）

**账号与演示**
- [ ] 演示账号（Marina）staff id + PIN 已填 A 段，且新设备可登录、功能全开
- [ ] 演示账号为永久会员，不会触发额度/过期被判功能不完整

**提审**
- [ ] App Store Connect 商品页文案（B 段）已填，分类 Business、4+、勾选"需要登录"
- [ ] 构建版本号 ≥ 已上线 build，截图/预览含相机拍照场景
- [ ] 提交时备注附录屏链接或上传演示视频
