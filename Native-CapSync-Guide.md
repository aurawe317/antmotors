# Antoto 原生壳 `cap sync` 操作手册

> 给执行 Xcode / 原生集成的同学。目标：把仓库里已写好的 JS 调用点真正激活，并让 App Store 4.2 审核看到原生能力。
>
> **当前状态（2026-10-13 17:55 已全部落地并验证）**：
> - ✅ 7 个插件已安装，`npx cap sync ios` 已跑
> - ✅ `xcodebuild -resolvePackageDependencies` 解析出 11 个包
> - ✅ **完整编译 `BUILD SUCCEEDED`**（iOS Simulator，arm64 + x86_64）
> - ⏳ 只剩 Xcode 侧人工项：Push Notifications capability + APNs .p8

---

## 0. 先说四个必须知道的坑

### 🔴 坑 1（最重要）：这个工程走 **SPM**，不是 CocoaPods

`native/ios/App/` 下存在 `CapApp-SPM/` 目录，Capacitor CLI 的 `determinePackageManager()`
看到它就返回 `'SPM'`，于是：

- **`npx cap sync ios` 永远不会调 `pod install`**
- 它改为重写 `ios/App/CapApp-SPM/Package.swift`，把每个插件以**本地 SPM 包**接入
- 原来的 `ios/App/Podfile` 是**完全无效的死文件**（已删除）

判断依据（可自查）：
```bash
ls native/ios/App/CapApp-SPM/        # 存在 → SPM 模式
grep -c "Pods_" native/ios/App/App.xcodeproj/project.pbxproj   # 0 → 从没用过 Pods
```

> **推论：这个工程不需要 CocoaPods。** Homebrew + cocoapods 装了也不亏（通用工具），
> 但对本项目是多余的。别再按老教程去找 `Podfile` / `pod install` 了。

### 🔴 坑 2：`@capacitor-community/biometric` 在 npm 上已 404（不存在）

它是被废弃的旧包。继任者是 **`@capgo/capacitor-native-biometric`**，注册名是
`Capacitor.Plugins.NativeBiometric`（不是 `.Biometric`）。JS 侧已改成**两种名字都接受**
（`biometricPlugin()` helper，v1.2.125），所以你装哪个都不会失效。

### 🔴 坑 3：`server.url` **不能**带 `?company=`（2026-10-16 反转定论，别再加回去）

`server.url` 远程加载有个容易漏的后果：**改 `app/index.html` 只需 push GitHub，壳里立刻变，
不需要 `cap sync`**。`cap sync` 只在「加了/删了原生插件」或「改了 `capacitor.config.json`」时才需要跑。

**裸 `https://antoto.app` 是平台域名，没有租户**。后端 `resolveCompanyId()` 的解析顺序是：

```
?ref=  ▸  ?company=  ▸  companyByHost(hostname)  ▸  登录员工
```

四者皆空就返回 `{"company":null,"cars":[]}`。前端 `bootstrap()` 只有在 URL 带 `ref`/`company`
时才会调 `/api/public/cars?company=...`，否则只能从 `?c=` 详情反推——推不出就是空。

**🔴 10-14 曾据此给 `server.url` 加过 `?company=co_a4812811971e`（commit `d57a387`），10-16 已撤销**。
加参数的代价（实测）：`?company=` 会置 `sharedCompany` → `onTenantDomain()` 未登录时返 true
（`index.html:6064-6086`）→ 客户守卫把 `#welcomeBar`（Login/Register CTA）和 demo 元素**全部隐藏**
→ 壳一打开就是某公司展厅且**没有任何登录入口**，多租户平台 App 沦为「Ant Motors 客户专供」。

**当前定稿配置（裸域，登录优先）**：

```jsonc
"server": {
  "url": "https://antoto.app/",                  // ← 裸平台域，绝不带 ?company=
  "allowNavigation": [ /* 原样不动，同一 origin */ ],
  "cleartext": false
}
```

- 未登录 = 平台入口（welcomeBar 显示登录/注册）→ 登录后按「登录员工」解析租户 → 各家员工看各家数据
- 代价：裸域无租户时 hero 空（"No showrooms added yet"）——两害相权取「登录优先」
- 🔴 **审核员演示账号（Marina staff id + PIN）因此成为提审硬性阻塞**，提审前必须拿到
- 参数安全性（如将来再加参数）：全 App **零 `pushState` / `replaceState` / `history.`** 调用，
  两条 SW reload 路径都走 `location.reload()`（保留完整 URL）→ 参数永远不会被 SPA 抹掉

实测数据（URL → 公开车辆数）：

| URL | 结果 |
|---|---|
| `antoto.app/api/public/cars` | `{"company":null,"cars":[]}` — **0 台** |
| `antoto.app/api/public/cars?company=co_a4812811971e` | company 解析成功 — **30 台** |
| `antmotors.autos/api/public/cars` | company 解析成功 — 30 台 |

> ⚠️ 改这个字段后**必须重跑 `npx cap sync ios`**（它会重新生成 `ios/App/App/capacitor.config.json`），
> 然后在 Xcode 里重新 build。仅改 `app/index.html` 才不需要 sync。

### 🟠 坑 4：SPM 模式下，插件根目录**必须**有 `Package.swift`

`cap sync` 里的 `checkPluginsForPackageSwift()` 会过滤：没有 `Package.swift` 的插件
**被静默剔除**，只打一句 `Some installed Capacitor plugins are not compatible with SPM`。
装完插件后务必自查（本项目 7/7 已通过）：

```bash
for p in @capacitor/camera @capacitor/share @capacitor/filesystem \
         @capacitor/push-notifications @capacitor/splash-screen \
         @capacitor/status-bar @capgo/capacitor-native-biometric; do
  [ -f "native/node_modules/$p/Package.swift" ] && echo "✅ $p" || echo "❌ $p"
done
```

---

## 1. 版本基线（已安装，2026-10-13 核实）

`native/package.json` 当前是 **Capacitor `^8.5.0`**（core/cli/ios/android）。
所有插件对齐 **v8**。

| 插件 | 已装版本 | 用途 |
|---|---|---|
| `@capacitor/camera` | `8.2.5` | 车源拍照 / 相册多选 |
| `@capacitor/share` | `8.0.3` | 原生分享面板（v1.2.122） |
| `@capacitor/filesystem` | `8.1.4` | 导出备份写设备「文件」（v1.2.124） |
| `@capacitor/push-notifications` | `8.1.3` | APNs 注册（v1.2.124） |
| `@capacitor/splash-screen` | `8.0.2` | 品牌启动屏（4.2 去网页感） |
| `@capacitor/status-bar` | `8.0.4` | 状态栏主题 |
| `@capgo/capacitor-native-biometric` | `8.8.2` | Face ID / Touch ID 解锁（v1.2.123/125） |

---

## 2. 装插件（已完成）

```bash
cd native
npm i @capacitor/camera@8.2.5 @capacitor/share@8.0.3 @capacitor/filesystem@8.1.4 \
      @capacitor/push-notifications@8.1.3 @capacitor/splash-screen@8.0.2 \
      @capacitor/status-bar@8.0.4 @capgo/capacitor-native-biometric@8.8.2
```

实际执行结果：`added 8 packages`（7 插件 + 1 个传递依赖）。

---

## 2.5 附：CocoaPods（本项目不需要，仅备用）

**本工程是 SPM 模式，`cap sync` 不调用 `pod install`，所以不需要 CocoaPods。**

如果将来遇到**别的**需要 CocoaPods 的工程，在 macOS 26 + Xcode 27 上：

🔴 **不要用 `sudo gem install cocoapods`**（老教程写法）。系统 Ruby 2.6.10 上必然失败：

```
make: *** No rule to make target .../ruby-2.6.0/universal-darwin25/ruby/config.h
ffi requires Ruby version >= 3.0, < 4.1.dev. The current ruby version is 2.6.10
```

原因：头文件目录实际是 `universal-darwin26` 而 gem 编译时找 `universal-darwin25`，
且新版 gem（ffi / activesupport / nkf）纷纷要求 Ruby ≥ 3.0。锁旧版是打地鼠，
且 2023 年的 CocoaPods 解析不了 Xcode 27 工程格式。

**正确做法：Homebrew 装预编译版（不做任何编译）**

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
eval "$(/opt/homebrew/bin/brew shellenv)"
brew install cocoapods
pod --version
```

（本机已于 2026-10-13 装好 Homebrew 7.0.9 + cocoapods 1.17.0，但**本项目用不到**。）

---

## 3. 同步到 iOS（已完成）

```bash
cd native && npx cap sync ios
```

**SPM 模式下 `cap sync` 实际做四件事：**

1. 把 `webDir`（`../app`）拷进 `ios/App/App/public`
2. 重新生成 `ios/App/App/capacitor.config.json`
3. 把每个插件的 `Package.swift` 里 `from:` 版本号打补丁对齐 Capacitor 大版本（`8.0.0`）
4. **重写 `ios/App/CapApp-SPM/Package.swift`**，把 7 个插件加成本地 SPM 包

实际执行输出：

```
✔ Copying web assets from app to ios/App/App/public in 224.97ms
✔ Creating capacitor.config.json in ios/App/App in 12.73ms
✔ Updating iOS plugins in 359.34ms
[info] All Capacitor plugins have a Package.swift file and will be included in Package.swift
[info] Found 7 Capacitor plugins for ios:
       @capacitor/camera@8.2.5
       @capacitor/filesystem@8.1.4
       @capacitor/push-notifications@8.1.3
       @capacitor/share@8.0.3
       @capacitor/splash-screen@8.0.2
       @capacitor/status-bar@8.0.4
       @capgo/capacitor-native-biometric@8.8.2
✔ update ios in 3.70s
```

打开工程：

```bash
npx cap open ios
```

---

## 3.5 已验证：依赖解析 + 完整编译（2026-10-13）

这两条是**硬证据**，比任何"应该可以了"都可靠：

```bash
cd native/ios/App

# ① 解析 SPM 依赖（不需要签名）
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -project App.xcodeproj -scheme App -resolvePackageDependencies
```

解析结果（11 个包全中）：

```
Resolved source packages:
  IONCameraLib: https://github.com/ionic-team/ion-ios-camera.git @ 2.0.0
  IONFilesystemLib: https://github.com/ionic-team/ion-ios-filesystem.git @ 2.0.0
  capacitor-swift-pm: https://github.com/ionic-team/capacitor-swift-pm.git @ 8.5.0
  CapacitorCamera / CapacitorFilesystem / CapacitorPushNotifications / CapacitorShare /
  CapacitorSplashScreen / CapacitorStatusBar / CapgoCapacitorNativeBiometric  @ local
  CapApp-SPM @ local
```

```bash
# ② 完整编译（iOS Simulator，不需要签名）
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -project App.xcodeproj -scheme App \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/antoto-dd build
```

结果：**`** BUILD SUCCEEDED **`**（arm64 + x86_64，无 error）

> ⚠️ 本机 `xcode-select` 指向的是 CommandLineTools，直接跑 `xcodebuild` 会报
> `tool 'xcodebuild' requires Xcode`。用 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`
> 前缀即可，不必 `sudo xcode-select -s` 改系统设置。

---

## 4. Xcode 里必改（漏一个就崩或审核被拒）

### 4.1 Info.plist 权限描述（✅ 已完成）

`ios/App/App/Info.plist` 已含四项，2026-10-12 用 `plistlib` 校验过：

```xml
<key>NSCameraUsageDescription</key>
<string>Antoto uses the camera to photograph vehicles for your inventory.</string>
<key>NSPhotoLibraryUsageDescription</key>
<string>Antoto needs your photo library to attach vehicle photos.</string>
<key>NSPhotoLibraryAddUsageDescription</key>
<string>Antoto saves exported backups to your photo library.</string>
<key>NSFaceIDUsageDescription</key>
<string>For an easier and faster log in.</string>
```

### 4.2 推送能力（⏳ 待人工，不配 = 注册静默失败）

Xcode → 选中 `App` target → **Signing & Capabilities** → **+ Capability** → **Push Notifications**。

同时需要一枚 **APNs Auth Key（.p8）**：
- Apple Developer → Certificates, Identifiers & Profiles → Keys → 新建 → 勾选
  **Apple Push Notifications service (APNs)** → 下载 `.p8`，记下 **Key ID** 和 **Team ID**。
- ⚠️ 这把 key 是给**服务端发推送**用的。见第 7 节——目前我们只做到
  「注册 + 存 token」，**还不能真的发出推送**。

### 4.3 启动屏 / 状态栏主题（✅ 已完成，v1.2.126）

`native/capacitor.config.json` 已追加 `plugins` 段（`appId` / `server.url` /
`allowNavigation` / `ios.scheme` 四个定稿字段一字未动）：

```jsonc
"plugins": {
  "SplashScreen": {
    "backgroundColor": "#0F0E0E",
    "showSpinner": false,
    "launchAutoHide": true,
    "launchShowDuration": 600,
    "launchFadeOutDuration": 300,
    "androidScaleType": "CENTER_CROP"
  },
  "StatusBar": {
    "style": "DARK",
    "backgroundColor": "#0F0E0E"
  }
}
```

> 品牌色是 `#0F0E0E`（深） / `#E8C268`（金）。⚠️ 早期草稿写的 `#E9C46A` 是错的，以 CSS 变量为准：
> `[data-theme="dark"] --bg:#0F0E0E; --gold:#E8C268` / `[data-theme="light"] --bg:#F4F2ED; --gold:#B8902F`。

#### 🔴 两个反直觉知识点（配错就是可见缺陷）

**① Capacitor StatusBar 的命名和直觉相反**（`StatusBarPlugin.swift` 的 `style(fromString:)`）：

```
case "dark", "lightcontent":  return .lightContent   // "DARK" → 白字（深色底用）
case "light", "darkcontent":  return .darkContent    // "LIGHT" → 黑字（浅色底用）
```

**② `<meta name="apple-mobile-web-app-status-bar-style">` 在 Capacitor 壳里完全无效。**
那是 Safari/PWA 机制。App 原有的 `applyTheme()` 只改这个 meta，在壳里等于什么都没做——
所以 v1.2.126 在 `applyTheme()` 末尾加了真正的挂钩：

```js
try{
  const SB=(window.Capacitor&&Capacitor.Plugins&&Capacitor.Plugins.StatusBar)?Capacitor.Plugins.StatusBar:null;
  if(SB) SB.setStyle({style: curTheme==='dark' ? 'DARK' : 'LIGHT'});
}catch(e){}
```

**为什么不能只配静态原生样式**：`amTheme` 默认 `'system'`，新装用户跟随设备，而多数 iPhone
默认浅色。静态配深色 → 浅色用户全程白字白底；静态配浅色 → 深色用户全程黑字黑底。
两种都是「时钟电量看不见」，且持续整个会话。必须让 JS 跟着主题走。

调用有 `window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.StatusBar` 守卫 +
`try/catch`，浏览器/PWA 走原 meta 路径，行为零变化。

#### 启动链（三层，别搞混谁先谁后）

```
iOS LaunchScreen.storyboard   ← Splash logo + systemBackgroundColor（系统渲染，App 未启动）
        ↓
Capacitor SplashScreen        ← 上面配置的 backgroundColor #0F0E0E（运行时可配）
        ↓
WebView                       ← app 自己的主题
```


---

## 5. 验证插件真的生效（关键一步）

装完一定要验，否则你录的屏还是网页形态。两种方式：

**A. Safari Web Inspector（推荐，无需改代码）**
- iPhone：设置 → Safari → 高级 → 打开「网页检查器」；Mac Safari：开发 → [你的 iPhone] → Antoto。
- Console 里执行：

```js
JSON.stringify(Object.keys(Capacitor.Plugins))
```

期望看到：`["App","Camera","Share","Filesystem","PushNotifications","SplashScreen","StatusBar","NativeBiometric", ...]`
**如果 `NativeBiometric` / `Camera` 不在列表里，说明插件没装上。**

**B. 直接看行为**
- 点新增车辆的拍照区 → 应弹**系统相机 / 操作表**（不是文件选择对话框）。
- 登录页应出现「🔓 Unlock (Face ID / fingerprint)」按钮。
- 点分享 → 应弹 iOS **Share Sheet**（AirDrop / 信息 / WhatsApp）。

---

## 6. 装完后按脚本录屏

插件的唯一目的就是让 `AppStore-Recording-Script.md` 的镜头能拍出来。装完立刻验第 5 节，确认后按脚本录：

1. 冷启动（启动屏）→ 2. 📷 相机拍车 → 3. Face ID 解锁 → 4. 原生分享面板 → 5. 导出备份到「文件」→ 6. 业务闭环 → 7. 推送授权框。

⚠️ 录屏务必用**真机 + iPhone 自带屏幕录制**，不要用 Mac 投屏（会有边框痕迹，审核员认得出来）。

---

## 7. 关于推送的真相（别被"装好了"误导）

`/api/device` 端点和 `registerPush()` 已完成，能：
- ✅ 申请推送权限
- ✅ 注册 APNs 并把 device token 存到 `employees.data.devices`

**还不能**：
- ❌ 真正把通知发给用户——这需要服务端拿 APNs `.p8` key 去调 Apple 服务器，**这套发送逻辑还没写**。

所以推送目前的价值**仅限 4.2 审核**（证明 App 注册了 APNs、会弹系统授权框）。如果要真推送，下一步是加一个 `functions/api/push-send` 端点，用 `jsonwebtoken` + APNs HTTP/2 发送。需要的话说一声，我可以写。

---

## 8. 已清除：Alipay 死代码（2026-10-13）

原生工程里曾有一批 2026-09-29 留下的 Alipay 集成，**在 SPM 模式下从来就不成立**：

| 文件 / 位置 | 原状 | 处理 |
|---|---|---|
| `ios/App/App/SceneDelegate.swift` | `import AlipaySDK` + 注册 `AlipayPlugin` + 处理支付回调 URL | ✅ 已还原成标准 Capacitor SceneDelegate |
| `ios/App/App/AlipayPlugin.swift` | 自定义 CAPPlugin，`import AlipaySDK` | ✅ 已删除（从未被 pbxproj 引用，是死文件） |
| `ios/App/Podfile` | 仅含 `pod 'AlipaySDK-iOS'` | ✅ 已删除（SPM 模式下无效） |

**为什么必须删：**
1. 🔴 **编译硬阻断**：`SceneDelegate.swift` 在 `PBXSourcesBuildPhase` 里，`import AlipaySDK`
   但工程里根本没有这个模块（无 Pods、无 SPM 依赖、无 framework）→ `No such module 'AlipaySDK'`。
   工程从 2026-09-29 起就编不过。
2. 🔴 **3.1.1 合规风险**：壳内原生支付数字订阅 = 直接踩 3.1.1。v1.2.121 已 gate 掉壳内购买入口，
   再留一条原生支付路径是纯负债。
3. `app/index.html` 里的 `Capacitor.Plugins.Alipay` 调用有**存在性守卫**
   （`if(... && Capacitor.Plugins && Capacitor.Plugins.Alipay)`），插件不存在时自动回落到
   网页支付链接，**删原生侧对 web 端零影响**。

---

## 9. 常见坑速查

| 现象 | 原因 / 解法 |
|---|---|
| `xcodebuild: requires Xcode` | `xcode-select` 指向 CLT；加 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` 前缀 |
| `cap sync` 后插件没生效 | 插件根目录缺 `Package.swift`（见坑 4）→ SPM 静默剔除 |
| 编译报 `No such module 'XXX'` | 该模块没接入。本项目只走 SPM，别去改 Podfile |
| 调相机立刻闪退 | Info.plist 缺 `NSCameraUsageDescription`（见 4.1） |
| Face ID 按钮不出现 | `Capacitor.Plugins` 里没有 `NativeBiometric` → 插件没装上；或本机没登录过（未 enrol） |
| 分享弹的是网页内面板 | `@capacitor/share` 没装，走了 `navigator.share` 回退 |
| 改了 `app/index.html` 壳里没变 | `server.url` 远程加载，需要 GitHub push + CF 部署，**不是** `cap sync` |
| 导出备份 toast 没有 `· Files` 后缀 | `@capacitor/filesystem` 没装，走了网页下载回退 |
| 壳里还能看到价格/购买按钮 | 不可能——v1.2.121 已 gate 掉；若看到说明跑的是 Safari 不是壳 |
| 状态栏时钟/电量看不见（同色） | Capacitor StatusBar 命名反直觉：`"DARK"`=白字、`"LIGHT"`=黑字；且 meta 方案在壳里无效，必须走 `StatusBar.setStyle()`（见 4.3） |
| 冷启动闪一下白屏/反色 | SplashScreen `backgroundColor` 没配，或与 App 当前主题不一致（见 4.3 启动链） |
| 首次打开 Xcode 卡在 "Resolving Packages" | 在从 GitHub 拉 `capacitor-swift-pm` / `ion-ios-camera` / `ion-ios-filesystem`，需要联网，等一会 |
| 🔴 **打开了错误的工程**（Xcode 最近项目列表里的 `AntMotors`） | 那是个 8 月初的废工程：`~/WorkBuddy/2026-08-02-18-29-06/ant-original/AntMotors-source/`，`AntMotors.xcodeproj` 在根目录、Objective-C、`www/` 多文件、**零插件**。一律用 `cd native && npx cap open ios`，或手动开 `native/ios/App/App.xcodeproj` |
| 🔴 **壳里首页是空的**（hero 黑块、"No showrooms added yet"） | 未登录 + 平台域名无租户 = 预期现象（坑 3 反转定论）。**先登录**，登录后按员工解析租户即有数据；若登录后仍空才是真故障 |
| 🔴 **壳里没有登录入口**（打开就是某公司展厅） | `server.url` 被加了 `?company=` → 客户守卫隐藏 welcomeBar。见坑 3，**删掉参数** |

---

## 10. 一页流程总结（现状）

```
✅ npm i (7 个插件)                       2026-10-13 完成
✅ npx cap sync ios                       2026-10-13 完成，7 插件全识别
✅ xcodebuild -resolvePackageDependencies  11 个包解析成功
✅ xcodebuild build                        BUILD SUCCEEDED
✅ Info.plist 四项权限                     2026-10-12 完成
✅ Alipay 死代码清除                       2026-10-13 完成
✅ SplashScreen/StatusBar 配置 + 状态栏挂钩  2026-10-14 完成（v1.2.126）
✅ 发布：commit 8f46cde，两域名 app-1.2.126，首页 md5 8696790…（591350 字节一致）
⏳ Xcode: Push Notifications capability + APNs .p8      ← 唯一剩余人工项
⏳ 验 Capacitor.Plugins 列表（第 5 节 A）
⏳ 按 AppStore-Recording-Script.md 录屏
```

> 验证 harness：`/tmp/am-statusbar.cjs`(42)、`am-device.cjs`(17)、`am-bio.cjs`(19)、
> `am-native.cjs`(7)。发版后全跑一遍。
