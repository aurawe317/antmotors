# Antoto — 原生壳录屏脚本（App Store 4.2 审核证据）

> 用途：在 **Capacitor 原生壳**（不是 Safari）里逐镜头录制，做成 60–90 秒 App 预览视频 / 提审演示录屏。
> 目的：对抗 Guideline 4.2「minimum functionality / 网站套壳」判定。每个镜头都要让审核员看到**原生能力**。
>
> ✅ **前提已全部满足（2026-10-13/14）**：7 个插件已装并跑过 `npx cap sync ios`，
> `xcodebuild build` 编译通过，7 个插件类已静态链入二进制。插件清单：
> `@capacitor/camera` `@capacitor/share` `@capacitor/filesystem` `@capacitor/push-notifications`
> `@capacitor/splash-screen` `@capacitor/status-bar` `@capgo/capacitor-native-biometric`
> （⚠️ 老资料里的 `@capacitor-community/biometric` 在 npm 已 404，别装）。
>
> ✅ **推送授权（镜头 7）已就绪（2026-10-19 核实）**：授权框来自 UserNotifications 的
> `requestAuthorization`，与 APNs entitlement 无关；`App.entitlements` 已有
> `aps-environment=development` 且 pbxproj 双 config 都接了 `CODE_SIGN_ENTITLEMENTS`，
> `register()` 能正常拿到 token。APNs `.p8` 只决定服务端能否**真发**推送——本镜头只拍
> 「授权框 + 点允许」，不需要真收到通知，`.p8` 不是阻塞。
> ⚠️ 但 iOS 推送授权框**每台设备只弹一次**：之前在真机登录过（registerPush 已跑过），
> 要重拍必须**删 App → Xcode 重新 Run → 重新登录**，框才会再弹（删 App 会重置通知权限，
> 与之前点过「允许」还是「不允许」无关）。
>
> 🔴 **重要：7 个镜头里只有镜头 6 能靠网页单独完成**，其余 6 个全是原生能力
> （启动屏 / 系统相机 / Face ID / 分享面板 / 沙盒文件 / APNs 授权）。
> 这不是脚本的缺陷，**这正是录屏的意义**——如果网页全能做，4.2 就没有原生证据可拍。

---

## 镜头顺序（按"原生信号强度"从强到弱排）

审核员只认真实原生的东西。**相机拍摄放在第一个**——这是最强证据，前 10 秒就要看到。

### 镜头 1｜冷启动 + 品牌启动屏（5s）
- 杀掉 App 重新打开，拍**启动屏到首页**的过渡（证明 splash-screen 主题生效，不是浏览器 tab）。
- 口播/字幕：*"Antoto — inventory for China→Ghana car exporters."*

### 镜头 2｜📷 相机现场拍摄车源（15s）⭐ 最强证据
- 进「库存 → 新增车辆」，点拍照区 → **系统相机界面弹出**（Capacitor Camera 原生 UI）。
- ⚠️ **代码里是 `source:'PROMPT'`**（`pickCarPhotoNative()`，`app/index.html:3924`），所以**不会直接进相机**，
  而是先弹一个 iOS 操作表（`Take Photo / Photo Library`）——**必须点「拍照 / Take Photo」那一项**，
  点了「从相册选择」就拍不到相机了，这个镜头等于白录。
  （操作表本身也是原生 UI，但相机那一帧才是最强证据。）
- 实拍一张车（哪怕拍桌面/停车场都行），确认缩略图出现，再拍 1–2 张。
- 填车名/价格，保存。
- **审核员看点**：`UIImagePickerController` 是系统相机，网页 `<input type=file>` 在壳里不会长这样。
- 若 App 里拍照走的是相册选择器，补一句"也可以从相册选"，但**相机那一下必须拍到**。

### 镜头 3｜😀 Face ID / 指纹解锁（10s）
- 退出登录回到登录页 → 键盘弹出前**先出现「🔓 Unlock (Face ID / fingerprint)」按钮**。
- 点它 → **系统 Face ID 弹窗**（`LAContext` 原生 UI）→ 通过后直接登录进首页。
- **审核员看点**：原生生物识别框架，纯网页做不到。
- 注：需要此前在本机成功登录过一次（登录成功会自动 enrol 到设备密钥库）。
- 🔴 **真机未实测警告（2026-10-19）**：capgo 插件的真机行为从没跑过一次（只测过静态逻辑）。
  正式录制前先在 水水 上点一次 Unlock 验证：按钮出现、系统面板弹出、不崩、能登进首页。
  若中途删过 App，localStorage 的 `am_bio_on` 被清 → 按钮隐藏 → 需再用密码登录一次重新 enroll。

### 镜头 4｜📤 原生分享面板（10s）
- 进任一台车详情 → 点分享 → **iOS 系统分享面板**（Share Sheet：AirDrop / 信息 / WhatsApp …）。
- 选「拷贝」或任意目标完成一次分享。
- **审核员看点**：`UIActivityViewController` 原生分享，区别于网页 `navigator.share`（后者在 WKWebView 里常常不弹或样式很丑）。

### 镜头 5｜💾 导出备份到「文件」（8s）
- 设置 → 数据备份 → 点「导出备份」→ 弹 toast `Backup exported · Files`。
- （可选）切到 iOS「文件 App → 我的 iPhone → Antoto」展示那个 `.json` 确实落在设备上。
- **审核员看点**：`@capacitor/filesystem` 写入设备沙盒，网页下载在壳里是拿不到文件的。

### 镜头 6｜📦 完整业务闭环（20s，快剪）
- 多级报价（成本 / 底价A / 底价B / 客户报价）填一遍；
- 库存列表刷新看到刚拍的车；
- 客户分享链接打开 → 只显示客户该看的报价（不露成本）——顺带证明"按角色可见"是真业务逻辑。
- **审核员看点**：这些深度功能是"网站套壳"做不到的。

> 💡 **实际能力比上面写的更强，建议加拍一个"角色切换对比"**（`app/index.html:2954-2975` 的 `priceBlock`）：
> 同一台车，6 种身份看到的价格完全不同——这比"填一遍四级报价"硬得多，因为它证明的是**真实 RBAC**：
>
> | 身份 | 能看到 |
> |---|---|
> | customer | 只有 `quote`（Selling Price） |
> | manager | `floorA` + `floorB` + `quote`，**明确标注 "Cost hidden"** |
> | salesA | 本人 `floorA` + `quote` + 本人毛利 |
> | salesB | 本人 `floorB` + `quote` + 本人毛利 |
> | boss / partnerA / partnerB | 全量 `cost` + `quote` + `floorA` + `floorB` + 毛利 |
>
> 拍法：老板身份看一台车（显示成本+毛利）→ 切到客户分享链接看同一台车（只剩售价）。
> 10 秒就能讲完"成本价永不外泄"。

### 镜头 7｜🔔 推送授权（5s，可选）
- 登录成功后系统弹出**"Antoto 想给您发送通知"**授权框——拍到即可（点允许）。
- 这一步证明 App 真的注册了 APNs。
- ⚠️ **每设备只弹一次**：若之前在真机登录过，先**删 App → 重新 Run → 重新登录**（见头部说明）。
- 💡 删 App 会同时清掉 localStorage 的 `am_bio_on`（生物识别 enroll 标记），所以
  「删 App → 重装 → 密码登录」这一套准备动作能**一次满足镜头 3 + 7**：登录时自动 enroll
  生物识别 + 弹推送授权；随后退出登录即可拍镜头 3 的 Unlock 按钮。

---

## 录制注意事项

| 项 | 要求 |
|---|---|
| 设备 | 真机 iPhone（模拟器的 Face ID / 相机行为不一样，审核员不认模拟器痕迹） |
| 分辨率 | 用 iPhone 的**原生屏幕录制**（设置 → 控制中心 → 屏幕录制），别用 Mac 投屏（会有边框/缩放痕迹） |
| 网络 | 正常网络，让同步真实发生（弱网可展示离线能力，但主流程要顺畅） |
| 登录态 | 用**老板账号 Marina**（premium 永久会员）——壳内会显示"永久会员"且**没有任何购买按钮**，正好同时证明 3.1.1 合规 |
| 时长 | 60–90s。App Store 预览视频上限 30s（如果要当官方预览），则取镜头 2 + 3 + 4 各 8s 拼成 30s |
| 隐私 | 拍摄内容用**不敏感的车/场景**；客户链接里别出现真实手机号（审核员会看） |

## 两种用途的剪辑建议

**A. 提审"演示录屏"（审核信息里给链接，或 TestFlight 备注）**
- 用完整版 60–90s，重点是把镜头 2/3/4/5 的原生弹窗都拍清楚。

**B. App Store 商品页「App 预览」视频（≤30s）**
- 0–8s：启动屏 + 首页
- 8–16s：相机拍车
- 16–24s：Face ID 解锁
- 24–30s：原生分享面板 + 结尾 logo
- 竖屏 886×1920（或对应机型分辨率），无声音也可（或配轻音乐）。

---

## 上传前自查

- [ ] 全片**没有出现 Safari 地址栏 / Safari 底部工具栏**（一旦出现等于自证是网页）
- [ ] 至少出现 **3 个系统级原生 UI**：相机 / Face ID / 分享面板（+ 通知授权框 = 4 个）
- [ ] 启动屏是品牌主题，不是白屏或网页 favicon
- [ ] 壳内**没有任何价格 / 订阅 / 支付按钮**（3.1.1）
- [ ] 视频里出现的手机号 / 客户信息已脱敏
