/* ============================================================================
 * Ant Motors — 老数据抢救脚本（从旧 Railway 域名导出浏览器里的车源数据）
 * ----------------------------------------------------------------------------
 * 前提：必须在**当时使用旧 App 的那个浏览器**上操作。数据存在浏览器 local
 *      Storage 里，换浏览器/换设备都读不到；也请勿清理浏览器数据。
 *      （若当时用的是手机 PWA，别用这个脚本，先告诉协助你的人，另有办法。）
 *
 * 用法：
 *   1. 打开 https://antmotors-production.up.railway.app
 *      —— 会显示 404，这是正常的（Railway 应用已删除），不影响取数据。
 *   2. 按 F12（Mac：⌥⌘I）打开开发者工具 → 切到「Console / 控制台」标签。
 *   3. 如果 Chrome 提示“允许粘贴/allow pasting”，按提示输入即可。
 *   4. 把本文件全部内容粘贴进控制台 → 回车。
 *   5. 会自动下载 antmotors-backup-YYYY-MM-DD.json —— 这就是你的老数据备份。
 *
 * 接着（换到新 App 恢复）：
 *   6. 打开 https://antmotors.pages.dev → 登录你刚注册的账号。
 *   7. 设置 → 恢复备份 / 导入（Import backup）→ 选择第 5 步的文件。
 *   8. 导入后会自动同步到云端（无需手动操作），稍等片刻即可在列表里看到车源。
 * ========================================================================== */
(function () {
  'use strict';

  var read = function (key, dflt) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : dflt; }
    catch (e) { return dflt; }
  };

  var cars   = read('am_cars', {});
  var saved  = read('am_saved', []);
  var recent = read('am_recent', []);
  var emps   = read('am_emps', {});
  var relCars = read('am_car_deleted', {});

  var nCars = Object.keys(cars || {}).length;
  var nEmp  = Object.keys(emps || {}).length;
  var nSaved = (saved || []).length;

  console.log('%c[Ant Motors] 老数据扫描', 'font-weight:bold;font-size:14px');
  console.log('本域名下的 am_* 存储键：', Object.keys(localStorage).filter(function (k) { return k.indexOf('am_') === 0; }));
  console.log('车辆：' + nCars + ' 台 ｜ 员工：' + nEmp + ' 人 ｜ 收藏：' + nSaved + ' 台');

  if (!nCars && !nEmp) {
    console.warn('⚠️ 这个域名下没有找到数据。请检查：\n' +
      '   ① 是否用的是「当时装过 / 用过」旧 App 的那个浏览器？\n' +
      '   ② 地址栏是否确实是 antmotors-production.up.railway.app ？（必须是这个域名）\n' +
      '   ③ 浏览器数据是否被清理过？');
    return;
  }

  var out = { v: 1, cars: cars || {}, saved: saved || [], recent: recent || [], employees: emps || {} };
  var json = JSON.stringify(out, null, 2);

  // 兜底：把结果挂到全局，方便手动复制
  window.__antmotorsBackupJSON = json;

  try {
    var blob = new Blob([json], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'antmotors-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
    console.log('%c✅ 已下载 antmotors-backup-*.json —— 请到新 App 里用「恢复备份 / 导入」加载它。',
      'color:#0a0;font-weight:bold');
  } catch (e) {
    console.warn('下载失败（' + e.message + '）。请改用下面这行手动保存：');
    console.log('  copy(window.__antmotorsBackupJSON)   // 复制到剪贴板后粘贴进一个 .json 文件');
  }

  console.log('（若下载没反应，也可执行 copy(window.__antmotorsBackupJSON) 把 JSON 复制出来）');
  void relCars;
})();
