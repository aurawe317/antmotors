/*
 * Ant Motors — Cloudflare Pages Functions 后端（Supabase 多租户）
 * 替代原 server.js（node:sqlite）。前端 index.html 保持不变，仍走 /api/*。
 *
 * 部署：Cloudflare Pages，构建输出目录 = app，本文件提供 /api/*。
 * 环境变量（在 Cloudflare Pages → Settings → Environment variables 设置，service_role 用 Secret）：
 *   SUPABASE_URL                   = https://<ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY      = <service_role key>  （仅服务端用，切勿暴露给浏览器）
 *
 * 鉴权：登录/注册/改密 均走 Supabase Auth（邮箱+密码）。登录成功后签发本应用的
 * 会话 token（存 tokens 表），前端无需改动。首登无员工档案时按老板自动建档。
 */
import { createClient } from '@supabase/supabase-js';

// Supabase 客户端在首个请求时用 context.env 初始化（Cloudflare Workers 无 process.env）
let SUPABASE_URL = '';
let SUPABASE_KEY = '';
let sb = null;
function getSb(env) {
  if (!sb) {
    SUPABASE_URL = env.SUPABASE_URL || 'https://mcjvlohnyfkvmftrvxeq.supabase.co';
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

const PLANS = {
  trial:   { id: 'trial',   name: '试用',     nameEn: 'Trial',     price: 0,     days: 14,  currency: 'CNY' },
  monthly: { id: 'monthly',  name: '月付会员', nameEn: 'Monthly',  price: 3500,  days: 30,  currency: 'CNY' },
  yearly:  { id: 'yearly',   name: '年付会员', nameEn: 'Yearly',   price: 35000, days: 365, currency: 'CNY' }
};

const now = () => Date.now();
const clampTs = (t) => { const n = now(); const v = +t; return (!v || v > n) ? n : v; };
const isTop = (emp) => !!emp && TOP_TIERS.includes(emp.tier);

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
  return { id: row.id, name: row.name, logo: row.logo || null, bio: row.bio || '', code: row.code, plan: row.plan, status: row.status, permanent: !!row.permanent };
}
function membershipView(row) {
  const isPermanent = !!row.permanent;
  if (isPermanent) return { plan: row.plan || 'owner', planName: '永久会员', planNameEn: 'Lifetime', status: 'active', active: true, expired: false, periodEnd: 0, canSell: true, isPermanent: true };
  const t = now();
  let plan = row.plan || 'trial';
  let periodEnd = +row.current_period_end || 0;
  let active = true;
  if (plan === 'trial') {
    periodEnd = periodEnd || (+row.trial_ends_at || (row.created_at + TRIAL_DAYS * 864e5));
    active = t < periodEnd;
  } else {
    active = row.status === 'active' && t < periodEnd;
  }
  const m = PLANS[plan] || PLANS.trial;
  return { plan, planName: m.name, planNameEn: m.nameEn, status: row.status, active, expired: !active, periodEnd, canSell: active, isPermanent: false };
}
async function activatePlan(companyId, planId, tradeNo) {
  const p = PLANS[planId]; if (!p) return;
  const start = now(); const end = start + p.days * 864e5;
  await sb.from('companies').update({ plan: planId, status: 'active', plan_started_at: start, current_period_end: end, alipay_trade_no: tradeNo || '', subscription_id: tradeNo || '', last_paid_at: start }).eq('id', companyId);
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
/* verify password via Supabase Auth using the employee's e-mail */
async function verifyViaSupabase(email, password) {
  if (!email) return null;
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data.user) return null;
  return data.user; // {id, email}
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
  const emp = e.data || {};
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
async function photosOf(id, cid) {
  const { data } = await sb.from('photos').select('data').eq('car_id', id).eq('company_id', cid).order('idx', { ascending: true });
  return (data || []).map(r => r.data);
}
async function writePhotos(id, arr, cid) {
  await sb.from('photos').delete().eq('car_id', id).eq('company_id', cid);
  if (!Array.isArray(arr)) return;
  const rows = arr.slice(0, 12).filter(d => typeof d === 'string' && d.length < 6e6).map((d, i) => ({ car_id: id, company_id: cid, idx: i, data: d }));
  if (rows.length) await sb.from('photos').insert(rows);
}
async function videosOf(id, cid) {
  const { data } = await sb.from('videos').select('data').eq('car_id', id).eq('company_id', cid).order('idx', { ascending: true });
  return (data || []).map(r => r.data);
}
async function writeVideos(id, arr, cid) {
  await sb.from('videos').delete().eq('car_id', id).eq('company_id', cid);
  if (!Array.isArray(arr)) return;
  const rows = arr.slice(0, 3).filter(d => typeof d === 'string' && d.length < 25e6).map((d, i) => ({ car_id: id, company_id: cid, idx: i, data: d }));
  if (rows.length) await sb.from('videos').insert(rows);
}

/* --------------------------------------------------------------------- sync */
function publicCar(row) {
  const c = row.data || {};
  const quote = c.price && typeof c.price.quote === 'number' ? c.price.quote : null;
  const out = Object.assign({}, c, { id: row.id, listedAt: row.listed_at });
  out.price = { quote };
  return out;
}
async function resolveCompanyId(u, emp) {
  const ref = u.searchParams.get('ref');
  if (ref) { const { data: e } = await sb.from('employees').select('company_id').eq('id', ref).eq('deleted', 0).maybeSingle(); if (e) return e.company_id; }
  const cp = u.searchParams.get('company');
  if (cp) { const { data: c } = await sb.from('companies').select('id').eq('id', cp).maybeSingle(); if (c) return c.id; }
  return emp ? emp.companyId : null;
}
const SEED_CAR_IDS = new Set();   // 演示车 id（无种子文件时为空，由运营清样例处理）
const DEMO_EMP_IDS = new Set();
const DEMO_SHOWROOM_NAMES = ['Accra Branch', 'Tema Branch', 'Kumasi Branch'];

async function applyPush(emp, payload) {
  const applied = [], rejected = [];
  const top = isTop(emp);
  const cid = emp.companyId;
  for (const c of (payload.cars || [])) {
    if (!c || !c.id) continue;
    const { data: cur } = await sb.from('cars').select('*').eq('id', c.id).eq('company_id', cid).maybeSingle();
    if (cur && cur.deleted && SEED_CAR_IDS.has(c.id)) { rejected.push({ id: c.id, reason: 'sample_cleared' }); continue; }
    const ts = clampTs(c.updatedAt);
    if (cur && cur.updated_at > ts) { rejected.push({ id: c.id, reason: 'stale' }); continue; }
    const incoming = c.data || {};
    if (!top) {
      const oldPrice = cur ? (cur.data || {}).price : null;
      const newPrice = incoming.price || null;
      if (JSON.stringify(oldPrice) !== JSON.stringify(newPrice)) {
        if (cur) { incoming.price = oldPrice; rejected.push({ id: c.id, reason: 'price_forbidden' }); }
        else { rejected.push({ id: c.id, reason: 'price_forbidden' }); continue; }
      }
    }
    await sb.from('cars').upsert({ id: c.id, company_id: cid, data: incoming, listed_at: c.listedAt || null, updated_at: ts, updated_by: emp.id, deleted: c.deleted ? 1 : 0 }, { onConflict: 'id,company_id' });
    if (c.photos) await writePhotos(c.id, c.photos, cid);
    if (c.videos) await writeVideos(c.id, c.videos, cid);
    applied.push(c.id);
  }
  for (const e of (payload.employees || [])) {
    if (!e || !e.id) continue;
    const { data: cur } = await sb.from('employees').select('*').eq('id', e.id).eq('company_id', cid).maybeSingle();
    const ts = clampTs(e.updatedAt);
    if (!cur) { rejected.push({ id: e.id, reason: 'unknown_employee' }); continue; }
    if (cur.deleted && DEMO_EMP_IDS.has(e.id)) { rejected.push({ id: e.id, reason: 'sample_cleared' }); continue; }
    if (cur.updated_at > ts) { rejected.push({ id: e.id, reason: 'stale' }); continue; }
    const old = cur.data || {};
    const inc = e.data || {};
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
  const carList = await Promise.all((cars || []).map(async (r) => ({
    id: r.id, companyId: r.company_id, data: r.data, listedAt: r.listed_at,
    updatedAt: r.updated_at, updatedBy: r.updated_by, deleted: !!r.deleted,
    photos: withPhotos ? await photosOf(r.id, companyId) : undefined,
    videos: withPhotos ? await videosOf(r.id, companyId) : undefined
  })));
  const { data: emps } = await sb.from('employees').select('*').eq('company_id', companyId).gt('updated_at', s).order('updated_at', { ascending: true });
  const empList = (emps || []).map(r => ({ id: r.id, companyId: r.company_id, data: r.data, updatedAt: r.updated_at, deleted: !!r.deleted }));
  return { now: now(), cars: carList, employees: empList };
}

/* --------------------------------------------------------------------- router */
export async function onRequest(context) {
  const { request } = context;
  const env = context.env || {};
  // SUPABASE_URL falls back to the known project URL (it is public). The service_role
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
    /* health — now honestly reports Supabase connectivity */
    if (p === '/api/health') {
      const dbCheck = await sb.from('cars').select('*', { count: 'exact', head: true }).eq('deleted', 0);
      const coCheck = await sb.from('companies').select('*', { count: 'exact', head: true });
      const authCheck = await sb.auth.admin.listUsers({ page: 1, perPage: 1 });
      const dbErr = (dbCheck.error && dbCheck.error.message) || (coCheck.error && coCheck.error.message) || null;
      const authErr = (authCheck.error && authCheck.error.message) || null;
      if (dbErr || authErr) {
        return send(503, {
          ok: false,
          dbError: dbErr,
          authError: authErr,
          hint: authErr && /530/i.test(authErr) ? 'Supabase Auth returned HTTP 530. Try restarting the project in Supabase Dashboard.' : 'supabase_unreachable',
          now: now(), version: 2, backend: APP_VER
        });
      }
      return send(200, { ok: true, cars: dbCheck.count || 0, companies: coCheck.count || 0, now: now(), version: 2, backend: APP_VER });
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
      if (!email) return send(401, { error: 'bad_credentials' });
      const authUser = await verifyViaSupabase(email, password);
      if (!authUser) return send(401, { error: 'bad_credentials' });
      // find company: from employee's company, or from company_members of this auth user
      let companyId = emp ? emp.company_id : null;
      if (!companyId) {
        const { data: cm } = await sb.from('company_members').select('company_id').eq('user_id', authUser.id).limit(1).maybeSingle();
        companyId = cm ? cm.company_id : null;
      }
      if (!companyId) return send(401, { error: 'no_company' });
      const fullEmp = await ensureEmployeeForUser(authUser, companyId, 'boss');
      const token = await issueToken(fullEmp.id, companyId);
      const co = await companyById(companyId);
      const eObj = fullEmp.data || {}; eObj.id = fullEmp.id; eObj.companyId = companyId; eObj.email = fullEmp.email || email;
      return send(200, { token, employee: eObj, company: co ? publicCompany(co) : null, mustChangePassword: false });
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

      // create Supabase Auth user (only when an e-mail is provided; otherwise the
      // account is local-only until an e-mail + password are set later)
      let authUserId = null;
      if (email) {
        let authUser = null, authErr = null;
        const created = await sb.auth.admin.createUser({
          email, password: pw, email_confirm: true, user_metadata: { emp_id: id }
        });
        authUser = created.data; authErr = created.error;
        // If the Auth user already exists (e.g. a prior attempt created it but registration
        // didn't finish), reuse it instead of hard-failing — verify the password matches.
        if (authErr && /already|registered|exists/i.test(authErr.message || '')) {
          const sign = await sb.auth.signInWithPassword({ email, password: pw });
          if (sign.data && sign.data.user) { authUser = sign.data.user; authErr = null; }
        }
        if (authErr) {
          const msg = authErr.message || String(authErr);
          if (/530/i.test(msg)) {
            return send(503, { error: 'auth_create_failed', detail: 'Supabase Auth returned HTTP 530 (origin unreachable). Please open Supabase Dashboard → ant motors → Restart project, wait 30s, then try again.', retryAfter: 30 });
          }
          return send(400, { error: 'auth_create_failed', detail: msg });
        }
        authUserId = authUser.id;
      }

      let companyId, company, tier, role, roleZh, joinBranch = '';
      if (b.companyName && String(b.companyName).trim()) {
        companyId = 'co_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
        const code = await genCompanyCode();
        let logo = null;
        if (b.companyLogo && typeof b.companyLogo === 'string' && b.companyLogo.startsWith('data:image') && b.companyLogo.length < 2_000_000) logo = b.companyLogo;
        const { data: co } = await sb.from('companies').insert({ id: companyId, name: String(b.companyName).trim().slice(0, 80), logo, owner_id: authUserId, code, plan: 'trial', status: 'active', permanent: 0, trial_ends_at: now() + TRIAL_DAYS * 864e5, created_at: now() }).select().single();
        await sb.from('company_members').insert({ user_id: authUserId, company_id: companyId, role: 'owner', created_at: now() });
        company = co; tier = 'boss'; role = 'Boss / Owner'; roleZh = '老板 / 所有者';
      } else if (b.companyCode && String(b.companyCode).trim()) {
        const { data: co } = await sb.from('companies').select('*').eq('code', String(b.companyCode).trim().toUpperCase()).eq('status', 'active').maybeSingle();
        if (!co) return send(400, { error: 'bad_code', detail: 'invitation code does not match' });
        companyId = co.id; company = co; joinBranch = String(b.branch || '').trim().slice(0, 60);
        tier = 'salesA'; role = 'Senior Sales'; roleZh = '高级销售';
        await sb.from('company_members').insert({ user_id: authUserId, company_id: companyId, role: 'member', created_at: now() });
      } else {
        return send(400, { error: 'need_company', detail: 'provide companyName to create, or companyCode to join' });
      }

      const data = { name, av: name.charAt(0).toUpperCase(), tier, role, roleZh, wa, phone, branch: joinBranch };
      await sb.from('employees').upsert({ id, company_id: companyId, user_id: authUserId, data, email: email || null, updated_at: now(), deleted: 0 }, { onConflict: 'id,company_id' });
      const token = await issueToken(id, companyId);
      return send(200, { token, employee: Object.assign({ id, companyId, email }, data), company: company ? publicCompany(company) : null });
    }

    /* public (no auth, company-scoped) */
    if (p === '/api/public/cars') {
      const cid = await resolveCompanyId(u, null);
      if (!cid) return send(200, { company: null, cars: [] });
      const { data } = await sb.from('cars').select('*').eq('company_id', cid).eq('deleted', 0).order('updated_at', { ascending: false });
      const cars = (data || []).filter(r => !((r.data || {}).sold)).map(publicCar);
      return send(200, { company: cid, cars });
    }
    if (p === '/api/showrooms') {
      const cid = await resolveCompanyId(u, null);
      if (!cid) return send(200, { company: null, showrooms: [] });
      const { data } = await sb.from('showrooms').select('data').eq('company_id', cid);
      return send(200, { company: cid, showrooms: (data || []).map(r => r.data) });
    }
    if (p.startsWith('/api/public/car/')) {
      const id = decodeURIComponent(p.slice('/api/public/car/'.length));
      const { data: row } = await sb.from('cars').select('*').eq('id', id).maybeSingle();
      if (!row) return send(404, { error: 'not_found' });
      const cid = row.company_id;
      const co = await companyById(cid);
      const pubCo = co ? publicCompany(co) : null;
      const companyInfo = pubCo ? { id: pubCo.id, name: pubCo.name, logo: pubCo.logo } : { id: cid, name: null, logo: null };
      const cd = row.data || {};
      const gone = !!row.deleted || !!cd.sold;
      if (gone) return send(200, { gone: true, reason: row.deleted ? 'deleted' : 'sold', company: companyInfo, carName: cd.name || '' });
      const ref = u.searchParams.get('ref');
      const empData = async (eid) => { const { data } = await sb.from('employees').select('data').eq('id', eid).eq('company_id', cid).eq('deleted', 0).maybeSingle(); return data ? data.data : null; };
      let agent = null;
      if (ref) agent = await empData(ref);
      if (!agent && cd.sales) agent = await empData(cd.sales);
      return send(200, { car: publicCar(row), photos: await photosOf(id, cid), videos: await videosOf(id, cid), agent, company: companyInfo });
    }

    /* plans */
    if (p === '/api/plans' && method === 'GET') {
      return send(200, { plans: Object.values(PLANS).map(p => ({ id: p.id, name: p.name, nameEn: p.nameEn, price: p.price, days: p.days, currency: p.currency })), simulate: true, live: false });
    }

    /* ---- authenticated below ---- */
    const emp = await authOf(req);
    if (!emp) return send(401, { error: 'unauthorized' });

    if (p === '/api/me') {
      const co = await companyById(emp.companyId);
      return send(200, { employee: emp, canEditPrices: isTop(emp), company: co ? publicCompany(co) : null, membership: co ? membershipView(co) : null, mustChangePassword: false });
    }
    if (p === '/api/company' && method === 'GET') {
      if (!isTop(emp)) return send(403, { error: 'forbidden' });
      const co = await companyById(emp.companyId);
      return send(200, { company: co ? publicCompany(co) : null, membership: co ? membershipView(co) : null });
    }
    if (p === '/api/company' && method === 'PUT') {
      if (!isTop(emp)) return send(403, { error: 'forbidden' });
      const b = await readBody(req);
      const co = await companyById(emp.companyId);
      if (!co) return send(404, { error: 'not_found' });
      if (b.name !== undefined) co.name = String(b.name).trim().slice(0, 80);
      if (b.logo !== undefined) { if (b.logo && typeof b.logo === 'string' && b.logo.startsWith('data:image') && b.logo.length < 2_000_000) co.logo = b.logo; else if (b.logo === null || b.logo === '') co.logo = null; }
      if (b.bio !== undefined) co.bio = String(b.bio || '').slice(0, 500);
      await sb.from('companies').update({ name: co.name, logo: co.logo, bio: co.bio }).eq('id', emp.companyId);
      return send(200, { company: publicCompany(co) });
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
      return send(200, { employee: Object.assign({ id: emp.id, companyId: emp.companyId }, d) });
    }
    if (p === '/api/membership' && method === 'GET') {
      const co = await companyById(emp.companyId);
      return send(200, { membership: co ? membershipView(co) : null });
    }
    if (p === '/api/subscribe' && method === 'POST') {
      if (!isTop(emp)) return send(403, { error: 'forbidden' });
      const b = await readBody(req);
      const plan = PLANS[String(b.planId || '')];
      if (!plan || plan.price <= 0) return send(400, { error: 'bad_plan' });
      const co = await companyById(emp.companyId);
      if (co && co.permanent) return send(409, { error: 'permanent', detail: 'lifetime membership — no subscription needed', simulate: true });
      const outTradeNo = 'AM' + now().toString(36).toUpperCase() + crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
      await sb.from('orders').insert({ out_trade_no: outTradeNo, company_id: emp.companyId, plan_id: plan.id, amount: plan.price, status: 'pending', created_at: now() });
      const payUrl = `/api/alipay/simulate?out_trade_no=${outTradeNo}`;
      return send(200, { ok: true, outTradeNo, payUrl, simulate: true, amount: plan.price, planName: plan.name });
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
      const data = { name, av: (name || id).charAt(0).toUpperCase(), tier, role: ROLE[tier] + (branch ? ' · ' + branch : ''), roleZh: ROLE_ZH[tier] + (branch ? ' · ' + branch : ''), wa, phone, branch };
      const { error } = await sb.from('employees').insert({ id, company_id: emp.companyId, data, email: staffEmail || null, updated_at: now(), deleted: 0 });
      if (error) return send(400, { error: error.message });
      // also provision a Supabase Auth account so they can log in
      if (staffEmail) { await sb.auth.admin.createUser({ email: staffEmail, password: staffPw, email_confirm: true, user_metadata: { emp_id: id } }).catch(() => {}); }
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
      const { data: row } = await sb.from('employees').select('*').eq('id', emp.id).eq('company_id', emp.companyId).eq('deleted', 0).maybeSingle();
      if (!row) return send(404, { error: 'not_found' });
      const email = row.email || (row.data && row.data.email);
      if (!email) return send(400, { error: 'no_email', detail: 'set a recovery e-mail first' });
      if (b.password && b.password.length >= 8) {
        const { error } = await sb.auth.admin.updateUserById(row.user_id || (await sb.auth.admin.listUsers()).data.users.find(u => u.email === email)?.id || '', { password: b.password });
        if (error) return send(400, { error: error.message });
      }
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
      return send(200, { id: cid, photos: await photosOf(cid, emp.companyId), videos: await videosOf(cid, emp.companyId) });
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
