/*
 * Ant Motors — 同源控制台迁移脚本
 * -------------------------------------------------------------
 * 用途：当 App 数据被困在"已安装的 PWA / 某域名下的 localStorage"里，
 *       而用 file:// 打开迁移页读不到时，用本脚本在 App 自身页面
 *       （同源）的开发者工具控制台里执行，把数据推到 Supabase。
 *
 * 用法：
 *   1. 打开你的 App 页面（就是平时用的那个网址 / 已安装的 PWA）。
 *   2. 按 F12 → Console（控制台）。
 *   3. 把本文件全部内容粘贴进去，回车执行。
 *   4. 按提示输入 邮箱 / 密码 / 公司名（会弹窗 prompt）。
 *   5. 看控制台进度，等出现"完成 ✓"即可。
 *
 * 说明：使用 Supabase anon key，仅本地运行，数据直传你的项目。
 */
(async () => {
  const SUPABASE_URL = 'https://mcjvlohnyfkvmftrvxeq.supabase.co';
  const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1janZsb2hueWZrdmtmdHJ2eGVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyOTExNTcsImV4cCI6MjEwNDg2NzE1N30.a55h-eJPWQPF0kMlx-PGeeecwSIzdEVoZ4y5dIGWbV8';

  // 1) 加载 supabase-js
  if (typeof supabase === 'undefined') {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      s.onload = res; s.onerror = () => rej(new Error('supabase-js 加载失败（检查网络）'));
      document.head.appendChild(s);
    });
  }
  const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON, { auth: { persistSession: true, autoRefreshToken: true } });
  const log = (m) => console.log('%c[AM-MIGRATE] ' + m, 'color:#3b82f6');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const randHex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const randCode = () => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from({ length: 6 }, () => a[Math.floor(Math.random() * a.length)]).join(''); };
  const readLS = (k) => { try { return JSON.parse(localStorage.getItem(k) || (k.endsWith(']') ? '[]' : '{}')); } catch (e) { return null; } };

  // 2) 认证
  const email = prompt('输入 Supabase 账号邮箱：');
  const pw = prompt('输入密码（≥8 位）：');
  if (!email || !pw) { console.log('已取消'); return; }
  log('认证中…');
  let auth = await sb.auth.signInWithPassword({ email, password: pw });
  if (auth.error) {
    log('登录失败，尝试注册…');
    auth = await sb.auth.signUp({ email, password: pw });
    if (auth.error) { console.error('认证失败：', auth.error.message); return; }
    if (!auth.data.session) { console.warn('注册成功但需验证邮箱：请查收邮件确认后，回到 App 页重新运行本脚本。'); return; }
  }
  const me = (await sb.auth.getUser()).data.user.id;
  log('已登录：' + me);

  // 3) 公司
  const { data: cos } = await sb.from('companies').select('*');
  const mine = (cos || []).filter(c => c.owner_id === me);
  let cid;
  if (mine.length) {
    cid = prompt('输入要迁入的公司 CODE（可选，留空用第一个）：\n已有：\n' + mine.map(c => c.code + '  ' + c.name).join('\n'), mine[0].id);
    cid = mine.find(c => c.id === cid || c.code === cid)?.id || mine[0].id;
  } else {
    const name = prompt('输入公司名称（将新建）：', 'Ant Motors') || 'Ant Motors';
    cid = 'co_' + randHex(6);
    const { error } = await sb.from('companies').insert({ id: cid, name, owner_id: me, code: 'ANT-' + randCode(), plan: 'trial', status: 'active', permanent: 1, created_at: Date.now() });
    if (error) { console.error('建公司失败：', error.message); return; }
    await sb.from('company_members').insert({ user_id: me, company_id: cid, role: 'owner' });
  }
  log('目标公司：' + cid);

  // 4) 归一化 + 迁移
  const normCar = (id, entry) => {
    let data = {}, listedAt = null, updatedAt = Date.now(), deleted = 0;
    if (entry && typeof entry === 'object') {
      if (entry.data && typeof entry.data === 'object') { data = Object.assign({}, entry.data); listedAt = entry.listedAt || null; updatedAt = entry.updatedAt || Date.now(); deleted = entry.deleted ? 1 : 0; }
      else { data = Object.assign({}, entry); delete data.listedAt; delete data.updatedAt; delete data.deleted; delete data.companyId; delete data.company_id; }
    }
    delete data.id; return { data, listedAt, updatedAt, deleted };
  };

  const cars = readLS('am_cars') || {};
  const photos = readLS('am_car_photos') || {};
  const emps = readLS('am_emps') || {};
  const srs = readLS('am_showrooms') || [];
  let carN = 0, phN = 0, srN = 0, empN = 0;

  for (const id of Object.keys(cars)) {
    const n = normCar(id, cars[id]);
    const { error } = await sb.from('cars').upsert({ id, company_id: cid, data: n.data, listed_at: n.listedAt, updated_at: n.updatedAt, deleted: n.deleted });
    if (error) console.error('✗ 车 ' + id + ': ' + error.message); else carN++;
    const arr = photos[id];
    if (Array.isArray(arr)) for (let i = 0; i < Math.min(arr.length, 12); i++) { const r = await sb.from('photos').upsert({ car_id: id, company_id: cid, idx: i, data: arr[i] }); if (!r.error) phN++; }
  }
  if (Array.isArray(srs)) for (let i = 0; i < srs.length; i++) { const s = srs[i]; const sid = s.id || s.name || ('sr_' + i); const r = await sb.from('showrooms').upsert({ id: sid, company_id: cid, data: s, updated_at: Date.now() }); if (!r.error) srN++; }
  for (const id of Object.keys(emps)) { if (id === 'boss') continue; const r = await sb.from('employees').upsert({ id, company_id: cid, user_id: null, data: emps[id], updated_at: Date.now(), deleted: 0 }); if (!r.error) empN++; }

  log(`完成 ✓  车辆 ${carN} · 照片 ${phN} · 展厅 ${srN} · 员工 ${empN}`);
  log('下一步：部署前端连接到这个 Supabase 项目。');
})();
