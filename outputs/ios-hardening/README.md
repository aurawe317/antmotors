# AutoStock · iOS 原生化加固（提升 App Store 过审率）

目标：把当前「远程加载网页的壳」改造成一眼就是原生 App 的形态，规避 App Store 审核指南
**4.2（最低功能）** 与 **2.5.2（远程 WebView / 仅是网站壳）** 的拒审风险。

当前工程事实（已核实）：
- Capacitor 8.5，依赖走 **Swift Package Manager**（`native/ios/App/CapApp-SPM`），无 Podfile；`npx cap sync ios` 会自动把插件拉进原生工程。
- `native/package.json` **只装了核心**，缺少 Camera / SplashScreen / StatusBar 三个插件。
- `capacitor.config.json` 的 `server.url = https://antmotors.pages.dev`（远程加载）。
- `Info.plist` **缺少相机/相册权限描述**（缺了会在真机首次调相机时崩溃，审核必打回）。
- `AppDelegate.swift` 是空壳，所有原生行为都走默认。
- 前端照片上传全部是 `<input type="file">`，已新增 `pickCarPhotoNative()` 桥接原生相机（网页端自动回落）。

---

## 0. 安装插件（在 Mac 的 `native/` 目录执行）

```bash
cd native
npm install @capacitor/splash-screen@^8 @capacitor/camera@^8 @capacitor/status-bar@^8
npx cap sync ios
```

`cap sync` 会把三个插件写入 SPM 工程、生成 SplashScreen 故事板，并更新 `Info.plist` 的插件权限占位。

---

## 1. SplashScreen（启动屏）—— 消除白屏闪烁

### 1.1 `capacitor.config.json` 增加插件配置
在文件末尾 `}` 前插入（与 `ios` 同级）：

```json
  "plugins": {
    "SplashScreen": {
      "launchShowDuration": 1200,
      "launchAutoHide": false,
      "backgroundColor": "#0f0e0e",
      "androidScaleType": "CENTER_CROP",
      "iosResizeMode": "contain",
      "imageName": "splash",
      "imageResizeMode": "contain"
    }
  }
```

### 1.2 放入启动图素材
把蚂蚁图标（建议 1024×1024 透明 PNG，已放大版不会太糊）放进：
`native/ios/App/App/Assets.xcassets/` 下新建 `splash.imageset/`，
`Contents.json` 引用该图（再补 `splash@2x` / `splash@3x` 更佳）。

### 1.3 网页启动后主动隐藏（关键，针对远程加载）
远程页面加载慢，必须等首屏渲染完再隐藏，否则还是会闪白。
在 `app/index.html` 启动时（DOM ready / 首次数据渲染后）调用：

```js
// 在 app 启动逻辑里，首屏渲染完成后：
if (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.SplashScreen) {
  Capacitor.Plugins.SplashScreen.hide();
}
```
> 找不到合适位置就加在 `syncNow()` 首屏渲染完成那一行之后。

---

## 2. Camera（原生相机）—— 这是「摆脱网页感」最有力的信号

前端桥接 **已完成**（见 `app/index.html` 的 `pickCarPhotoNative()`）：
- 在原生 App 内走 `Capacitor.Plugins.Camera.getPhoto`（弹出系统相机/相册，非网页 `<input>`）；
- 在网页 / PWA 内自动回落到原 `<input type="file">`，互不影响。
- 已接到车辆详情页「+ Photo」按钮与缩略图区的添加格。

### 2.1 必须补的 `Info.plist` 权限描述（否则崩溃 + 拒审）
在 `Info.plist` 的 `<dict>` 内任意位置插入：

```xml
<key>NSCameraUsageDescription</key>
<string>Used to capture and upload vehicle photos</string>
<key>NSPhotoLibraryUsageDescription</key>
<string>Used to select vehicle photos from your library</string>
<key>NSPhotoLibraryAddUsageDescription</key>
<string>Used to save vehicle photos to your library</string>
```

### 2.2 （可选）把其余上传入口也接原生
目前只接了车辆照片。如想更彻底，把 `handleShowroomPhoto`、`previewCoLogo`、
`handleAdminPhotos` 等也改成「先试 `Camera`/`Photos`，失败回落 `<input>`」的同一模式即可。

---

## 3. StatusBar（状态栏）—— 贴合品牌深色主题

### 3.1 网页侧统一设置（推荐，最简单）
在 `app/index.html` 启动处加：

```js
if (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.StatusBar) {
  Capacitor.Plugins.StatusBar.setOverlaysWebView({ overlay: false });
  Capacitor.Plugins.StatusBar.setBackgroundColor({ color: '#0f0e0e' });
  Capacitor.Plugins.StatusBar.setStyle({ style: 'DARK' }); // 浅色文字
}
```

### 3.2 或原生侧（AppDelegate）设置
在 `didFinishLaunchingWithOptions` 里：

```swift
import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // 状态栏底色贴合品牌深色
        application.statusBarStyle = .lightContent
        return true
    }
    // ...其余保持不变
}
```

---

## 4. 额外加分项（让审核员觉得「这是个真 App」）

| 能力 | 插件 | 作用 |
|---|---|---|
| 生物识别登录 | `@capacitor/biometric` | 指纹/面容登录，强原生感 |
| 本地通知 | `@capacitor/local-notifications` | 同步完成、新订单提醒 |
| 设备信息上报 | `@capacitor/device` | 崩溃/机型统计 |
| 二维码扫描 | `@capacitor/barcode-scanner` | 替换现有 `getUserMedia` 扫码（WKWebView 里 `getUserMedia` 不稳，会崩） |

> ⚠️ 你现有「邀请码扫码」用的是 `navigator.mediaDevices.getUserMedia`，在原生 WebView 里不可靠，
> 上架前务必换成 `@capacitor/barcode-scanner`，否则扫码功能在 App 内失效。

---

## 5. 必须同步改掉的「网页感」细节

- [ ] `app/index.html` 里残留的 `apple-mobile-web-app-title` 仍是 **"Ant Motors"** → 统一为 **AutoStock**（与商店名一致，否则审核员会觉得名实不符）。
- [ ] `capacitor.config.json` 的 `ios.scheme` 仍是 `AntMotors` → 改成 `AutoStock`（影响 URL Scheme / 深链）。
- [ ] 确保所有 App 内链接**不弹去 Safari**（网页壳典型特征）：用 `InAppBrowser` 或拦截处理。
- [ ] 商店描述强调「车商库存/成交管理工具、支持离线、团队协作、拍照上传」，而非「网站」。

---

## 6. 远程加载的根本取舍（重要决策）

当前 `server.url` 远程加载是审核最大的雷。两条路：

**A. 保留远程（推荐你们先走）**
内容改完即时生效、不用重新审核，适合加纳车商快迭代。
靠「原生壳 + 权限描述 + 原生相机/状态栏 + 描述规避」多数能过 4.2。

**B. 改本地打包**
把 `app/index.html` 打进 App 包（`server.url` 去掉，改 `webDir` 本地加载），
牺牲热更新换审核最稳。若 A 被拒两次以上，再切 B。

---

## 7. 验证清单（Mac 上 Xcode 跑一遍）

1. `cd native && npx cap sync ios`
2. Xcode 打开 `native/ios/App/App.xcworkspace`
3. 真机运行 → 确认：启动有品牌启动屏（无白闪）、拍照走系统相机、状态栏深色、无 Safari 跳转。
4. 首次调相机应弹出权限询问（来自 `Info.plist` 描述）。
5. 之后 `Product → Archive` 上传 App Store Connect。
