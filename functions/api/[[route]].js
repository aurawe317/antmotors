/*
 * Ant Motors — Cloudflare Pages Functions 后端（Supabase 多租户）
 * 替代原 server.js（node:sqlite）。前端 index.html 保持不变，仍走 /api/*。
 *
 * 部署：Cloudflare Pages，构建输出目录 = app，本文件提供 /api/*。
 * 环境变量（在 Cloudflare Pages → Settings → Environment variables 设置，service_role 用 Secret）：
 *   SUPABASE_SERVICE_ROLE_KEY      = <service_role key>  （仅服务端用，切勿暴露给浏览器）
 *
 * ⚠️ 项目 URL 固定在下面 SUPABASE_URL_FIXED，故意不读 env.SUPABASE_URL：
 *    历史上这里曾被一个拼错的 ref（…fkvm… 而不是 …fkvk…）指向**不存在的主机**，
 *    导致每次请求都被 Cloudflare 回 error 1016 / HTTP 530。写死 + 单一来源可杜绝复发。
 *
 * 鉴权：自包含（PBKDF2 本地哈希 + 自签发会话 token 存 tokens 表）。
 *      Supabase Auth 仅作 best-effort 增强，不可用也不影响注册/登录。
 */
import { createClient } from '@supabase/supabase-js';

// Supabase 项目 URL（公开信息，写死以避免拼写类事故）
const SUPABASE_URL_FIXED = 'https://mcjvlohnyfkvkftrvxeq.supabase.co';

// Supabase 客户端在首个请求时用 context.env 初始化（Cloudflare Workers 无 process.env）
let SUPABASE_URL = SUPABASE_URL_FIXED;
let SUPABASE_KEY = '';
let sb = null;
// Optional env fallback for hostname -> company binding (no SQL required):
//   COMPANY_HOSTS = "antmotors.autos:co_a4812811971e,valor.autos:co_xxxxxxxx"
let COMPANY_HOSTS = '';
function getSb(env) {
  COMPANY_HOSTS = env.COMPANY_HOSTS || COMPANY_HOSTS;
  if (!sb) {
    SUPABASE_URL = SUPABASE_URL_FIXED;
    SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
    sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  }
  return sb;
}

const TOP_TIERS = ['boss', 'partnerA', 'partnerB'];
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const TRIAL_DAYS = 14;
const APP_VER = 'cf-supabase-1';

// 会员宽限期（天）：宽限期内服务照常，只是不能再生成新码。
const GRACE_QR_DAYS = 30;      // 二维码：30 天
const GRACE_DOMAIN_DAYS = 60;  // 专属域名：60 天

// 定价：**以人民币为基准**，美元按固定汇率 6.8 换算（保留 2 位小数，不随市价波动）。
const FX_CNY_PER_USD = 6.8;
const toUsd = (cny) => Math.round((cny / FX_CNY_PER_USD) * 100) / 100;
// 档位额度：null = 无限。features.domain = 专属域名，features.qr = 公司二维码。
const PLANS = {
  free: {
    id: 'free', name: '免费', nameEn: 'Free', rank: 0,
    monthly: { cny: 0, usd: 0 }, yearly: { cny: 0, usd: 0 },
    quotas: { cars: 7, employees: 2, showrooms: 1 },
    features: { domain: false, qr: false }
  },
  standard: {
    id: 'standard', name: '普通会员', nameEn: 'Standard', rank: 1,
    monthly: { cny: 31, usd: toUsd(31) }, yearly: { cny: 310, usd: toUsd(310) },
    quotas: { cars: 30, employees: 5, showrooms: 3 },
    features: { domain: false, qr: false }
  },
  premium: {
    id: 'premium', name: '高级会员', nameEn: 'Premium', rank: 2,
    monthly: { cny: 58, usd: toUsd(58) }, yearly: { cny: 588, usd: toUsd(588) },
    quotas: { cars: null, employees: null, showrooms: null },
    features: { domain: true, qr: true }
  }
};
// 未识别的老档位（trial / owner / monthly / yearly / 空）= 不限额、给全功能：
// 新规则上线时绝不能把已有客户卡住。
const LEGACY_QUOTAS = { cars: null, employees: null, showrooms: null };
const LEGACY_FEATURES = { domain: true, qr: true };
const quotasOf = (planId) => (PLANS[planId] ? PLANS[planId].quotas : LEGACY_QUOTAS);
const featuresOf = (planId) => (PLANS[planId] ? PLANS[planId].features : LEGACY_FEATURES);
// 某个额度是否够用（limit=null 表示无限）
async function quotaCheck(companyId, planId, kind) {
  const limit = quotasOf(planId)[kind];
  if (limit == null) return { limit: null, used: 0, ok: true };
  const table = kind === 'cars' ? 'cars' : (kind === 'employees' ? 'employees' : 'showrooms');
  let q = sb.from(table).select('id', { count: 'exact', head: true }).eq('company_id', companyId);
  if (table !== 'showrooms') q = q.eq('deleted', 0);
  const { count } = await q;
  const used = count || 0;
  return { limit, used, ok: used < limit };
}

const now = () => Date.now();
const clampTs = (t) => { const n = now(); const v = +t; return (!v || v > n) ? n : v; };
const isTop = (emp) => !!emp && TOP_TIERS.includes(emp.tier);

/* --------------------------------------------------------------------- local password auth
 * The app already issues and validates its OWN session tokens (tokens table), so Supabase Auth
 * is only used for password verification + user creation. When the Supabase Auth service is
 * unreachable (HTTP 530 from the project's edge), we fall back to a PBKDF2 hash kept in the
 * employee record (data._pw). This keeps registration/login working no matter what Auth does.
 * authDown: once an Auth call fails in a connectivity way, skip Auth for this worker instance.
 */
let authDown = false;
const te = new TextEncoder();
function b64(buf) { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
function unb64(str) { const bin = atob(str); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; }
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', te.encode(String(password)), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return b64(bits);
}
async function makePwRecord(password) {
  const iterations = 100000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { alg: 'pbkdf2-sha256', it: iterations, s: b64(salt), h: await pbkdf2(password, salt, iterations) };
}
async function checkPwRecord(password, rec) {
  if (!rec || typeof rec !== 'object' || !rec.s || !rec.h) return false;
  try { return (await pbkdf2(password, unb64(rec.s), rec.it || 100000)) === rec.h; } catch (e) { return false; }
}
const isAuthUnreachable = (msg) => /53\d|unreachable|fetch failed|network|timeout/i.test(String(msg || ''));
/* strip the password record before employee data ever leaves the server */
function stripPw(d) {
  if (!d || typeof d !== 'object') return d || {};
  const out = Object.assign({}, d);
  delete out._pw;
  return out;
}

/* --------------------------------------------------------------------- response */
function send(code, obj, extra) {
  const body = JSON.stringify(obj);
  return new Response(body, {
    status: code,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Cache-Control': 'no-store'
    }, extra || {})
  });
}
async function readBody(req) {
  try { const t = await req.text(); return t ? JSON.parse(t) : {}; }
  catch (e) { return {}; }
}
async function readForm(req) {
  const t = await req.text();
  const out = {};
  for (const pair of t.split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    out[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
  }
  return out;
}

/* --------------------------------------------------------------------- companies */
async function companyById(id) {
  const { data } = await sb.from('companies').select('*').eq('id', id).maybeSingle();
  return data;
}
function publicCompany(row) {
  return { id: row.id, name: row.name, logo: row.logo || null, bio: row.bio || '', code: row.code, plan: row.plan, status: row.status, permanent: !!row.permanent, contact: contactOf(row) };
}
// Company-level public contact (name / phone / WhatsApp). Shown on a tenant's own
// domain (e.g. antmotors.autos) for customers who browse directly (no sales share
// link). Null when nothing is set, so the client can fall back to the agent.
function contactOf(row) {
  if (!row) return null;
  const name = row.contact_name || null;
  const phone = row.contact_phone || null;
  const wa = row.contact_wa || null;
  if (!name && !phone && !wa) return null;
  return { name, phone, wa };
}
// Compact company descriptor sent to customer views (homepage list + single car),
// including the public contact so the bottom bar can show the company contact.
function companyInfoOf(co) {
  if (!co) return null;
  return { id: co.id, name: co.name, logo: co.logo || null, contact: contactOf(co) };
}
// The tenant's own (custom) domain, if they bound one. Decides whether a share
// link goes out on the dealer's own domain (premium) or on the platform domain.
// Missing table / no binding => null (never throws).
async function ownDomainOf(cid) {
  if (!cid) return null;
  try {
    const { data } = await sb.from('company_domains').select('host')
      .eq('company_id', cid).eq('kind', 'custom')
      .order('created_at', { ascending: true }).limit(1);
    if (data && data.length && data[0].host) return String(data[0].host).trim().toLowerCase();
  } catch (e) { /* company_domains not created yet — treat as unbound */ }
  return null;
}
async function publicCompanyWithDomain(row) {
  if (!row) return null;
  return Object.assign(publicCompany(row), { domain: await ownDomainOf(row.id) });
}
function membershipView(row) {
  const t = now();
  const isPermanent = !!row.permanent;
  const raw = row.plan || '';
  // 试用窗口：新注册公司在前 14 天按「普通会员」额度用，之后回落到「免费」。
  const trialEnd = (+row.trial_ends_at) || ((+row.created_at || t) + TRIAL_DAYS * 864e5);
  let effective;                 // free | standard | premium | null(=老档位，不限额)
  let periodEnd = +row.current_period_end || 0;
  let active = true;
  if (isPermanent) { effective = 'premium'; active = true; }
  else if (PLANS[raw]) {
    if (raw === 'free') { effective = (t < trialEnd) ? 'standard' : 'free'; periodEnd = trialEnd; active = true; }
    else { effective = raw; active = (row.status === 'active') && t < periodEnd; }
  } else { effective = null; active = true; }   // 老档位：不限额、不锁功能（绝不卡住老客户）
  const onTrial = (raw === 'free') && (t < trialEnd);
  const m = PLANS[effective] || { name: '会员', nameEn: 'Member' };
  return {
    plan: effective, rawPlan: raw, planName: m.name, planNameEn: m.nameEn,
    status: row.status, active, expired: !active, periodEnd,
    canSell: active, isPermanent, onTrial,
    quotas: quotasOf(effective), features: featuresOf(effective),
    graceDays: { qr: GRACE_QR_DAYS, domain: GRACE_DOMAIN_DAYS }
  };
}
// planKey 形如 "standard_yearly" / "premium_monthly"（orders.plan_id 里同时编码档位与周期）。
async function activatePlan(companyId, planKey, tradeNo) {
  const raw = String(planKey || '');
  const us = raw.lastIndexOf('_');
  const tier = us > 0 ? raw.slice(0, us) : raw;
  const cycle = ((us > 0 ? raw.slice(us + 1) : 'monthly') === 'yearly') ? 'yearly' : 'monthly';
  const p = PLANS[tier]; if (!p) return;
  const days = (cycle === 'yearly') ? 365 : 30;
  const { data: co } = await sb.from('companies').select('current_period_end,plan').eq('id', companyId).maybeSingle();
  const curEnd = +((co && co.current_period_end) || 0);
  const sameTier = !!(co && co.plan === tier);
  const start = now();
  // 续费（同档位）：从原到期时间往后接，不吞掉客户已付的天数；升级/换档：从现在算起。
  const base = (sameTier && curEnd > start) ? curEnd : start;
  const end = base + days * 864e5;
  await sb.from('companies').update({ plan: tier, status: 'active', plan_started_at: start, current_period_end: end, alipay_trade_no: tradeNo || '', subscription_id: tradeNo || '', last_paid_at: start }).eq('id', companyId);
}
async function genCompanyCode() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  for (;;) {
    code = 'ANT-' + Array.from({ length: 6 }, () => a[Math.floor(Math.random() * a.length)]).join('');
    const { data } = await sb.from('companies').select('id').eq('code', code).maybeSingle();
    if (!data) return code;
  }
}

/* --------------------------------------------------------------------- auth */
async function resolveEmployee(account) {
  const a = String(account || '').trim();
  if (!a) return null;
  if (a.includes('@')) {
    const { data } = await sb.from('employees').select('*').eq('email', a.toLowerCase()).eq('deleted', 0).maybeSingle();
    return data;
  }
  const { data } = await sb.from('employees').select('*').ilike('id', a).eq('deleted', 0).maybeSingle();
  return data;
}
/* verify password via Supabase Auth using the employee's e-mail (best-effort, never fatal) */
async function verifyViaSupabase(email, password) {
  if (!email || authDown) return null;
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) { if (isAuthUnreachable(error.message)) authDown = true; return null; }
    if (!data || !data.user) return null;
    return data.user; // {id, email}
  } catch (e) {
    if (isAuthUnreachable(e && e.message)) authDown = true;
    return null;
  }
}
async function issueToken(empId, companyId) {
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  await sb.from('tokens').insert({ token, emp_id: empId, company_id: companyId, created_at: now(), expires_at: now() + TOKEN_TTL_MS });
  return token;
}
async function authOf(req) {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const { data: tk } = await sb.from('tokens').select('emp_id,company_id,expires_at').eq('token', m[1]).maybeSingle();
  if (!tk) return null;
  if (tk.expires_at && tk.expires_at < now()) { await sb.from('tokens').delete().eq('token', m[1]); return null; }
  const { data: e } = await sb.from('employees').select('*').eq('id', tk.emp_id).eq('company_id', tk.company_id).eq('deleted', 0).maybeSingle();
  if (!e) return null;
  const emp = stripPw(e.data || {});
  emp.id = e.id; emp.companyId = e.company_id; emp.email = e.email || '';
  return emp;
}
/* after Supabase Auth success, make sure an employees row exists for this user */
async function ensureEmployeeForUser(authUser, companyId, role) {
  const { data: existing } = await sb.from('employees').select('*').eq('user_id', authUser.id).eq('company_id', companyId).maybeSingle();
  if (existing) return existing;
  const { data: byEmail } = await sb.from('employees').select('*').eq('email', (authUser.email || '').toLowerCase()).eq('company_id', companyId).maybeSingle();
  if (byEmail) {
    await sb.from('employees').update({ user_id: authUser.id }).eq('id', byEmail.id).eq('company_id', companyId);
    byEmail.user_id = authUser.id; return byEmail;
  }
  const id = (authUser.email || crypto.randomUUID()).split('@')[0].replace(/[^A-Za-z0-9_]/g, '').slice(0, 20) || ('u_' + authUser.id.slice(0, 8));
  const data = { name: (authUser.email || id).split('@')[0], av: '?', tier: role || 'boss', role: 'Boss / Owner', roleZh: '老板 / 所有者' };
  await sb.from('employees').insert({ id, company_id: companyId, user_id: authUser.id, data, email: authUser.email || null, updated_at: now(), deleted: 0 });
  return { id, company_id: companyId, user_id: authUser.id, data };
}

/* --------------------------------------------------------------------- photos/videos */
// B-plan: photos/videos are stored as Supabase Storage URLs (NOT base64 in the DB).
// Uploads go through /api/upload (service_role) so the client never touches a key.
// Legacy clients still send base64 in their push payload — writePhotos/writeVideos
// auto-upload those to Storage and converge on URL-only storage.
let _bucketReady = false;
async function ensureBucket(sb) {
  if (_bucketReady) return;
  try { await sb.storage.createBucket('car-photos', { public: true }); } catch (e) { /* exists / noop */ }
  _bucketReady = true;
}
async function uploadToStorage(dataUrl, cid, carId, kind) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || '');
  if (!m) throw new Error('bad_dataurl');
  const contentType = m[1] || 'application/octet-stream';
  const ext = (contentType.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const path = `${cid}/${carId || 'unknown'}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await ensureBucket(sb);
  const { data, error } = await sb.storage.from('car-photos').upload(path, bytes, { contentType, upsert: true });
  if (error) throw new Error('storage_upload_failed: ' + (error.message || error));
  return `${SUPABASE_URL_FIXED}/storage/v1/object/public/car-photos/${path}`;
}
// Returns the car's photos WITH their stable row ids (`idx`). The id lets a client delete a
// specific photo unambiguously instead of the fragile "match by URL value" approach, which
// broke whenever a value drifted (base64 vs URL, re-upload path, …).
async function photosWithIds(id, cid) {
  const { data } = await sb.from('photos').select('*').eq('car_id', id).eq('company_id', cid).order('idx', { ascending: true });
  const rows = (data || []).filter(r => (r.url || r.data));
  return { urls: rows.map(r => r.url || r.data), ids: rows.map(r => r.idx) };
}
async function photosOf(id, cid) {
  return (await photosWithIds(id, cid)).urls;
}
// Lightweight single-cover lookup for the public car list — returns just the first
// photo URL so the browse grid can paint covers in one request (no full photo blob).
// Returns null (never base64) so the list never balloons before the URL migration runs.
// Lightweight single-cover lookup for the public car list. We store the Storage URL
// directly in the `data` column (no separate `url` column required), so this just
// returns `data` when it is already a URL and null while it is still legacy base64.
// Selecting only `data` keeps it safe even before any migration has run.
async function coverOf(id, cid) {
  const { data } = await sb.from('photos').select('data').eq('car_id', id).eq('company_id', cid).order('idx', { ascending: true }).limit(1);
  if (!data || !data.length) return null;
  const v = data[0].data;
  return (typeof v === 'string' && /^https?:\/\//.test(v)) ? v : null;
}
async function writePhotos(id, arr, cid) {
  if (!Array.isArray(arr)) return;
  const { data: existing, error: selErr } = await sb.from('photos').select('*').eq('car_id', id).eq('company_id', cid);
  if (selErr) throw new Error('photos_select_failed: ' + (selErr.message || selErr));
  // Normalise the incoming list. A modern client sends [{id, url}] where `id` is the stable row
  // idx; an older client (or one whose id bookkeeping drifted) still sends plain URL strings.
  // Both are accepted, so this protocol upgrade can never hard-break photo syncing.
  const items = [];
  for (const d of arr) {
    if (typeof d === 'string') { if (d) items.push({ id: null, url: d }); }
    else if (d && typeof d.url === 'string' && d.url) items.push({ id: (typeof d.id === 'number' ? d.id : null), url: d.url });
  }
  const existingRows = existing || [];
  const idAware = items.some(it => it.id !== null);
  let keep = [], toRemove = [];
  if (idAware) {
    // Stable-id path: keep EXACTLY the rows the client named; every other row is a deletion.
    // This is unambiguous — it cannot be confused by a value that drifted on either side.
    const keepIds = new Set(items.filter(it => it.id !== null).map(it => it.id));
    toRemove = existingRows.filter(r => !keepIds.has(r.idx));
    keep = existingRows.filter(r => keepIds.has(r.idx));
  } else {
    // Legacy value path: keep the rows whose value the client still wants, and collapse any
    // duplicate-value rows (two rows sharing a value can never be value-matched for deletion).
    const want = new Set(items.map(it => it.url));
    const seen = new Set();
    for (const r of existingRows) {
      const v = r.url || r.data;
      if (!want.has(v) || seen.has(v)) toRemove.push(r); else { seen.add(v); keep.push(r); }
    }
  }
  if (toRemove.length) {
    const idxs = toRemove.map(r => r.idx).filter(v => typeof v === 'number');
    if (idxs.length) {
      // Delete by composite-PK idx (unambiguous for every row, incl. legacy migrated rows).
      const { error: delErr } = await sb.from('photos').delete().eq('car_id', id).eq('company_id', cid).in('idx', idxs);
      // Surface failures instead of swallowing them — a silent delete error is exactly how
      // rows accumulate and "deleted" photos keep resurrecting.
      if (delErr) throw new Error('photos_delete_failed: ' + (delErr.message || delErr));
    }
  }
  const haveById = new Map(keep.map(r => [r.idx, r.url || r.data]));
  const haveVals = new Set(keep.map(r => r.url || r.data));
  let nextIdx = existingRows.reduce((m, r) => Math.max(m, (r.idx || 0) + 1), 0);
  const rows = [];
  const seenVals = new Set();
  for (const it of items) {
    // Already a Storage URL → store as-is; otherwise upload the base64 blob and store the
    // resulting CDN URL in `data` (no separate `url` column needed).
    const value = /^https?:\/\//.test(it.url) ? it.url : (await uploadToStorage(it.url, cid, id, 'photo').catch(() => null));
    if (!value || seenVals.has(value)) continue;
    seenVals.add(value);
    if (it.id !== null && haveById.has(it.id)) {
      // Row kept by id — refresh its stored value if the client's URL for it changed.
      if (haveById.get(it.id) !== value) {
        const { error: ue } = await sb.from('photos').update({ data: value }).eq('car_id', id).eq('company_id', cid).eq('idx', it.id);
        if (ue) throw new Error('photos_update_failed: ' + (ue.message || ue));
      }
      continue;
    }
    if (haveVals.has(value)) continue;   // this exact value is already stored on the server
    rows.push({ car_id: id, company_id: cid, idx: nextIdx, data: value });
    nextIdx++;
    if (rows.length >= 30) break;
  }
  if (!rows.length) return;
  const { error } = await sb.from('photos').insert(rows);
  if (error) throw new Error('photos_insert_failed: ' + (error.message || error));
}
async function videosOf(id, cid) {
  const { data } = await sb.from('videos').select('*').eq('car_id', id).eq('company_id', cid).order('idx', { ascending: true });
  return (data || []).map(r => r.url || r.data).filter(Boolean);
}
async function writeVideos(id, arr, cid) {
  if (!Array.isArray(arr)) return;
  const { data: existing, error: selErr } = await sb.from('videos').select('*').eq('car_id', id).eq('company_id', cid);
  if (selErr) throw new Error('videos_select_failed: ' + (selErr.message || selErr));
  const want = new Set(arr.filter(d => typeof d === 'string'));
  // Same reconcile rules as writePhotos: drop rows the client no longer wants, plus any
  // duplicate-value rows beyond the first.
  const have = new Set();
  const toRemove = [];
  for (const r of (existing || [])) {
    const v = r.url || r.data;
    if (!want.has(v) || have.has(v)) toRemove.push(r); else have.add(v);
  }
  if (toRemove.length) {
    const idxs = toRemove.map(r => r.idx).filter(v => typeof v === 'number');
    if (idxs.length) {
      const { error: delErr } = await sb.from('videos').delete().eq('car_id', id).eq('company_id', cid).in('idx', idxs);
      if (delErr) throw new Error('videos_delete_failed: ' + (delErr.message || delErr));
    }
  }
  let nextIdx = (existing || []).reduce((m, r) => Math.max(m, (r.idx || 0) + 1), 0);
  const seen = new Set();
  const rows = [];
  for (const d of arr) {
    if (typeof d !== 'string') continue;
    const value = /^https?:\/\//.test(d)
      ? d
      : (await uploadToStorage(d, cid, id, 'video').catch(() => null));
    if (!value) continue;
    if (have.has(value) || seen.has(value)) continue;
    seen.add(value);
    rows.push({ car_id: id, company_id: cid, idx: nextIdx, data: value });
    nextIdx++;
    if (rows.length >= 8) break;
  }
  if (!rows.length) return;
  const { error } = await sb.from('videos').insert(rows);
  if (error) throw new Error('videos_insert_failed: ' + (error.message || error));
}

/* --------------------------------------------------------------------- sync */
function publicCar(row) {
  const c = row.data || {};
  const quote = c.price && typeof c.price.quote === 'number' ? c.price.quote : null;
  const out = Object.assign({}, c, { id: row.id, listedAt: row.listed_at });
  out.price = { quote };
  return out;
}
/* ---- hostname -> company ------------------------------------------------
   A tenant can be reached through its own domain (antmotors.autos) or through a
   platform subdomain (ant.antmotors.autos). Resolution order:
     1) company_domains table   — explicit mapping, supports ANY custom domain
     2) companies.slug          — covers <slug>.<any host> automatically
     3) COMPANY_HOSTS env       — "host:company_id,host2:company_id2" (no SQL needed)
   Each step is optional: if the table / column / env var is missing we simply skip
   it, so this never breaks on a database that has not been migrated yet. */
// Hosts that belong to the PLATFORM itself (staff sign in here), never to a tenant.
// antoto.app is the platform domain; antmotors.pages.dev is the legacy Pages host.
const PLATFORM_HOSTS = new Set(['antoto.app', 'www.antoto.app', 'antmotors.pages.dev', 'localhost', '127.0.0.1']);
async function companyByHost(host) {
  if (!host) return null;
  const h = String(host).toLowerCase().split(':')[0].replace(/\.$/, '');
  if (!h || PLATFORM_HOSTS.has(h)) return null;
  try {
    const { data } = await sb.from('company_domains').select('company_id').eq('host', h).maybeSingle();
    if (data && data.company_id) return data.company_id;
  } catch (e) { /* table not created yet — fall through */ }
  const m = /^([a-z0-9-]{2,30})\..+$/.exec(h);
  if (m) {
    try {
      const { data } = await sb.from('companies').select('id').eq('slug', m[1]).maybeSingle();
      if (data && data.id) return data.id;
    } catch (e) { /* slug column not added yet — fall through */ }
  }
  for (const pair of String(COMPANY_HOSTS || '').split(',')) {
    const bits = pair.split(':');
    if (bits.length >= 2 && bits[0].trim().toLowerCase() === h) return bits.slice(1).join(':').trim() || null;
  }
  return null;
}
async function resolveCompanyId(u, emp) {
  const ref = u.searchParams.get('ref');
  if (ref) { const { data: e } = await sb.from('employees').select('company_id').eq('id', ref).eq('deleted', 0).maybeSingle(); if (e) return e.company_id; }
  const cp = u.searchParams.get('company');
  if (cp) { const { data: c } = await sb.from('companies').select('id').eq('id', cp).maybeSingle(); if (c) return c.id; }
  // Fall back to the domain the visitor is on: this is how a dealership's own
  // domain (or its platform subdomain) shows only that dealership's inventory.
  const hc = await companyByHost(u.hostname);
  if (hc) return hc;
  return emp ? emp.companyId : null;
}
const SEED_CAR_IDS = new Set();   // 演示车 id（无种子文件时为空，由运营清样例处理）
const DEMO_EMP_IDS = new Set();
const DEMO_SHOWROOM_NAMES = ['Accra Branch', 'Tema Branch', 'Kumasi Branch'];

async function applyPush(emp, payload) {
  const applied = [], rejected = [];
  const top = isTop(emp);
  const cid = emp.companyId;
  // 额度（**服务端强制**）：一次取出公司档位与当前用量，循环内复用。
  // 老档位（未识别 plan）→ quotas 为 null → 不限额，绝不卡住已有客户。
  const coRow = await companyById(cid);
  const mv = coRow ? membershipView(coRow) : null;
  const carLimit = mv ? mv.quotas.cars : null;
  let carUsed = 0;
  if (carLimit != null) {
    const { count } = await sb.from('cars').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('deleted', 0);
    carUsed = count || 0;
  }
  for (const c of (payload.cars || [])) {
    if (!c || !c.id) continue;
    const { data: cur } = await sb.from('cars').select('*').eq('id', c.id).eq('company_id', cid).maybeSingle();
    if (cur && cur.deleted && SEED_CAR_IDS.has(c.id)) { rejected.push({ id: c.id, reason: 'sample_cleared' }); continue; }
    // 新建车辆（或把已删除的车恢复）会占用额度；超限直接拒绝——改前端也绕不过。
    const occupies = (!cur) || (!!cur.deleted && !c.deleted);
    if (occupies && carLimit != null && carUsed >= carLimit) {
      rejected.push({ id: c.id, reason: 'quota_cars', quota: carLimit, used: carUsed });
      continue;
    }
    // IMPORTANT: stamp the row with the SERVER's receive time, not the client-supplied
    // updatedAt. Client device clocks (phones with auto-time off) often run behind the
    // server, which made updated_at land in the past and the teammate's pull cursor
    // (server now) skip it forever — so other people's cars never synced. Using server
    // time for both updated_at and the pull cursor keeps incremental sync reliable.
    const ts = now();
    // With server-stamped ts, a row can't legitimately be "in the future", so the stale
    // guard below is effectively a no-op (it only rejects updated_at strictly > server now).
    if (cur && cur.updated_at > ts + 1000) { rejected.push({ id: c.id, reason: 'stale' }); continue; }
    const incoming = c.data || {};
    if (!top) {
      const oldPrice = cur ? (cur.data || {}).price : null;
      const newPrice = incoming.price || null;
      if (JSON.stringify(oldPrice) !== JSON.stringify(newPrice)) {
        if (cur) { incoming.price = oldPrice; rejected.push({ id: c.id, reason: 'price_forbidden' }); }
        else { rejected.push({ id: c.id, reason: 'price_forbidden' }); continue; }
      }
    }
    const { error: carErr } = await sb.from('cars').upsert({ id: c.id, company_id: cid, data: incoming, listed_at: c.listedAt || null, updated_at: ts, updated_by: emp.id, deleted: c.deleted ? 1 : 0 }, { onConflict: 'id,company_id' });
    if (carErr) { rejected.push({ id: c.id, reason: carErr.message || 'upsert_failed' }); continue; }
    if (occupies) carUsed++;
    if (c.deleted) {
      // A car deletion carries no photos, so its photo/video rows would otherwise linger on the
      // server forever. Car ids are derived from brand+model, so re-creating the same car would
      // instantly resurrect the "old photos". Purge them together with the car.
      await sb.from('photos').delete().eq('company_id', cid).eq('car_id', c.id);
      await sb.from('videos').delete().eq('company_id', cid).eq('car_id', c.id);
      applied.push(c.id);
      continue;
    }
    // Use Array.isArray (not truthy) so an empty array [] — i.e. "user deleted ALL
    // photos" — still reaches writePhotos and actually clears the rows on the server.
    if (Array.isArray(c.photos)) { try { await writePhotos(c.id, c.photos, cid); } catch (e) { rejected.push({ id: c.id, reason: 'photos_' + ((e && e.message) || e) }); } }
    if (Array.isArray(c.videos)) { try { await writeVideos(c.id, c.videos, cid); } catch (e) { rejected.push({ id: c.id, reason: 'videos_' + ((e && e.message) || e) }); } }
    applied.push(c.id);
  }
  for (const e of (payload.employees || [])) {
    if (!e || !e.id) continue;
    const { data: cur } = await sb.from('employees').select('*').eq('id', e.id).eq('company_id', cid).maybeSingle();
    const ts = now();
    if (!cur) { rejected.push({ id: e.id, reason: 'unknown_employee' }); continue; }
    if (cur.deleted && DEMO_EMP_IDS.has(e.id)) { rejected.push({ id: e.id, reason: 'sample_cleared' }); continue; }
    if (cur.updated_at > ts + 1000) { rejected.push({ id: e.id, reason: 'stale' }); continue; }
    const old = cur.data || {};
    const inc = Object.assign({}, e.data || {});
    delete inc._pw; // never accept a password hash from a client
    let next;
    if (top) next = Object.assign({}, old, inc);
    else if (e.id === emp.id) next = Object.assign({}, old, { wa: inc.wa != null ? String(inc.wa) : old.wa, phone: inc.phone != null ? String(inc.phone) : old.phone });
    else { rejected.push({ id: e.id, reason: 'not_your_account' }); continue; }
    await sb.from('employees').update({ data: next, updated_at: ts }).eq('id', e.id).eq('company_id', cid);
    applied.push(e.id);
  }
  return { applied, rejected };
}
async function pull(since, withPhotos, companyId) {
  const s = +since || 0;
  const { data: cars } = await sb.from('cars').select('*').eq('company_id', companyId).gt('updated_at', s).order('updated_at', { ascending: true });
  const carList = await Promise.all((cars || []).map(async (r) => {
    const pw = withPhotos ? await photosWithIds(r.id, companyId) : null;
    return {
      id: r.id, companyId: r.company_id, data: r.data, listedAt: r.listed_at,
      updatedAt: r.updated_at, updatedBy: r.updated_by, deleted: !!r.deleted,
      photos: pw ? pw.urls : undefined,
      photoIds: pw ? pw.ids : undefined,
      videos: withPhotos ? await videosOf(r.id, companyId) : undefined
    };
  }));
  const { data: emps } = await sb.from('employees').select('*').eq('company_id', companyId).gt('updated_at', s).order('updated_at', { ascending: true });
  const empList = (emps || []).map(r => ({ id: r.id, companyId: r.company_id, data: stripPw(r.data), updatedAt: r.updated_at, deleted: !!r.deleted }));
  return { now: now(), cars: carList, employees: empList };
}

/* --------------------------------------------------------------------- router */
export async function onRequest(context) {
  const { request } = context;
  const env = context.env || {};
  // The Supabase project URL is public and fixed (see SUPABASE_URL_FIXED). The service_role
  // key is required and must come from Cloudflare Dashboard → Settings → Environment variables
  // (Type: Secret), added to BOTH Production and Preview environments, then redeploy.
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return send(500, { error: 'config_missing', detail: 'SUPABASE_SERVICE_ROLE_KEY 未设置。请到 Cloudflare 项目 → Settings → Environment variables → + Add：Name 填 SUPABASE_SERVICE_ROLE_KEY，Type 选 Secret，值填 Supabase 后台 Settings→API 里的 service_role 密钥。务必同时加到 Production 和 Preview 两个环境，保存后 Redeploy。' });
  }
  let sb;
  try {
    sb = getSb(env);
  } catch (e) {
    return send(500, { error: 'sb_init_failed', detail: String(e && e.message || e) });
  }
  const req = request;
  const u = new URL(req.url);
  const p = u.pathname;
  const method = req.method;

  if (method === 'OPTIONS') return send(204, {});
  if (!p.startsWith('/api/')) return send(404, { error: 'no_route' });

  try {
    /* health — honestly reports Supabase DB + Auth + key sanity. `build` identifies the deploy.
     * NOTE: use body-carrying GETs (not head:true) and a real error extractor — a HEAD request
     * has no response body, so err.message came back empty and `|| null` masked real failures. */
    if (p === '/api/health') {
      const errText = (r) => {
        if (!r || !r.error) return null;
        const e = r.error;
        return e.message || e.hint || e.code || e.details || JSON.stringify(e);
      };
      let dbErr = null, authErr = null, cars = 0, companies = 0, keyWarn = null;
      try {
        const c = await sb.from('cars').select('id', { count: 'exact' }).eq('deleted', 0).limit(1);
        dbErr = errText(c); cars = c.count || 0;
      } catch (e) { dbErr = String((e && e.message) || e); }
      if (!dbErr) {
        try {
          const c2 = await sb.from('companies').select('id', { count: 'exact' }).limit(1);
          dbErr = errText(c2); companies = c2.count || 0;
        } catch (e) { dbErr = String((e && e.message) || e); }
      }
      try {
        const a = await sb.auth.admin.listUsers({ page: 1, perPage: 1 });
        authErr = errText(a);
      } catch (e) { authErr = String((e && e.message) || e); }
      // key sanity: is the configured key really a service_role key?
      try {
        const k = SUPABASE_KEY || '';
        if (!k) keyWarn = 'key_missing';
        else if (!k.startsWith('sb_secret_')) {
          const seg = k.split('.');
          if (seg.length !== 3) keyWarn = 'key_not_jwt_unrecognised_format';
          else {
            let pad = seg[1].replace(/-/g, '+').replace(/_/g, '/');
            pad += '='.repeat((4 - (pad.length % 4)) % 4);
            const role = (JSON.parse(atob(pad)) || {}).role;
            if (role !== 'service_role') keyWarn = 'configured_key_role_is_' + role;
          }
        }
      } catch (e) { keyWarn = 'key_decode_failed'; }
      const base = { build: 'app-1.2.46', now: now(), version: 2, backend: APP_VER };
      if (dbErr || authErr || keyWarn) {
        return send(503, Object.assign({
          ok: false, dbError: dbErr, authError: authErr, keyWarn,
          hint: dbErr && /permission denied/i.test(dbErr)
            ? 'Table privileges missing (42501). Run supabase-grants.sql in the Supabase SQL Editor.'
            : (keyWarn ? 'The Cloudflare secret SUPABASE_SERVICE_ROLE_KEY does not look like a service_role key. Re-copy it from Supabase → Settings → API.'
              : (authErr && /53\d|1016|unreachable|fetch failed|network/i.test(authErr)
                ? 'Supabase endpoint unreachable from Cloudflare (DNS/origin error). Check the project URL/ref.'
                : 'supabase_unreachable'))
        }, base));
      }
      // TEMP diagnostic: when ?diag=1, list each company with its car/employee counts.
      // Lets us confirm whether the 2nd company is a stray empty row or holds teammates' cars.
      let companiesDetail = null;
      if (u.searchParams.get('diag')) {
        try {
          const { data: cos } = await sb.from('companies').select('id,name,code,status,created_at,owner_id');
          if (cos && cos.length) {
            companiesDetail = await Promise.all(cos.map(async (co) => {
              const cars = await sb.from('cars').select('id', { count: 'exact', head: true }).eq('company_id', co.id).eq('deleted', 0);
              const emps = await sb.from('employees').select('id', { count: 'exact', head: true }).eq('company_id', co.id).eq('deleted', 0);
              return { id: co.id, name: co.name, code: co.code, status: co.status, created_at: co.created_at, cars: cars.count || 0, employees: emps.count || 0 };
            }));
          }
        } catch (e) { companiesDetail = { error: String((e && e.message) || e) }; }
      }
      return send(200, Object.assign({ ok: true, cars, companies, companiesDetail }, base));
    }

    /* login (Supabase Auth) */
    if (p === '/api/login' && method === 'POST') {
      const b = await readBody(req);
      const account = String(b.account || b.id || '').trim();
      const password = String(b.password != null ? b.password : (b.pin || ''));
      let email = '';
      let emp = null;
      if (account.includes('@')) email = account.toLowerCase();
      else { emp = await resolveEmployee(account); if (emp) email = (emp.email || (emp.data && emp.data.email) || '').toLowerCase(); }
      // resolve by e-mail too, so the local-hash fallback below can find the record
      if (!emp && email) emp = await resolveEmployee(email);
      const localOk = emp ? await checkPwRecord(password, (emp.data || {})._pw) : false;
      const authUser = email ? await verifyViaSupabase(email, password) : null;
      if (!authUser && !localOk) return send(401, { error: 'bad_credentials' });
      if (!email && !emp) return send(401, { error: 'bad_credentials' });
      // find company: from employee's company, or from company_members of this auth user
      let companyId = emp ? emp.company_id : null;
      if (!companyId && authUser) {
        const { data: cm } = await sb.from('company_members').select('company_id').eq('user_id', authUser.id).limit(1).maybeSingle();
        companyId = cm ? cm.company_id : null;
      }
      if (!companyId) return send(401, { error: 'no_company' });
      const fullEmp = authUser
        ? await ensureEmployeeForUser(authUser, companyId, 'boss')
        : { id: emp.id, company_id: companyId, email: emp.email, data: emp.data };
      const token = await issueToken(fullEmp.id, companyId);
      const co = await companyById(companyId);
      const eObj = stripPw(fullEmp.data || {}); eObj.id = fullEmp.id; eObj.companyId = companyId; eObj.email = fullEmp.email || email;
      return send(200, { token, employee: eObj, company: await publicCompanyWithDomain(co), mustChangePassword: false });
    }

    /* register (creates Supabase Auth user + employee + company) */
    if (p === '/api/register' && method === 'POST') {
      const b = await readBody(req);
      const id = String(b.id || '').trim();
      const pw = String(b.password != null ? b.password : (b.pin || ''));
      const email = String(b.email || '').trim().toLowerCase().slice(0, 120);
      if (!/^[A-Za-z0-9_]{2,20}$/.test(id)) return send(400, { error: 'bad_id', detail: 'id: 2-20 letters/numbers/_' });
      if (pw.length < 8) return send(400, { error: 'weak_password', detail: 'password >= 8 chars' });
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return send(400, { error: 'bad_email' });
      const { data: existing } = await sb.from('employees').select('id').ilike('id', id).eq('deleted', 0).maybeSingle();
      if (existing) return send(409, { error: 'exists', detail: 'account id already used' });
      if (email) { const { data: ex2 } = await sb.from('employees').select('id').eq('email', email).eq('deleted', 0).maybeSingle(); if (ex2) return send(409, { error: 'email_exists' }); }

      const name = (String(b.name || id).trim().slice(0, 60)) || id;
      const wa = String(b.wa || '').replace(/[^0-9]/g, '').slice(0, 20);
      const phone = String(b.phone || '').slice(0, 40);

      // Supabase Auth user creation is BEST-EFFORT. The app has its own session tokens (tokens
      // table) and now also stores a local PBKDF2 hash, so registration must never fail just
      // because the Supabase Auth service is unreachable.
      let authUserId = null;
      let authWarn = null;
      if (email && !authDown) {
        let authUser = null, authErr = null;
        try {
          const created = await sb.auth.admin.createUser({
            email, password: pw, email_confirm: true, user_metadata: { emp_id: id }
          });
          authUser = created.data; authErr = created.error;
        } catch (e) { authErr = { message: String((e && e.message) || e) }; }
        // If the Auth user already exists (e.g. a prior attempt created it but registration
        // didn't finish), reuse it instead of hard-failing — verify the password matches.
        if (authErr && /already|registered|exists/i.test(authErr.message || '')) {
          const sign = await sb.auth.signInWithPassword({ email, password: pw });
          if (sign.data && sign.data.user) { authUser = sign.data.user; authErr = null; }
        }
        if (authErr) {
          authWarn = authErr.message || String(authErr);
          if (isAuthUnreachable(authWarn)) authDown = true;
        } else if (authUser) { authUserId = authUser.id; }
      }

      let companyId, company, tier, role, roleZh, joinBranch = '';
      if (b.companyName && String(b.companyName).trim()) {
        companyId = 'co_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
        const code = await genCompanyCode();
        let logo = null;
        if (b.companyLogo && typeof b.companyLogo === 'string' && b.companyLogo.startsWith('data:image') && b.companyLogo.length < 2_000_000) logo = b.companyLogo;
        const { data: co, error: coErr } = await sb.from('companies').insert({ id: companyId, name: String(b.companyName).trim().slice(0, 80), logo, owner_id: authUserId, code, plan: 'free', status: 'active', permanent: 0, trial_ends_at: now() + TRIAL_DAYS * 864e5, created_at: now() }).select().single();
        if (coErr) return send(500, { error: 'company_create_failed', detail: coErr.message });
        if (authUserId) await sb.from('company_members').insert({ user_id: authUserId, company_id: companyId, role: 'owner', created_at: now() });
        company = co; tier = 'boss'; role = 'Boss / Owner'; roleZh = '老板 / 所有者';
      } else if (b.companyCode && String(b.companyCode).trim()) {
        const { data: co } = await sb.from('companies').select('*').eq('code', String(b.companyCode).trim().toUpperCase()).eq('status', 'active').maybeSingle();
        if (!co) return send(400, { error: 'bad_code', detail: 'invitation code does not match' });
        companyId = co.id; company = co; joinBranch = String(b.branch || '').trim().slice(0, 60);
        tier = 'salesA'; role = 'Senior Sales'; roleZh = '高级销售';
        if (authUserId) await sb.from('company_members').insert({ user_id: authUserId, company_id: companyId, role: 'member', created_at: now() });
      } else {
        return send(400, { error: 'need_company', detail: 'provide companyName to create, or companyCode to join' });
      }

      const data = { name, av: name.charAt(0).toUpperCase(), tier, role, roleZh, wa, phone, branch: joinBranch, _pw: await makePwRecord(pw) };
      const { error: empErr } = await sb.from('employees').upsert({ id, company_id: companyId, user_id: authUserId, data, email: email || null, updated_at: now(), deleted: 0 }, { onConflict: 'id,company_id' });
      if (empErr) return send(500, { error: 'employee_create_failed', detail: empErr.message });
      const token = await issueToken(id, companyId);
      return send(200, { token, employee: Object.assign({ id, companyId, email }, stripPw(data)), company: await publicCompanyWithDomain(company), authWarn });
    }

    /* public (no auth, company-scoped) */
    if (p === '/api/public/cars') {
      const cid = await resolveCompanyId(u, null);
      if (!cid) return send(200, { company: null, cars: [] });
      const { data } = await sb.from('cars').select('*').eq('company_id', cid).eq('deleted', 0).order('updated_at', { ascending: false });
      const rows = (data || []).filter(r => !((r.data || {}).sold));
      // Return the FULL gallery, not just the cover — otherwise a customer browsing
      // the showroom and tapping a car only ever sees one photo (the deep-linked
      // ?c= path was fine because /api/public/car/:id already returns all photos).
      const cars = await Promise.all(rows.map(async (r) => {
        const c = publicCar(r);
        const phw = await photosWithIds(r.id, cid);
        c.cover = phw.urls[0] || null;
        c.photos = phw.urls;
        return c;
      }));
      // Expose the dealer's own identity so a customer-facing page can show the
      // TENANT name instead of falling back to the platform name (Antoto).
      const co = await companyById(cid);
      return send(200, { company: cid, companyInfo: companyInfoOf(co), cars });
    }
    if (p === '/api/showrooms') {
      const cid = await resolveCompanyId(u, null);
      if (!cid) return send(200, { company: null, showrooms: [] });
      const { data } = await sb.from('showrooms').select('data').eq('company_id', cid);
      return send(200, { company: cid, showrooms: (data || []).map(r => r.data) });
    }
    if (p.startsWith('/api/public/car/') && !p.endsWith('/photos')) {
      const id = decodeURIComponent(p.slice('/api/public/car/'.length));
      const { data: row } = await sb.from('cars').select('*').eq('id', id).maybeSingle();
      if (!row) return send(404, { error: 'not_found' });
      const cid = row.company_id;
      const co = await companyById(cid);
      const pubCo = co ? publicCompany(co) : null;
      const companyInfo = pubCo ? companyInfoOf(pubCo) : { id: cid, name: null, logo: null, contact: null };
      const cd = row.data || {};
      const gone = !!row.deleted || !!cd.sold;
      if (gone) return send(200, { gone: true, reason: row.deleted ? 'deleted' : 'sold', company: companyInfo, carName: cd.name || '' });
      const ref = u.searchParams.get('ref');
      const empData = async (eid) => { const { data } = await sb.from('employees').select('data').eq('id', eid).eq('company_id', cid).eq('deleted', 0).maybeSingle(); return data ? stripPw(data.data) : null; };
      let agent = null;
      if (ref) agent = await empData(ref);
      if (!agent && cd.sales) agent = await empData(cd.sales);
      const phw = await photosWithIds(id, cid);
      return send(200, { car: publicCar(row), photos: phw.urls, photoIds: phw.ids, videos: await videosOf(id, cid), agent, company: companyInfo });
    }
    if (p.startsWith('/api/public/car/') && p.endsWith('/photos')) {
      const id = decodeURIComponent(p.slice('/api/public/car/'.length, -'/photos'.length));
      const { data: row } = await sb.from('cars').select('id,company_id,deleted').eq('id', id).maybeSingle();
      if (!row || row.deleted) return send(404, { error: 'not_found' });
      const phw = await photosWithIds(id, row.company_id);
      return send(200, { id, photos: phw.urls, photoIds: phw.ids, videos: await videosOf(id, row.company_id) });
    }

    /* plans */
    if (p === '/api/plans' && method === 'GET') {
      // 三档权益：价格以人民币为基准，美元按固定汇率换算（保留 2 位小数）。
      const plans = Object.values(PLANS).map(p => ({
        id: p.id, name: p.name, nameEn: p.nameEn, rank: p.rank,
        monthly: p.monthly, yearly: p.yearly, currency: 'CNY', fx: FX_CNY_PER_USD,
        quotas: p.quotas, features: p.features
      }));
      return send(200, {
        plans, trialDays: TRIAL_DAYS,
        graceDays: { qr: GRACE_QR_DAYS, domain: GRACE_DOMAIN_DAYS },
        simulate: true, live: false
      });
    }

    /* ---- public, secret-protected one-shot admin ---- */
    if (p === '/api/migrate-photos' && method === 'POST') {
      const secret = u.searchParams.get('secret') || ((await readBody(req)).secret);
      const EXP = env.MIGRATE_SECRET || 'am-migrate-2026';
      if (secret !== EXP) return send(403, { error: 'forbidden' });
      let migrated = 0, errors = 0, skipped = 0; let lastError = null;
      // Photos & videos both live in `data`; convert any legacy base64 blob into a
      // Storage URL written back into `data`. Rows that are already URLs are skipped
      // (idempotent — safe to re-run). We paginate in small batches because the
      // base64 `data` column is huge; one unfiltered select would blow the response
      // size / Worker memory limit.
      async function migrateTable(table, kind) {
        let start = 0;
        while (true) {
          // photos/videos have a composite PK (car_id, idx, company_id) — no `id`
          // column. Select the real columns and update by the composite key.
          const { data: rows, error } = await sb.from(table)
            .select('car_id,company_id,idx,data')
            .order('company_id').order('car_id').order('idx')
            .range(start, start + 4);
          if (error) { lastError = (lastError ? lastError + ' | ' : '') + table + ': ' + (error.message || error); errors++; break; }
          if (!rows || !rows.length) break;
          for (const r of rows) {
            if (!r.data || /^https?:\/\//.test(r.data)) { skipped++; continue; }
            try {
              const url = await uploadToStorage(r.data, r.company_id, r.car_id, kind);
              const { error: ue } = await sb.from(table)
                .update({ data: url })
                .eq('car_id', r.car_id).eq('company_id', r.company_id).eq('idx', r.idx);
              if (ue) throw new Error(ue.message || ue);
              migrated++;
            }
            catch (e) { errors++; }
          }
          if (rows.length < 5) break;
          start += 5;
        }
      }
      await migrateTable('photos', 'photo');
      await migrateTable('videos', 'video');
      return send(200, { ok: true, migrated, errors, skipped, lastError });
    }

    /* ---- secret-protected maintenance: drop photo/video rows whose car no longer exists --- */
    if (p === '/api/photos-gc' && method === 'POST') {
      const secret = u.searchParams.get('secret') || ((await readBody(req)).secret);
      const EXP = env.MIGRATE_SECRET || 'am-migrate-2026';
      if (secret !== EXP) return send(403, { error: 'forbidden' });
      // A car that exists in ANY state (incl. soft-deleted) still owns its photos, so it counts
      // as "known". Only rows pointing at a car that is completely gone are orphans. Idempotent.
      const { data: cars, error: ce } = await sb.from('cars').select('id,company_id');
      if (ce) return send(500, { error: 'cars_select_failed', detail: ce.message || String(ce) });
      const known = new Set((cars || []).map(r => r.company_id + '/' + r.id));
      const removed = { photos: 0, videos: 0 };
      for (const table of ['photos', 'videos']) {
        const orphans = [];
        let from = 0;
        while (true) {
          const { data: rows, error } = await sb.from(table).select('car_id,company_id,idx')
            .order('company_id').order('car_id').order('idx').range(from, from + 199);
          if (error) return send(500, { error: table + '_select_failed', detail: error.message || String(error) });
          if (!rows || !rows.length) break;
          for (const r of rows) if (!known.has(r.company_id + '/' + r.car_id)) orphans.push(r);
          if (rows.length < 200) break;
          from += 200;
        }
        for (const r of orphans) {
          const { error: de } = await sb.from(table).delete()
            .eq('company_id', r.company_id).eq('car_id', r.car_id).eq('idx', r.idx);
          if (!de) removed[table]++;
        }
      }
      return send(200, { ok: true, removedPhotos: removed.photos, removedVideos: removed.videos });
    }

    /* ---- authenticated below ---- */
    const emp = await authOf(req);
    if (!emp) return send(401, { error: 'unauthorized' });

    if (p === '/api/me') {
      const co = await companyById(emp.companyId);
      return send(200, { employee: emp, canEditPrices: isTop(emp), company: await publicCompanyWithDomain(co), membership: co ? membershipView(co) : null, mustChangePassword: false });
    }
    if (p === '/api/company' && method === 'GET') {
      if (!isTop(emp)) return send(403, { error: 'forbidden' });
      const co = await companyById(emp.companyId);
      return send(200, { company: await publicCompanyWithDomain(co), membership: co ? membershipView(co) : null });
    }
    if (p === '/api/company' && method === 'PUT') {
      if (!isTop(emp)) return send(403, { error: 'forbidden' });
      const b = await readBody(req);
      const co = await companyById(emp.companyId);
      if (!co) return send(404, { error: 'not_found' });
      if (b.name !== undefined) co.name = String(b.name).trim().slice(0, 80);
      if (b.logo !== undefined) { if (b.logo && typeof b.logo === 'string' && b.logo.startsWith('data:image') && b.logo.length < 2_000_000) co.logo = b.logo; else if (b.logo === null || b.logo === '') co.logo = null; }
      if (b.bio !== undefined) co.bio = String(b.bio || '').slice(0, 500);
      if (b.contact && typeof b.contact === 'object') {
        const c = b.contact;
        if (c.name !== undefined) co.contact_name = c.name ? String(c.name).trim().slice(0, 60) : null;
        if (c.phone !== undefined) co.contact_phone = c.phone ? String(c.phone).trim().slice(0, 40) : null;
        if (c.wa !== undefined) co.contact_wa = c.wa ? String(c.wa).trim().slice(0, 40) : null;
      }
      await sb.from('companies').update({ name: co.name, logo: co.logo, bio: co.bio, contact_name: co.contact_name, contact_phone: co.contact_phone, contact_wa: co.contact_wa }).eq('id', emp.companyId);
      return send(200, { company: await publicCompanyWithDomain(co) });
    }
    if (p === '/api/company/code' && method === 'GET') {
      if (!isTop(emp)) return send(403, { error: 'forbidden' });
      const co = await companyById(emp.companyId);
      return send(200, { code: co ? co.code : null });
    }
    if (p === '/api/company/code' && method === 'POST') {
      if (!isTop(emp)) return send(403, { error: 'forbidden' });
      const code = await genCompanyCode();
      await sb.from('companies').update({ code }).eq('id', emp.companyId);
      return send(200, { code });
    }
    if (p === '/api/company/bind' && method === 'POST') {
      const b = await readBody(req);
      const want = String(b.code || '').trim().toUpperCase();
      const co = await companyById(emp.companyId);
      const real = (co && co.code || '').toUpperCase();
      if (!real || want !== real) return send(400, { error: 'bad_code' });
      const BIND_TIERS = ['partnerA', 'manager', 'salesA', 'salesB'];
      const tier = String(b.tier || '');
      if (!BIND_TIERS.includes(tier)) return send(400, { error: 'bad_tier' });
      const branch = String(b.branch || '').trim().slice(0, 60);
      const wa = String(b.wa || '').replace(/[^0-9]/g, '').slice(0, 20);
      const phone = String(b.phone || '').slice(0, 40);
      const { data: row } = await sb.from('employees').select('*').eq('id', emp.id).eq('company_id', emp.companyId).maybeSingle();
      if (!row) return send(404, { error: 'not_found' });
      const d = row.data || {};
      const ROLE = { partnerA: 'Co-owner (Partner)', manager: 'Manager', salesA: 'Senior Sales', salesB: 'Sales' };
      const ROLE_ZH = { partnerA: '合伙人', manager: '经理', salesA: '高级销售', salesB: '销售' };
      d.tier = tier; d.branch = branch; if (wa) d.wa = wa; if (phone) d.phone = phone;
      d.role = ROLE[tier] + (branch ? ' · ' + branch : '');
      d.roleZh = ROLE_ZH[tier] + (branch ? ' · ' + branch : '');
      await sb.from('employees').update({ data: d, updated_at: now() }).eq('id', emp.id).eq('company_id', emp.companyId);
      return send(200, { employee: Object.assign({ id: emp.id, companyId: emp.companyId }, stripPw(d)) });
    }
    if (p === '/api/membership' && method === 'GET') {
      const co = await companyById(emp.companyId);
      return send(200, { membership: co ? membershipView(co) : null });
    }
    if (p === '/api/subscribe' && method === 'POST') {
      if (!isTop(emp)) return send(403, { error: 'forbidden' });
      const b = await readBody(req);
      let tier = String(b.planId || '');
      let cycle = (String(b.cycle || 'monthly') === 'yearly') ? 'yearly' : 'monthly';
      // 兼容旧调用：planId='monthly'|'yearly' → 普通会员对应的周期
      if (tier === 'monthly' || tier === 'yearly') { cycle = (tier === 'yearly') ? 'yearly' : 'monthly'; tier = 'standard'; }
      const plan = PLANS[tier];
      const priceRow = plan ? plan[cycle] : null;
      if (!plan || !priceRow || priceRow.cny <= 0) return send(400, { error: 'bad_plan' });
      const co = await companyById(emp.companyId);
      if (co && co.permanent) return send(409, { error: 'permanent', detail: 'lifetime membership — no subscription needed', simulate: true });
      const outTradeNo = 'AM' + now().toString(36).toUpperCase() + crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
      await sb.from('orders').insert({ out_trade_no: outTradeNo, company_id: emp.companyId, plan_id: tier + '_' + cycle, amount: priceRow.cny, status: 'pending', created_at: now() });
      const payUrl = `/api/alipay/simulate?out_trade_no=${outTradeNo}`;
      return send(200, { ok: true, outTradeNo, payUrl, simulate: true, amount: priceRow.cny, amountUsd: priceRow.usd, currency: 'CNY', cycle, planId: tier, planName: plan.name });
    }
    if (p === '/api/alipay/simulate' && method === 'POST') {
      const b = await readBody(req);
      const { data: order } = await sb.from('orders').select('*').eq('out_trade_no', b.outTradeNo).maybeSingle();
      if (!order) return send(404, { error: 'no_order' });
      if (order.status !== 'paid') { await sb.from('orders').update({ status: 'paid', paid_at: now() }).eq('out_trade_no', b.outTradeNo); await activatePlan(order.company_id, order.plan_id, 'SIM_' + b.outTradeNo); }
      return send(200, { ok: true });
    }
    if (p === '/api/employees' && method === 'POST') {
      if (!isTop(emp)) return send(403, { error: 'forbidden' });
      const co = await companyById(emp.companyId);
      if (co && membershipView(co).expired) return send(402, { error: 'payment_required' });
      // 额度：员工数上限（**服务端强制**）。超限返回 402 + 明确上限，前端据此提示升级。
      {
        const q = await quotaCheck(emp.companyId, co ? membershipView(co).plan : null, 'employees');
        if (!q.ok) return send(402, { error: 'quota_employees', limit: q.limit, used: q.used });
      }
      const b = await readBody(req);
      const id = String(b.id || '').trim();
      const tier = String(b.tier || '');
      const TIERS = ['boss', 'partnerA', 'partnerB', 'manager', 'salesA', 'salesB'];
      if (!/^[A-Za-z0-9_]{2,20}$/.test(id)) return send(400, { error: 'bad_id' });
      if (!TIERS.includes(tier)) return send(400, { error: 'bad_tier' });
      const staffPw = String(b.password != null ? b.password : (b.pin || ''));
      if (staffPw.length < 8) return send(400, { error: 'weak_password' });
      const staffEmail = String(b.email || '').trim().toLowerCase().slice(0, 120);
      if (staffEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(staffEmail)) return send(400, { error: 'bad_email' });
      const { data: existing } = await sb.from('employees').select('id').ilike('id', id).eq('company_id', emp.companyId).eq('deleted', 0).maybeSingle();
      if (existing) return send(409, { error: 'exists' });
      const name = String(b.name || id).trim().slice(0, 60);
      const branch = String(b.branch || '').trim().slice(0, 60);
      const wa = String(b.wa || '').replace(/[^0-9]/g, '').slice(0, 20);
      const phone = String(b.phone || '').slice(0, 40);
      const ROLE = { boss: 'Boss / Owner', partnerA: 'Co-owner', partnerB: 'Co-owner', manager: 'Manager', salesA: 'Senior Sales', salesB: 'Sales' };
      const ROLE_ZH = { boss: '老板 / 所有者', partnerA: '合伙人', partnerB: '合伙人', manager: '经理', salesA: '高级销售', salesB: '销售' };
      const data = { name, av: (name || id).charAt(0).toUpperCase(), tier, role: ROLE[tier] + (branch ? ' · ' + branch : ''), roleZh: ROLE_ZH[tier] + (branch ? ' · ' + branch : ''), wa, phone, branch, _pw: await makePwRecord(staffPw) };
      const { error } = await sb.from('employees').insert({ id, company_id: emp.companyId, data, email: staffEmail || null, updated_at: now(), deleted: 0 });
      if (error) return send(400, { error: error.message });
      // best-effort: also provision a Supabase Auth account (ignored when Auth is unreachable)
      if (staffEmail && !authDown) {
        try {
          const r = await sb.auth.admin.createUser({ email: staffEmail, password: staffPw, email_confirm: true, user_metadata: { emp_id: id } });
          if (r && r.error && isAuthUnreachable(r.error.message)) authDown = true;
        } catch (e) { /* ignore — local hash already stored */ }
      }
      return send(200, { ok: true, id, name: data.name });
    }
    if (p === '/api/employees' && method === 'DELETE') {
      if (!isTop(emp)) return send(403, { error: 'forbidden' });
      const b = await readBody(req).catch(() => ({}));
      const id = String((b && b.id) || '').trim();
      if (!id) return send(400, { error: 'bad_id' });
      if (id === emp.id) return send(400, { error: 'self_delete' });
      const { data: row } = await sb.from('employees').select('*').eq('id', id).eq('company_id', emp.companyId).eq('deleted', 0).maybeSingle();
      if (!row) return send(404, { error: 'not_found' });
      const td = row.data || {};
      if (td.tier === 'boss') { const { count } = await sb.from('employees').select('*', { count: 'exact', head: true }).eq('company_id', emp.companyId).eq('deleted', 0).eq('data->>tier', 'boss'); if (count <= 1) return send(400, { error: 'last_owner' }); }
      await sb.from('employees').update({ deleted: 1, updated_at: now() }).eq('id', id).eq('company_id', emp.companyId);
      return send(200, { ok: true, id });
    }
    if (p === '/api/password/change' && method === 'POST') {
      const b = await readBody(req);
      const npw = String(b.password != null ? b.password : (b.pin || ''));
      if (npw.length < 8) return send(400, { error: 'weak_password', detail: 'password >= 8 chars' });
      const { data: row } = await sb.from('employees').select('*').eq('id', emp.id).eq('company_id', emp.companyId).eq('deleted', 0).maybeSingle();
      if (!row) return send(404, { error: 'not_found' });
      const d = row.data || {};
      d._pw = await makePwRecord(npw);
      const { error: upErr } = await sb.from('employees').update({ data: d, updated_at: now() }).eq('id', emp.id).eq('company_id', emp.companyId);
      if (upErr) return send(500, { error: 'update_failed', detail: upErr.message });
      // best-effort sync with Supabase Auth (ignored when Auth is unreachable)
      try {
        const email = row.email || d.email;
        if (email && !authDown) {
          if (row.user_id) await sb.auth.admin.updateUserById(row.user_id, { password: npw });
          else {
            const list = await sb.auth.admin.listUsers({ page: 1, perPage: 200 });
            const u = ((list.data && list.data.users) || []).find(x => (x.email || '').toLowerCase() === String(email).toLowerCase());
            if (u) await sb.auth.admin.updateUserById(u.id, { password: npw });
          }
        }
      } catch (e) { /* ignore — the local hash is already updated */ }
      return send(200, { ok: true });
    }
    if (p === '/api/account/email' && method === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase().slice(0, 120);
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return send(400, { error: 'bad_email' });
      await sb.from('employees').update({ email: email || null, updated_at: now() }).eq('id', emp.id).eq('company_id', emp.companyId);
      return send(200, { ok: true, email });
    }
    if (p.startsWith('/api/car/') && p.endsWith('/photos')) {
      const cid = decodeURIComponent(p.slice('/api/car/'.length, -'/photos'.length));
      const { data: row } = await sb.from('cars').select('id').eq('id', cid).eq('company_id', emp.companyId).eq('deleted', 0).maybeSingle();
      if (!row) return send(404, { error: 'not_found' });
      const phw = await photosWithIds(cid, emp.companyId);
      return send(200, { id: cid, photos: phw.urls, photoIds: phw.ids, videos: await videosOf(cid, emp.companyId) });
    }
    if (p === '/api/upload' && method === 'POST') {
      const b = await readBody(req);
      const dataUrl = b && b.dataUrl;
      const carId = b && b.carId;
      if (!dataUrl || typeof dataUrl !== 'string' || !/^data:/.test(dataUrl)) return send(400, { error: 'bad_dataurl' });
      try {
        const url = await uploadToStorage(dataUrl, emp.companyId, carId || 'unknown', 'photo');
        return send(200, { ok: true, url });
      } catch (e) { return send(500, { error: 'upload_failed', detail: String((e && e.message) || e) }); }
    }
    if (p === '/api/pull') {
      const out = await pull(u.searchParams.get('since'), u.searchParams.get('photos') === '1', emp.companyId);
      return send(200, out);
    }
    if (p === '/api/push' && method === 'POST') {
      const co = await companyById(emp.companyId);
      if (co && membershipView(co).expired) return send(402, { error: 'payment_required', simulate: true });
      const b = await readBody(req);
      const r = await applyPush(emp, b);
      return send(200, Object.assign({ now: now() }, r));
    }
    if (p === '/api/clear-sample' && method === 'POST') {
      const allIds = [...SEED_CAR_IDS];
      if (allIds.length) {
        const { data: existing } = await sb.from('cars').select('id').eq('company_id', emp.companyId).in('id', allIds).eq('deleted', 0);
        if (existing && existing.length) {
          const ids = existing.map(r => r.id);
          await sb.from('photos').delete().eq('company_id', emp.companyId).in('car_id', ids);
          await sb.from('videos').delete().eq('company_id', emp.companyId).in('car_id', ids);
          await sb.from('cars').update({ deleted: 1, updated_at: now() }).eq('company_id', emp.companyId).in('id', ids);
        }
      }
      if (DEMO_SHOWROOM_NAMES.length) await sb.from('showrooms').delete().eq('company_id', emp.companyId).in('id', DEMO_SHOWROOM_NAMES);
      return send(200, { ok: true, carsCleared: 0, clearedIds: [] });
    }
    if (p === '/api/clear-sample-employees' && method === 'POST') {
      const allIds = [...DEMO_EMP_IDS].filter(id => id !== 'boss' && id !== emp.id);
      if (allIds.length) await sb.from('employees').update({ deleted: 1, updated_at: now() }).eq('company_id', emp.companyId).in('id', allIds).eq('deleted', 0);
      return send(200, { ok: true, employeesCleared: allIds.length, clearedIds: allIds });
    }
    if (p === '/api/audit' && isTop(emp)) {
      const { data } = await sb.from('audit').select('*').eq('company_id', emp.companyId).order('id', { ascending: false }).limit(200);
      return send(200, { rows: data || [] });
    }

    return send(404, { error: 'no_route' });
  } catch (e) {
    console.error('[err]', e && e.message, e && e.stack);
    return send(500, { error: 'server_error', detail: String(e && e.message ? e.message : e) });
  }
}
