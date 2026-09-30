# Antoto 移动端 UI 优化方案（黑金深色版）

## 设计原则
- **保留现有黑金深色配色**：`#0F0E0E` 背景、`#171615` 卡片、`#E8C268` 金色强调。
- **不改动业务逻辑**：仅调整视觉层（CSS / 结构微调），所有数据、权限、支付、同步逻辑保持原样。
- **统一设计语言**：圆角、间距、按钮状态、空状态、骨架屏、点击反馈全面对齐。
- **中英双语**：所有标签保留 `data-i18n`，界面元素在中文/英文下自动适配。

---

## 全局 Design Tokens（更新后）

| Token | 旧值 | 新值 | 说明 |
|---|---|---|---|
| `--r-card` | 8px | **12px** | 卡片/面板圆角统一 |
| `--r-btn` | 4px | **10px** | 按钮/输入框圆角统一 |
| `--r-chip` | 8px | **8px** | 小标签圆角（保持不变） |
| `--r-pill` | 999px | 999px | 胶囊按钮 |
| `--page-pad` | 0 / 16px 混用 | **16px** | 所有页面水平内边距统一 |
| `--card-pad` | 多变 | **12px** | 卡片内部统一 |
| `--gap-sm` | 4px | **8px** | 小间距 |
| `--gap-md` | 多变 | **12px** | 中间距 |
| `--gap-lg` | 多变 | **20px** | 大间距（section 之间） |
| `--row-h` | 多变 | **44px** | 标准行高/输入框高度 |
| `--shadow-card` | 无/弱 | `0 8px 24px rgba(0,0,0,.28)` | 卡片投影增强层次 |
| `--active-scale` | 无 | `.96`（:active） | 点击反馈 |

### 颜色（保持现有）
- `--bg:#0F0E0E`
- `--surface:#171615`
- `--surface-2:#1F1D1B`
- `--border:rgba(245,243,239,0.10)`
- `--border-strong:rgba(245,243,239,0.18)`
- `--text:#F5F3EF`
- `--text-dim:#A9A39A`
- `--gold:#E8C268`
- `--gold-soft:rgba(232,194,104,0.14)`
- `--gold-line:rgba(232,194,104,0.35)`

### 字号层级
- 页面标题：`20px / font-weight:800`
- 卡片标题：`15px / font-weight:700`
- 正文/输入文字：`14px / font-weight:400`
- 小标签/辅助：`12px / font-weight:600`（金色/灰色）
- 价格大字：`18px / font-weight:800`

### 按钮状态规范
| 类型 | 默认 | Hover/Press | Disabled |
|---|---|---|---|
| Primary（金色） | `bg:#E8C268; color:#0F0E0E` | `filter:brightness(1.08); transform:scale(.97)` | `opacity:.45` |
| Secondary（描边） | `bg:transparent; border:1px solid var(--border-strong); color:var(--text)` | `bg:var(--surface-2)` | `opacity:.45` |
| Ghost（文字） | `bg:transparent; color:var(--gold)` | `color:#fff` | `opacity:.45` |

---

## 1. 首页（Home / scr-home）

### 改动清单
1. **欢迎横幅**
   - 圆角 12px → 保持，但降低视觉重量：背景改为 `var(--surface)` + 1px `var(--gold-line)` 边框，内部 padding 12px。
   - 标题 `font-size:15px font-weight:800`，描述 `12px/1.5`，按钮改为全宽描边金色（避免实心块压迫感）。

2. **Hero 轮播**
   - 圆角 16px（占满内容区），图片底部加 60% 黑色渐变 scrim，保证白色标题可读。
   - 指示点尺寸 8px → 6px 实心圆，当前点金色，非当前 30% 透明度。
   - 增加自动轮播手势提示（底部小点 + 左右边缘 12px 阴影）。

3. **搜索栏**
   - 高度 44px，圆角 10px，背景 `var(--surface-2)`，聚焦时 1px 金色边框。
   - 搜索图标 18px 居中左 12px，placeholder 颜色 `var(--text-faint)`。

4. **筛选条**
   - 改为横向可滚动胶囊：`padding 8px 12px`、`border-radius:999px`。
   - 默认状态：透明背景 + 1px border；激活状态：金色背景 + 深色文字。
   - “Advanced” 按钮改为右侧固定入口图标，避免与其他筛选器拥挤。

5. **Section 标题**
   - 统一结构：`h2 15px/700` + 右侧 “See all” 金色 12px，上下 margin 20px/10px。
   - 去除 `sec-head` 与内容之间的多余缝隙。

6. **展厅横向滚动**
   - 卡片宽度 140px，高度 96px，圆角 12px，内部图片 `object-fit:cover`。
   - 店名 12px/700 两行截断，地址 11px/400 灰色。
   - 增加 8px 卡片间距。

7. **车辆网格**
   - 2 列，gap 12px；卡片圆角 12px，背景 `var(--surface)`，1px border。
   - 封面图 16:10，价格 `18px/800`，车型 `14px/700`，车况/年份 `12px/400` 灰色。
   - 空状态：中央 120px 车辆轮廓插图 + “No cars match” 14px + 重置按钮。

8. **骨架屏**
   - 车辆卡片加载态：灰色占位块（`background:var(--surface-2)`）+ 金色 shimmer 动画（`linear-gradient(90deg, transparent, rgba(232,194,104,.08), transparent)`）。

9. **销售顾问卡片**
   - 圆角 12px，padding 12px，头像 44px，WhatsApp 按钮改为金色描边胶囊。

10. **点击反馈**
   - 所有可点击卡片/按钮 `:active { transform:scale(.97); transition:.12s ease }`。

### 开发实现要点
```css
/* 全局 press feedback */
.card, .btn, .chip, .pill-btn, .icon-btn { transition:transform .12s ease, background .15s ease; }
.card:active, .btn:active, .chip:active, .pill-btn:active, .icon-btn:active { transform:scale(.97); }

/* 骨架屏 shimmer */
@keyframes shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
.skeleton { background:linear-gradient(90deg,var(--surface-2),rgba(232,194,104,.08),var(--surface-2)); background-size:200% 100%; animation:shimmer 1.2s infinite; }

/* 搜索栏统一 */
.search { height:44px; border-radius:10px; background:var(--surface-2); padding:0 12px; display:flex; align-items:center; gap:10px; }
.search input { flex:1; background:transparent; border:none; color:var(--text); font-size:14px; }
.search input:focus { outline:none; }
.search:focus-within { box-shadow:0 0 0 1px var(--gold); }

/* 筛选胶囊 */
.filter-pill { height:32px; padding:0 14px; border-radius:999px; border:1px solid var(--border); background:transparent; color:var(--text); font-size:12px; font-weight:600; white-space:nowrap; }
.filter-pill.on { background:var(--gold); color:#0F0E0E; border-color:var(--gold); }
```

---

## 2. 我的（Me / scr-me）

### 改动清单
1. **个人资料头**
   - 背景改为 `var(--surface)` 卡片 12px 圆角，padding 16px。
   - 头像 64px → 72px，金色 1px ring，姓名字号 18px/800，副标题 13px/400 灰色。
   - 会员状态徽章改为金色胶囊：`padding 4px 10px; border-radius:999px; background:var(--gold-soft); color:var(--gold); font-size:11px`。

2. **分组卡片**
   - 所有 `.grp` 统一：`background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:12px; margin:0 0 12px;`。
   - 卡片标题 `.lbl`：`font-size:12px; font-weight:800; color:var(--text); margin-bottom:8px; text-transform:uppercase; letter-spacing:.5px;`。

3. **表单行**
   - 统一行结构：`label 12px/600`（灰色）+ `input 44px`（圆角 10px，背景 `var(--surface-2)`，1px border）。
   - label 与 input 间距 6px，行与行间距 12px。
   - 密码框眼睛图标右对齐，44x44 热区。

4. **登录/注册切换**
   - 将 “New here? Create an account” 从实心金色按钮改为顶部段选器（Segmented Control），减少色彩噪音。
   - 段选器高度 36px，圆角 10px，选中金色背景。

5. **功能列表（me-links）**
   - 行高 56px，图标 22px 金色，右箭头 16px 灰色。
   - 移除底部多余 margin，统一 1px 分隔线（最后一个不显示）。
   - 增加 `:active` 背景 `var(--surface-2)`。

6. **密码强度条**
   - 4 段进度条，每段 8px 圆角，填充色从灰到金。

7. **空状态/未登录**
   - 头像处显示默认汽车图标，CTA 按钮全宽金色，提示文字居中。

### 开发实现要点
```css
.grp { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:12px; margin:0 0 12px; }
.form-row { display:flex; flex-direction:column; gap:6px; margin-bottom:12px; }
.form-row label { font-size:12px; font-weight:600; color:var(--text-dim); }
.form-row input, .form-row select { height:44px; border-radius:10px; background:var(--surface-2); border:1px solid var(--border); color:var(--text); padding:0 12px; font-size:14px; }
.form-row input:focus, .form-row select:focus { border-color:var(--gold); outline:none; }
.me-link { height:56px; display:flex; align-items:center; gap:12px; padding:0 4px; border-bottom:1px solid var(--border); }
.me-link:last-child { border-bottom:none; }
.me-link:active { background:var(--surface-2); border-radius:10px; }
```

---

## 3. 车辆详情（Car Detail / scr-detail）

### 改动清单
1. **Hero 图片区**
   - 全宽，底部圆角 16px，高度 280px，图片底部渐变 scrim。
   - 状态角标移到右上角，`cond-badge` 改为 10px 圆角小胶囊，字号 11px。
   - 缩略图条高度 64px，间距 8px，当前选中 2px 金色边框。

2. **标题区**
   - 品牌/型号 `20px/800`，车况徽章 `11px/700` 金色描边，与标题基线对齐。
   - **副标题修复：仅保留 `年份 · 车况 · 车型 · 门店`，不再重复发动机/变速箱/里程。**

3. **修复参数重复文字 bug**
   - 当前 `dSub` 可能包含发动机/变速箱/里程/燃料（与 `specGrid` 重复）。
   - **修复**：`carSub()` 只输出 `[year, cond, body, branch]`；spec 信息只由 `specGrid` 输出。
   - 若 `c.sub` 中有 spec 类 token，在解析/保存时迁移到 `c.specs`。

4. **价格区**
   - 售价 `28px/800` 金色，下方 Floor A/B/成本用 4 行列表，标签 12px 灰色，数值 14px 白色。
   - 价格表背景 `var(--surface)`，12px 圆角，padding 12px。

5. **参数网格**
   - 2 列，gap 8px，每项背景 `var(--surface-2)`，圆角 10px，padding 10px 12px。
   - label 11px/600 全大写灰色，value 13px/500 白色。
   - 值超长时截断并显示 `…`。

6. **亮点**
   - 横向滚动 chip：`border:1px solid var(--gold-line); background:var(--gold-soft); color:var(--gold); border-radius:999px; padding:6px 12px; font-size:12px;`。
   - 间距 8px。

7. **位置/库存信息**
   - 合并为一个信息卡片，12px 圆角，图标 + 文字 + 右箭头结构。

8. **底部 Sticky CTA**
   - 高度 56px，背景 `var(--surface)` + 顶部 1px border。
   - “Book Viewing” 主按钮 flex:1，金色；WhatsApp 按钮 56x56 描边方形。

9. **更多车辆**
   - 改为横向滚动卡片（与首页 grid 一致风格），避免长列表压垮。

### 开发实现要点
```js
// 修复重复参数：carSub 只输出基础信息
function carSub(c){
  if(curLang !== 'zh'){
    if(c.sub) return c.sub;          // 如果有自定义副标题，只应包含基础信息
    return [c.year, c.cond, c.body, c.loc && c.loc.name].filter(Boolean).join(' · ');
  }
  if(c.subZh) return c.subZh;
  return (c.sub||'').split(' · ').map(t => translateToken(t)).join(' · ');
}

// 解析时：把 engine/transmission/mileage/fuel 等 token 从 c.sub 移到 c.specs
// 新增一个清洗函数，避免 smart-paste 把 spec 写进 sub
function sanitizeSub(c){
  const basicTokens = new Set(['year','cond','body','loc']);
  // 具体实现视 parsePaste 逻辑而定
}
```

---

## 4. 新增车辆（Add Car / scr-admin）

### 改动清单
1. **移除右下角悬浮加号按钮**
   - 删除 `#addFab` 元素及 `.fab-add` 样式。
   - 顶部 Appbar 右侧增加“取消”/“保存”文字按钮（保存为金色主按钮）。

2. **表单分区卡片化**
   - 基本信息、价格、照片视频、预览 分成 4 个 `.grp` 卡片，间距 12px。
   - 卡片标题统一 12px/800 全大写。

3. **Smart Paste 区**
   - 高度 120px，圆角 10px，背景 `var(--surface-2)`，placeholder 字号 13px。
   - 增加“AI 自动识别”小标签（金色 pill），提示用户粘贴描述即可。

4. **字段网格**
   - 移动端单列，桌面/Web 预览 2 列：`display:grid; grid-template-columns:repeat(auto-fit, minmax(140px,1fr)); gap:12px;`。
   - 输入框统一 44px 高，10px 圆角，12px 内边距。

5. **价格分级**
   - 改为 2x2 网格（移动）/ 4 列（桌面），每个价格字段独立卡片式背景。
   - 标签带角色 Tag：`boss` 红色，`manager` 金色，`sales` 灰色。

6. **照片/视频上传**
   - 上传区域 120px 高，2px 虚线边框 `var(--border-strong)`，12px 圆角，内部图标 + 提示文字。
   - 预览缩略图 72px 圆角 8px，水平滚动，删除按钮右上角 20px 圆形。

7. **双语预览**
   - 单独卡片，EN/ZH 并排输入框，label 用金色小字。

8. **保存按钮**
   - 页面底部固定主按钮，56px 高，全宽，保存中显示 spinner + “Saving…”。

### 开发实现要点
```html
<!-- 移除 -->
<button class="fab-add" id="addFab" ...>...</button>
```

```css
/* Appbar 右上角动作 */
.appbar-actions .action-save { color:var(--gold); font-weight:700; font-size:14px; }
.appbar-actions .action-cancel { color:var(--text-dim); font-size:14px; }

/* 表单分组 */
.af-grid { display:grid; grid-template-columns:1fr; gap:12px; }
@media(min-width:480px){ .af-grid { grid-template-columns:1fr 1fr; } }

/* 上传区域 */
.photo-upload-area { height:120px; border:2px dashed var(--border-strong); border-radius:12px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; color:var(--text-dim); }
.photo-upload-area:active { background:var(--surface-2); }
```

---

## 5. 偏好设置（Preferences / scr-prefs）

### 改动清单
1. **页面头**
   - 标题 `20px/800`，副标题 `13px/400` 灰色，padding 16px。

2. **设置行**
   - 行高 56px，左侧 label + sub，右侧 control。
   - 分隔线 1px，最后一个无分隔线。

3. **主题选择**
   - 改为 Segmented Control：3 段（Light / Dark / System），容器 44px 高，10px 圆角，选中金色背景。

4. **货币选择**
   - 改为胶囊下拉框（Pill Select）：36px 高，999px 圆角，背景 `var(--surface-2)`，右侧下拉箭头。

### 开发实现要点
```css
.seg3 { display:flex; height:36px; background:var(--surface-2); border-radius:999px; padding:3px; }
.seg3 .seg { flex:1; display:flex; align-items:center; justify-content:center; border-radius:999px; font-size:12px; font-weight:600; color:var(--text-dim); }
.seg3 .seg.on { background:var(--gold); color:#0F0E0E; }

.pref-row { height:56px; display:flex; align-items:center; justify-content:space-between; padding:0 4px; border-bottom:1px solid var(--border); }
.pref-row:last-child { border-bottom:none; }
.pref-row:active { background:var(--surface-2); border-radius:10px; }
```

---

## 6. 数据帮助（Data & Help / scr-datahelp）

### 改动清单
1. **分组卡片**
   - 所有功能按组聚合：账号/高级、门店、备份、通知、隐私。
   - 统一 `.grp` 样式，间距 12px。

2. **可展开项**
   - `details/summary` 改为自定义行：44px 高，右箭头随展开旋转 90°。
   - 内容区展开后 padding 12px，背景 `var(--surface-2)`，圆角 10px。

3. **备份按钮**
   - “Export” 金色主按钮，“Import” 描边次按钮，间距 8px，统一 44px 高。

4. **通知区**
   - Toggle switch 统一为 52x28px，金色 thumb，开启时金色轨道。
   - 通知列表为空时显示车辆轮廓 + “No notifications”。

5. **隐私链接**
   - Privacy / Terms 改为文字按钮，金色，下划线，水平排列，间距 16px。

### 开发实现要点
```css
.ui-toggle { width:52px; height:28px; border-radius:999px; background:var(--surface-2); position:relative; transition:.2s; }
.ui-toggle.on { background:var(--gold); }
.ui-toggle::after { content:''; position:absolute; top:3px; left:3px; width:22px; height:22px; border-radius:50%; background:var(--text); transition:.2s; }
.ui-toggle.on::after { left:27px; }

.chevron { transition:transform .2s; }
.open .chevron { transform:rotate(90deg); }
```

---

## 中英双语实现
- 所有界面文案继续通过 `data-i18n` + `T()` 函数渲染。
- 中文状态下：
  - 标题、按钮保持简短（2-4 字）。
  - 英文状态下：保持现有文案不变。
- 注意预留宽度：中文按钮可比英文更窄，但布局应支持英文较长文案（如 “Recently viewed”）。

---

## 空状态 & 骨架屏统一

### 空状态组件
```html
<div class="empty">
  <div class="empty-icon">🚗</div>
  <div class="empty-title">No cars found</div>
  <div class="empty-sub">Try adjusting your filters</div>
  <button class="btn secondary">Clear filters</button>
</div>
```
```css
.empty { text-align:center; padding:48px 24px; color:var(--text-dim); }
.empty-icon { width:80px; height:80px; margin:0 auto 16px; display:flex; align-items:center; justify-content:center; font-size:36px; background:var(--surface-2); border-radius:50%; }
.empty-title { font-size:15px; font-weight:700; color:var(--text); margin-bottom:6px; }
.empty-sub { font-size:13px; margin-bottom:16px; }
```

### 骨架屏组件
```css
.skeleton-card { background:var(--surface); border-radius:12px; overflow:hidden; }
.skeleton-img { height:120px; background:var(--surface-2); }
.skeleton-line { height:14px; border-radius:999px; margin:10px 12px; background:var(--surface-2); }
.skeleton-line.short { width:55%; }
```

---

## 修改文件
- `app/index.html`：样式区 + 6 个 screen 的 HTML 结构微调（主要是 class/结构，不改 JS 逻辑）。
- 新增/替换 class 后，现有 JS 渲染函数无需改动（仍按 id 插入内容）。
