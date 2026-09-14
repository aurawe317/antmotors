/* ============================================================================
 * Ant Motors — 把手机里的老数据【直接上传】到新后台
 * ----------------------------------------------------------------------------
 * 为什么用这个而不是导出文件：
 *   1) 导出文件会落在手机上，很难找到、也难传到电脑；
 *   2) App 的备份格式不含照片，导出的文件会丢掉车照。
 *   本脚本直接把 localStorage 里的车源（含照片）POST 到新后台 /api/push。
 *
 * 用法（在你刚才那个 Mac 的「网页检查器」控制台里用，页面仍是旧域名）：
 *   1. 先把下面的 ACCOUNT / PASSWORD 改成你刚注册时填的账号和密码。
 *   2. 整段粘贴进控制台 → 回车。
 *   3. 看日志：会逐台车上报结果，最后打印汇总。
 *
 * 说明：
 *   - 必须停留在**旧域名**的页面上执行（数据在那个 origin 的 localStorage 里）。
 *   - 员工账号不会一起搬（新后台只接受已存在的员工），车源里记录的销售人员
 *     名字若找不到对应档案，分享页可能不显示联系人——之后在 App 里重新添加即可。
 * ========================================================================== */
(async function () {
  'use strict';

  var API      = 'https://antmotors.pages.dev';
  var ACCOUNT  = '在这里填账号';   // ← 改成你刚注册的邮箱 / 工号
  var PASSWORD = '在这里填密码';   // ← 改成你刚注册的密码
  var TOKEN    = '';               // ← 可选：若你有 token 就填这里，会优先使用

  if (!TOKEN && (ACCOUNT.indexOf('在这里填') === 0 || PASSWORD.indexOf('在这里填') === 0)) {
    console.warn('⚠️ 请先在脚本顶部填写 ACCOUNT 和 PASSWORD，再重新执行。');
    return;
  }

  var read = function (k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };

  var CARS   = read('am_cars', {});
  var PHOTOS = read('am_car_photos', {});
  var VIDEOS = read('am_car_videos', {});
  var LISTED = read('am_listed', {});
  var DEL    = read('am_car_deleted', {});

  var ids = Object.keys(CARS || {}).filter(function (id) { return !DEL[id]; });
  var photoBytes = 0, carsWithPhotos = 0;
  ids.forEach(function (id) {
    var p = (PHOTOS && PHOTOS[id]) || [];
    if (p.length) { carsWithPhotos++; photoBytes += JSON.stringify(p).length; }
  });

  console.log('%c[Ant Motors] 老数据 → 新后台', 'font-weight:bold;font-size:14px');
  console.log('待上传车辆：' + ids.length + ' 台');
  console.log('本地存有照片的车辆：' + carsWithPhotos + ' 台，照片总体积约 ' + Math.round(photoBytes / 1024) + ' KB');
  if (!carsWithPhotos) {
    console.warn('⚠️ 本机没有存到照片（App 对照片有 3.6MB 的本地存储上限，超出部分只存在原服务器上，已随服务器丢失）。' +
      '车辆信息仍会照常上传。');
  }
  if (!ids.length) { console.warn('⚠️ 没有找到任何车辆，请确认这是当时用旧 App 的那个页面。'); return; }

  // ---- 1. 取得新后台的登录 token ----
  var token = TOKEN;
  if (!token) {
    console.log('正在登录新后台…');
    try {
      var lr = await fetch(API + '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: ACCOUNT, password: PASSWORD })
      });
      var lj = await lr.json();
      if (!lj.token) { console.error('❌ 登录失败：', lj); return; }
      token = lj.token;
      console.log('✅ 已登录：' + (lj.employee && lj.employee.name ? lj.employee.name : ACCOUNT) +
        '（公司：' + (lj.company && lj.company.name ? lj.company.name : '-') + '）');
    } catch (e) { console.error('❌ 登录请求失败：', e); return; }
  }

  // ---- 2. 逐台车推送（一台一个请求，避免单次体积过大） ----
  var ok = 0, rejected = [];
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    var ph = (PHOTOS && PHOTOS[id]) ? PHOTOS[id].filter(function (p) {
      return typeof p === 'string' && /^data:image\//.test(p) && p.length > 40;
    }) : [];
    var vd = (VIDEOS && VIDEOS[id]) ? VIDEOS[id].filter(function (p) { return typeof p === 'string' && p.length > 40; }) : [];
    var one = { id: id, updatedAt: Date.now(), listedAt: LISTED[id] || null, data: CARS[id] };
    if (ph.length) one.photos = ph;
    if (vd.length) one.videos = vd;
    try {
      var res = await fetch(API + '/api/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ cars: [one], employees: [] })
      });
      var oj = await res.json();
      if (oj && oj.applied && oj.applied.indexOf(id) >= 0) {
        ok++;
        console.log('  [' + (i + 1) + '/' + ids.length + '] ✅ ' + ((CARS[id] && CARS[id].name) || id) + '（照片 ' + ph.length + '）');
      } else {
        var rej = (oj && oj.rejected && oj.rejected[0]) || { reason: 'http ' + res.status };
        rejected.push({ id: id, reason: rej.reason || rej });
        console.warn('  [' + (i + 1) + '/' + ids.length + '] ⚠️ ' + ((CARS[id] && CARS[id].name) || id) + ' 被拒：' + JSON.stringify(rej));
      }
    } catch (e) {
      rejected.push({ id: id, reason: String(e && e.message || e) });
      console.error('  [' + (i + 1) + '/' + ids.length + '] ❌ ' + id + ' 请求异常：' + e);
    }
  }

  console.log('%c===== 完成 =====', 'font-weight:bold');
  console.log('成功 ' + ok + ' 台 ｜ 被拒/失败 ' + rejected.length + ' 台');
  if (rejected.length) console.log('被拒明细：', rejected);
  console.log('现在可以去新 App 刷新看看了：' + API);
})();
