/*
 * Ant Motors — sync server (multi-tenant SaaS ready)
 * Zero external dependencies: node:http + node:sqlite + node:crypto.
 * Run:  node server.js            (default port 8787, db ./antmotors.db)
 *       PORT=80 DB=/data/am.db node server.js
 *
 * Multi-tenancy: every company is isolated. All data rows carry `company_id`;
 * every query is scoped by it. A person who registers with `companyName`
 * creates a company (becomes its owner); one who registers with `companyCode`
 * joins an existing company as a personal account, then binds to a role.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const alipay = require('./alipay');
const mailer = require('./mailer');
const configLoader = require('./config-loader');

/* Hosting platforms (Railway / Render / Fly) give a container whose filesystem
 * is wiped on every restart; only an explicitly mounted volume survives. By
 * convention that volume lives at /data, so prefer it automatically — losing
 * the database on redeploy is the single most damaging mistake here. */
function defaultDbPath() {
  try {
    if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) {
      fs.accessSync('/data', fs.constants.W_OK);
      return '/data/antmotors.db';
    }
  } catch (e) { /* not writable — fall through to the local file */ }
  return path.join(__dirname, 'antmotors.db');
}
/* True when we are almost certainly inside a PaaS container. */
function inContainer() {
  return !!(process.env.RAILWAY_ENVIRONMENT || process.env.RENDER ||
            process.env.FLY_APP_NAME || process.env.KUBERNETES_SERVICE_HOST ||
            fs.existsSync('/.dockerenv'));
}

const PORT = +(process.env.PORT || 8787);
const DB_PATH = process.env.DB || defaultDbPath();
const APP_DIR = process.env.APP_DIR || path.join(__dirname, '..', 'app');
const TOP_TIERS = ['boss', 'partnerA', 'partnerB'];
const MAX_BODY = 40 * 1024 * 1024; // 40MB — car photos arrive as data URLs
const DEFAULT_COMPANY = 'co_default';

/* --------------------------------------------------------- membership plans
 * Prices are in 分 (1 CNY = 100 分) as Alipay expects.
 * trial = free 14-day window; afterwards the company must subscribe.
 */
const PLANS = {
  trial:  { id: 'trial',  name: '试用',     nameEn: 'Trial',     price: 0,     days: 14,  currency: 'CNY' },
  monthly:{ id: 'monthly',name: '月付会员', nameEn: 'Monthly',  price: 3500,  days: 30,  currency: 'CNY' },
  yearly: { id: 'yearly', name: '年付会员', nameEn: 'Yearly',   price: 35000, days: 365, currency: 'CNY' }
};
const TRIAL_DAYS = 14;
const FEE_CNY = { monthly: (PLANS.monthly.price / 100), yearly: (PLANS.yearly.price / 100) };

/* ------------------------------------------------------------------ db */
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS companies (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  logo       TEXT,
  owner_id   TEXT,
  code       TEXT UNIQUE NOT NULL,
  plan       TEXT NOT NULL DEFAULT 'trial',
  status     TEXT NOT NULL DEFAULT 'active',
  permanent  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cars (
  id         TEXT NOT NULL,
  company_id TEXT NOT NULL DEFAULT '${DEFAULT_COMPANY}',
  data       TEXT NOT NULL,
  listed_at  TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  deleted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, company_id)
);
CREATE TABLE IF NOT EXISTS photos (
  car_id     TEXT NOT NULL,
  company_id TEXT NOT NULL DEFAULT '${DEFAULT_COMPANY}',
  idx        INTEGER NOT NULL,
  data       TEXT NOT NULL,
  PRIMARY KEY (car_id, idx, company_id)
);
CREATE TABLE IF NOT EXISTS videos (
  car_id     TEXT NOT NULL,
  company_id TEXT NOT NULL DEFAULT '${DEFAULT_COMPANY}',
  idx        INTEGER NOT NULL,
  data       TEXT NOT NULL,
  PRIMARY KEY (car_id, idx, company_id)
);
CREATE TABLE IF NOT EXISTS employees (
  id         TEXT NOT NULL,
  company_id TEXT NOT NULL DEFAULT '${DEFAULT_COMPANY}',
  data       TEXT NOT NULL,
  pin_hash   TEXT,
  updated_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, company_id)
);
CREATE TABLE IF NOT EXISTS tokens (
  token      TEXT PRIMARY KEY,
  emp_id     TEXT NOT NULL,
  company_id TEXT NOT NULL DEFAULT '${DEFAULT_COMPANY}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER, emp_id TEXT, company_id TEXT, action TEXT, target TEXT, detail TEXT
);
CREATE TABLE IF NOT EXISTS showrooms (
  id         TEXT NOT NULL,
  company_id TEXT NOT NULL DEFAULT '${DEFAULT_COMPANY}',
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_cars_updated ON cars(company_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_emp_updated  ON employees(company_id, updated_at);
CREATE TABLE IF NOT EXISTS orders (
  out_trade_no TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  plan_id      TEXT NOT NULL,
  amount       INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  paid_at      INTEGER
);
CREATE TABLE IF NOT EXISTS reset_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_id     TEXT NOT NULL,
  company_id TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  channel    TEXT,
  sent_to    TEXT,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reset_emp ON reset_codes(emp_id, used, expires_at);
`);

/* migrate existing databases that predate company_id columns */
function addCol(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
  if (!cols.includes(col)) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
}
['cars', 'photos', 'videos', 'employees', 'tokens', 'audit', 'showrooms'].forEach(t => addCol(t, 'company_id', `TEXT NOT NULL DEFAULT '${DEFAULT_COMPANY}'`));
/* billing columns on companies */
['trial_ends_at', 'plan_started_at', 'current_period_end', 'alipay_trade_no', 'subscription_id', 'last_paid_at'].forEach(c => addCol('companies', c, 'INTEGER'));
addCol('companies', 'permanent', "INTEGER NOT NULL DEFAULT 0");
/* account-security columns (B-plan: real passwords, recovery, brute-force lockout) */
addCol('employees', 'email', 'TEXT');
addCol('employees', 'cred_kind', "TEXT NOT NULL DEFAULT 'pin'"); // 'pin' (legacy) | 'password'
addCol('employees', 'fail_count', 'INTEGER NOT NULL DEFAULT 0');
addCol('employees', 'locked_until', 'INTEGER NOT NULL DEFAULT 0');
addCol('employees', 'pw_changed_at', 'INTEGER');
addCol('tokens', 'expires_at', 'INTEGER NOT NULL DEFAULT 0');

const now = () => Date.now();
const clampTs = (t) => { const n = now(); const v = +t; return (!v || v > n) ? n : v; };
const q = (sql) => db.prepare(sql);
/* -------------------------------------------------- self-use companies
 * Which company(ies) get free, never-expiring membership is decided EXPLICITLY
 * in server/config.json (gitignored). Nothing is permanent by default — only the
 * codes listed here. This prevents accidentally granting lifetime membership to a
 * customer company. Matched case-insensitively against company.code.
 */
let PERMANENT_CODES = new Set();
let APP_CFG = {};
try {
  // Local: server/config.json. Cloud: APP_CONFIG / PERMANENT_CODES / SMTP_* env vars.
  APP_CFG = configLoader.load() || {};
  if (Array.isArray(APP_CFG.permanentCompanyCodes)) {
    PERMANENT_CODES = new Set(APP_CFG.permanentCompanyCodes.map(c => String(c).toUpperCase()));
  }
} catch (e) { console.warn('[config] could not load configuration:', e.message); }
/* When no mail service is configured (self-use stage), the reset code is
 * returned to the caller so the owner can still recover an account. Set
 * "selfServeResetCode": false in config.json to disable this once SMTP works. */
const SELF_SERVE_CODE = !mailer.enabled() && APP_CFG.selfServeResetCode !== false;
if (PERMANENT_CODES.size) {
  const ph = Array.from(PERMANENT_CODES).map(() => '?').join(',');
  q(`UPDATE companies SET permanent=1 WHERE UPPER(code) IN (${ph})`).run(...PERMANENT_CODES);
  q(`UPDATE companies SET permanent=0 WHERE permanent!=0 AND UPPER(code) NOT IN (${ph})`).run(...PERMANENT_CODES);
  console.log('[config] lifetime membership enabled for', PERMANENT_CODES.size, 'company code(s)');
}
const getMeta = (k) => { const r = q('SELECT v FROM meta WHERE k=?').get(k); return r ? r.v : null; };
const setMeta = (k, v) => q('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
const audit = (empId, action, target, detail, companyId) =>
  q('INSERT INTO audit(ts,emp_id,company_id,action,target,detail) VALUES(?,?,?,?,?,?)').run(now(), empId || '', companyId || '', action, target || '', detail || '');

function hashPin(pin, salt) {
  salt = salt || crypto.randomBytes(8).toString('hex');
  const h = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return salt + ':' + h;
}
function checkPin(pin, stored) {
  if (!stored) return false;
  const [salt] = stored.split(':');
  try { return crypto.timingSafeEqual(Buffer.from(hashPin(pin, salt)), Buffer.from(stored)); }
  catch { return false; }
}

/* ------------------------------------------------- password policy (B plan)
 * A real password: 8–64 chars, must mix upper, lower, digit and symbol.
 * Legacy 4–8 digit PINs still authenticate (cred_kind='pin') so existing
 * accounts keep working, but every new/reset credential must be a password.
 */
const PW_MIN = 8, PW_MAX = 64;
const LOCK_AFTER = 5;              // failed logins before lockout
const LOCK_MS = 15 * 60 * 1000;    // lockout duration
const CODE_TTL_MS = 10 * 60 * 1000;// reset-code lifetime
const CODE_MAX_TRIES = 5;
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // "remember me" session length

function pwIssue(pw) {
  pw = String(pw == null ? '' : pw);
  if (pw.length < PW_MIN) return 'too_short';
  if (pw.length > PW_MAX) return 'too_long';
  if (!/[a-z]/.test(pw)) return 'need_lower';
  if (!/[A-Z]/.test(pw)) return 'need_upper';
  if (!/[0-9]/.test(pw)) return 'need_digit';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'need_symbol';
  if (/^(.)\1+$/.test(pw)) return 'too_simple';
  return null;
}
/* look an account up by id (case-insensitive) or by e-mail */
function findAccount(account) {
  const a = String(account || '').trim();
  if (!a) return null;
  if (a.includes('@')) return q('SELECT * FROM employees WHERE LOWER(email)=LOWER(?) AND deleted=0').get(a) || null;
  return q('SELECT * FROM employees WHERE LOWER(id)=LOWER(?) AND deleted=0').get(a) || null;
}
function isLocked(row) { return row && row.locked_until && row.locked_until > now(); }
function noteLoginFail(row) {
  const n = (row.fail_count || 0) + 1;
  const lock = n >= LOCK_AFTER ? now() + LOCK_MS : 0;
  q('UPDATE employees SET fail_count=?, locked_until=? WHERE id=? AND company_id=?')
    .run(lock ? 0 : n, lock, row.id, row.company_id);
  return lock;
}
function clearLoginFail(row) {
  if (row.fail_count || row.locked_until) q('UPDATE employees SET fail_count=0, locked_until=0 WHERE id=? AND company_id=?').run(row.id, row.company_id);
}
function issueToken(empId, companyId) {
  const token = crypto.randomBytes(24).toString('hex');
  q('INSERT INTO tokens(token,emp_id,company_id,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run(token, empId, companyId, now(), now() + TOKEN_TTL_MS);
  return token;
}
function maskTarget(s) {
  s = String(s || '');
  if (s.includes('@')) { const [a, b] = s.split('@'); return a.slice(0, 2) + '***@' + b; }
  return s.length > 4 ? s.slice(0, 3) + '****' + s.slice(-2) : '****';
}

/* ---------------------------------------------------------- companies */
function genCompanyCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return 'ANT-' + s;
}
function companyById(id) { return q('SELECT * FROM companies WHERE id=?').get(id); }
function publicCompany(row) {
  return { id: row.id, name: row.name, logo: row.logo || null, code: row.code, plan: row.plan, status: row.status, permanent: !!row.permanent };
}
/* computed membership state for a company row */
function membershipView(row) {
  const isPermanent = row.permanent || (PERMANENT_CODES && PERMANENT_CODES.has(String(row.code || '').toUpperCase()));
  if (isPermanent) {
    return { plan: row.plan || 'owner', planName: '永久会员', planNameEn: 'Lifetime', status: 'active', active: true, expired: false, periodEnd: 0, canSell: true, isPermanent: true };
  }
  const t = now();
  const isDefault = row.id === DEFAULT_COMPANY;
  let plan = row.plan || 'trial';
  let periodEnd = +row.current_period_end || 0;
  let active = true;
  if (plan === 'trial') {
    periodEnd = periodEnd || (+row.trial_ends_at || (row.created_at + TRIAL_DAYS * 864e5));
    active = t < periodEnd || isDefault;
  } else {
    active = row.status === 'active' && t < periodEnd;
  }
  const m = PLANS[plan] || PLANS.trial;
  return {
    plan, planName: m.name, planNameEn: m.nameEn,
    status: row.status, active, expired: !active,
    periodEnd, canSell: active, isPermanent: false
  };
}
function activatePlan(companyId, planId, tradeNo) {
  const p = PLANS[planId];
  if (!p) return;
  const start = now();
  const end = start + p.days * 864e5;
  q('UPDATE companies SET plan=?, status=?, plan_started_at=?, current_period_end=?, alipay_trade_no=?, subscription_id=?, last_paid_at=? WHERE id=?')
    .run(planId, 'active', start, end, tradeNo || '', tradeNo || '', start, companyId);
}
function ensureDefaultCompany() {
  const n = q('SELECT COUNT(*) n FROM companies').get().n;
  if (n > 0) return;
  const code = getMeta('company_code') || genCompanyCode();
  q('INSERT INTO companies(id,name,logo,owner_id,code,plan,status,created_at,trial_ends_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(DEFAULT_COMPANY, 'Ant Motors', null, 'boss', code, 'trial', 'active', now(), now() + 3650 * 864e5);
}

/* ---------------------------------------------------------------- seed */
function seed() {
  if (getMeta('seeded') === '1') return;
  const seedFile = path.join(__dirname, 'seed.json');
  if (!fs.existsSync(seedFile)) { console.warn('[seed] seed.json not found — starting empty'); setMeta('seeded', '1'); return; }
  const s = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  const t = now();
  const insCar = q('INSERT OR REPLACE INTO cars(id,company_id,data,listed_at,updated_at,updated_by,deleted) VALUES(?,?,?,?,?,?,?)');
  for (const [id, car] of Object.entries(s.cars || {})) {
    if (s.colors && s.colors[id] && !car.color) car.color = s.colors[id];
    insCar.run(id, DEFAULT_COMPANY, JSON.stringify(car), (s.listedAt || {})[id] || null, t, 'seed');
  }
  const insEmp = q('INSERT OR REPLACE INTO employees(id,company_id,data,pin_hash,updated_at,deleted) VALUES(?,?,?,?,?,0)');
  const pins = s.pins || {};
  for (const [id, e] of Object.entries(s.employees || {})) {
    insEmp.run(id, DEFAULT_COMPANY, JSON.stringify(e), hashPin(pins[id] || '1234'), t);
  }
  const insShow = q('INSERT OR REPLACE INTO showrooms(id,company_id,data,updated_at) VALUES(?,?,?,?)');
  for (const sh of (s.showrooms || [])) {
    insShow.run(sh.name, DEFAULT_COMPANY, JSON.stringify(sh), t);
  }
  setMeta('seeded', '1');
  console.log(`[seed] ${Object.keys(s.cars || {}).length} cars, ${Object.keys(s.employees || {}).length} employees, ${(s.showrooms || []).length} showrooms → company ${DEFAULT_COMPANY}`);
}

/* ---------------------------------------------------------------- auth */
function authOf(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const row = q('SELECT emp_id, company_id, expires_at FROM tokens WHERE token=?').get(m[1]);
  if (!row) return null;
  if (row.expires_at && row.expires_at < now()) { q('DELETE FROM tokens WHERE token=?').run(m[1]); return null; }
  const e = q('SELECT id,data,company_id,email,cred_kind FROM employees WHERE id=? AND company_id=? AND deleted=0').get(row.emp_id, row.company_id);
  if (!e) return null;
  const emp = JSON.parse(e.data); emp.id = e.id; emp.companyId = e.company_id;
  emp.email = e.email || '';
  emp.credKind = e.cred_kind || 'pin';
  return emp;
}
const isTop = (emp) => !!emp && TOP_TIERS.includes(emp.tier);

/* ------------------------------------------------------------- helpers */
function send(res, code, obj, extra) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Cache-Control': 'no-store'
  }, extra || {}));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let len = 0; const chunks = [];
    req.on('data', c => {
      len += c.length;
      if (len > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}
function readForm(req) {
  return new Promise((resolve, reject) => {
    let len = 0; const chunks = [];
    req.on('data', c => {
      len += c.length;
      if (len > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const out = {};
      const raw = Buffer.concat(chunks).toString('utf8');
      for (const pair of raw.split('&')) {
        if (!pair) continue;
        const i = pair.indexOf('=');
        const k = decodeURIComponent(pair.slice(0, i));
        const v = decodeURIComponent(pair.slice(i + 1));
        out[k] = v;
      }
      resolve(out);
    });
    req.on('error', reject);
  });
}
function publicCar(row) {
  const c = JSON.parse(row.data);
  const quote = c.price && typeof c.price.quote === 'number' ? c.price.quote : null;
  const out = Object.assign({}, c, { id: row.id, listedAt: row.listed_at });
  out.price = { quote };
  return out;
}
function photosOf(id) { return q('SELECT data FROM photos WHERE car_id=? ORDER BY idx').all(id).map(r => r.data); }
function writePhotos(id, arr, companyId) {
  q('DELETE FROM photos WHERE car_id=? AND company_id=?').run(id, companyId);
  if (!Array.isArray(arr)) return;
  const ins = q('INSERT INTO photos(car_id,company_id,idx,data) VALUES(?,?,?,?)');
  arr.slice(0, 12).forEach((d, i) => { if (typeof d === 'string' && d.length < 6e6) ins.run(id, companyId, i, d); });
}
function videosOf(id) { return q('SELECT data FROM videos WHERE car_id=? ORDER BY idx').all(id).map(r => r.data); }
function writeVideos(id, arr, companyId) {
  q('DELETE FROM videos WHERE car_id=? AND company_id=?').run(id, companyId);
  if (!Array.isArray(arr)) return;
  const ins = q('INSERT INTO videos(car_id,company_id,idx,data) VALUES(?,?,?,?)');
  arr.slice(0, 3).forEach((d, i) => { if (typeof d === 'string' && d.length < 25e6) ins.run(id, companyId, i, d); });
}
/* a share link may carry ?ref= (sales) or ?company= (company id); fall back to the default showroom */
function resolveCompanyId(u) {
  const ref = u.searchParams.get('ref');
  if (ref) { const e = q('SELECT company_id FROM employees WHERE id=? AND deleted=0').get(ref); if (e) return e.company_id; }
  const cp = u.searchParams.get('company');
  if (cp) { const c = q('SELECT id FROM companies WHERE id=?').get(cp); if (c) return c.id; }
  return DEFAULT_COMPANY;
}

/* --------------------------------------------------------------- sync */
function applyPush(emp, payload) {
  const applied = [], rejected = [];
  const top = isTop(emp);
  const cid = emp.companyId;

  for (const c of (payload.cars || [])) {
    if (!c || !c.id) continue;
    const cur = q('SELECT * FROM cars WHERE id=? AND company_id=?').get(c.id, cid);
    const ts = clampTs(c.updatedAt);
    if (cur && cur.updated_at > ts) { rejected.push({ id: c.id, reason: 'stale' }); continue; }

    const incoming = c.data || {};
    if (!top) {
      const oldPrice = cur ? (JSON.parse(cur.data).price || null) : null;
      const newPrice = incoming.price || null;
      if (JSON.stringify(oldPrice) !== JSON.stringify(newPrice)) {
        if (cur) { incoming.price = oldPrice; rejected.push({ id: c.id, reason: 'price_forbidden' }); }
        else { rejected.push({ id: c.id, reason: 'price_forbidden' }); continue; }
      }
    }
    q(`INSERT INTO cars(id,company_id,data,listed_at,updated_at,updated_by,deleted) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(id,company_id) DO UPDATE SET data=excluded.data, listed_at=excluded.listed_at,
       updated_at=excluded.updated_at, updated_by=excluded.updated_by, deleted=excluded.deleted`)
      .run(c.id, cid, JSON.stringify(incoming), c.listedAt || null, ts, emp.id, c.deleted ? 1 : 0);
    if (c.photos) writePhotos(c.id, c.photos, cid);
    if (c.videos) writeVideos(c.id, c.videos, cid);
    applied.push(c.id);
    audit(emp.id, c.deleted ? 'car.delete' : (cur ? 'car.update' : 'car.create'), c.id, incoming.name || '', cid);
  }

  for (const e of (payload.employees || [])) {
    if (!e || !e.id) continue;
    const cur = q('SELECT * FROM employees WHERE id=? AND company_id=?').get(e.id, cid);
    const ts = clampTs(e.updatedAt);
    if (!cur) { rejected.push({ id: e.id, reason: 'unknown_employee' }); continue; }
    if (cur.updated_at > ts) { rejected.push({ id: e.id, reason: 'stale' }); continue; }
    const old = JSON.parse(cur.data);
    const inc = e.data || {};
    let next;
    if (top) {
      next = Object.assign({}, old, inc);
    } else if (e.id === emp.id) {
      next = Object.assign({}, old, {
        wa: inc.wa != null ? String(inc.wa) : old.wa,
        phone: inc.phone != null ? String(inc.phone) : old.phone
      });
      if (inc.tier && inc.tier !== old.tier) rejected.push({ id: e.id, reason: 'tier_forbidden' });
    } else { rejected.push({ id: e.id, reason: 'not_your_account' }); continue; }
    q('UPDATE employees SET data=?, updated_at=? WHERE id=? AND company_id=?').run(JSON.stringify(next), ts, e.id, cid);
    applied.push(e.id);
    audit(emp.id, 'employee.update', e.id, JSON.stringify({ tier: next.tier }), cid);
  }
  return { applied, rejected };
}

function pull(since, withPhotos, companyId) {
  const s = +since || 0;
  const cars = q('SELECT * FROM cars WHERE company_id=? AND updated_at > ? ORDER BY updated_at').all(companyId, s).map(r => ({
    id: r.id, companyId: r.company_id, data: JSON.parse(r.data), listedAt: r.listed_at,
    updatedAt: r.updated_at, updatedBy: r.updated_by, deleted: !!r.deleted,
    photos: withPhotos ? photosOf(r.id) : undefined,
    videos: withPhotos ? videosOf(r.id) : undefined
  }));
  const employees = q('SELECT * FROM employees WHERE company_id=? AND updated_at > ? ORDER BY updated_at').all(companyId, s).map(r => ({
    id: r.id, companyId: r.company_id, data: JSON.parse(r.data), updatedAt: r.updated_at, deleted: !!r.deleted
  }));
  return { now: now(), cars, employees };
}

/* ------------------------------------------------------------- static */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(APP_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(APP_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      return fs.readFile(path.join(APP_DIR, 'index.html'), (e2, b2) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(b2);
      });
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(buf);
  });
}

/* -------------------------------------------------------------- router */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (!p.startsWith('/api/')) return serveStatic(req, res, req.url);

  try {
    /* ---- health ---- */
    if (p === '/api/health') {
      const cars = q('SELECT COUNT(*) n FROM cars WHERE deleted=0').get().n;
      const cos = q('SELECT COUNT(*) n FROM companies').get().n;
      return send(res, 200, { ok: true, cars, companies: cos, now: now(), version: 2 });
    }

    /* ---- login (account id OR email) + password / legacy PIN ---- */
    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      const account = String(b.account || b.id || '').trim();
      const secret = String(b.password != null ? b.password : (b.pin || ''));
      const row = findAccount(account);
      if (!row) { audit(account, 'login.fail', '', 'no_account', ''); return send(res, 401, { error: 'bad_credentials' }); }
      if (isLocked(row)) {
        audit(row.id, 'login.locked', '', '', row.company_id);
        return send(res, 423, { error: 'locked', retryAfter: Math.ceil((row.locked_until - now()) / 1000) });
      }
      if (!checkPin(secret, row.pin_hash)) {
        const locked = noteLoginFail(row);
        audit(row.id, 'login.fail', '', locked ? 'locked_out' : '', row.company_id);
        return send(res, locked ? 423 : 401, locked
          ? { error: 'locked', retryAfter: Math.ceil(LOCK_MS / 1000) }
          : { error: 'bad_credentials', remaining: Math.max(0, LOCK_AFTER - ((row.fail_count || 0) + 1)) });
      }
      clearLoginFail(row);
      const token = issueToken(row.id, row.company_id);
      const emp = JSON.parse(row.data); emp.id = row.id; emp.companyId = row.company_id;
      emp.email = row.email || '';
      const co = companyById(row.company_id);
      audit(row.id, 'login.ok', '', '', row.company_id);
      return send(res, 200, {
        token, employee: emp, company: co ? publicCompany(co) : null,
        mustChangePassword: (row.cred_kind || 'pin') !== 'password'
      });
    }

    /* ---- forgot password: issue a 6-digit code ---- */
    if (p === '/api/password/forgot' && req.method === 'POST') {
      const b = await readBody(req);
      const account = String(b.account || b.id || '').trim();
      const row = findAccount(account);
      /* never reveal whether the account exists */
      const generic = { ok: true, sent: true, channel: 'email', hint: maskTarget(account) };
      if (!row) return send(res, 200, generic);
      /* throttle: max 1 code per 60s */
      const last = q('SELECT created_at FROM reset_codes WHERE emp_id=? ORDER BY id DESC LIMIT 1').get(row.id);
      if (last && now() - last.created_at < 60000) return send(res, 429, { error: 'too_soon', retryAfter: Math.ceil((60000 - (now() - last.created_at)) / 1000) });

      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const target = row.email || '';
      q('UPDATE reset_codes SET used=1 WHERE emp_id=? AND used=0').run(row.id);
      q('INSERT INTO reset_codes(emp_id,company_id,code_hash,channel,sent_to,expires_at,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(row.id, row.company_id, hashPin(code), target ? 'email' : 'console', target, now() + CODE_TTL_MS, now());

      let delivered = false, reason = '';
      if (target && mailer.enabled()) {
        try {
          await mailer.sendMail({
            to: target,
            subject: 'Ant Motors 密码重置验证码 / Password reset code',
            text: `您的验证码是 ${code}，10 分钟内有效。\nYour verification code is ${code}. It expires in 10 minutes.\n\n如果不是您本人操作，请忽略此邮件。\nIf you did not request this, ignore this message.`
          });
          delivered = true;
        } catch (e) { reason = e.message; console.warn('[reset] mail failed:', e.message); }
      } else { reason = target ? 'smtp_not_configured' : 'no_email_on_file'; }

      if (!delivered) console.log(`\n[reset] account=${row.id} code=${code} (valid 10min) — reason: ${reason}\n`);
      audit(row.id, 'password.forgot', row.id, delivered ? 'email' : 'console:' + reason, row.company_id);
      const out = { ok: true, sent: delivered, channel: delivered ? 'email' : 'console', hint: maskTarget(target || account) };
      if (!delivered && SELF_SERVE_CODE) out.devCode = code;   // self-use mode only
      return send(res, 200, out);
    }

    /* ---- reset password with the code ---- */
    if (p === '/api/password/reset' && req.method === 'POST') {
      const b = await readBody(req);
      const row = findAccount(String(b.account || b.id || '').trim());
      const code = String(b.code || '').trim();
      const pw = String(b.password || '');
      if (!row) return send(res, 400, { error: 'bad_code' });
      const issue = pwIssue(pw);
      if (issue) return send(res, 400, { error: 'weak_password', detail: issue });
      const rec = q('SELECT * FROM reset_codes WHERE emp_id=? AND used=0 ORDER BY id DESC LIMIT 1').get(row.id);
      if (!rec || rec.expires_at < now()) return send(res, 400, { error: 'code_expired' });
      if (rec.attempts >= CODE_MAX_TRIES) return send(res, 429, { error: 'too_many_attempts' });
      if (!checkPin(code, rec.code_hash)) {
        q('UPDATE reset_codes SET attempts=attempts+1 WHERE id=?').run(rec.id);
        return send(res, 400, { error: 'bad_code', remaining: Math.max(0, CODE_MAX_TRIES - rec.attempts - 1) });
      }
      q('UPDATE reset_codes SET used=1 WHERE id=?').run(rec.id);
      q("UPDATE employees SET pin_hash=?, cred_kind='password', pw_changed_at=?, fail_count=0, locked_until=0 WHERE id=? AND company_id=?")
        .run(hashPin(pw), now(), row.id, row.company_id);
      q('DELETE FROM tokens WHERE emp_id=? AND company_id=?').run(row.id, row.company_id); // log out everywhere
      audit(row.id, 'password.reset', row.id, '', row.company_id);
      const token = issueToken(row.id, row.company_id);
      const emp = JSON.parse(row.data); emp.id = row.id; emp.companyId = row.company_id;
      const co = companyById(row.company_id);
      return send(res, 200, { ok: true, token, employee: emp, company: co ? publicCompany(co) : null });
    }

    /* ---- public (customer share link) — sanitized, no auth, company-scoped ---- */
    if (p === '/api/public/cars') {
      const cid = resolveCompanyId(u);
      const rows = q('SELECT * FROM cars WHERE company_id=? AND deleted=0 ORDER BY updated_at DESC').all(cid);
      return send(res, 200, { company: cid, cars: rows.map(publicCar) });
    }
    if (p === '/api/showrooms') {
      const cid = resolveCompanyId(u);
      const rows = q('SELECT data FROM showrooms WHERE company_id=? ORDER BY data').all(cid);
      return send(res, 200, { company: cid, showrooms: rows.map(r => JSON.parse(r.data)) });
    }
    if (p.startsWith('/api/public/car/')) {
      const id = p.slice('/api/public/car/'.length);
      const cid = resolveCompanyId(u);
      const row = q('SELECT * FROM cars WHERE id=? AND company_id=? AND deleted=0').get(id, cid);
      if (!row) return send(res, 404, { error: 'not_found' });
      const ref = u.searchParams.get('ref');
      let agent = null;
      if (ref) {
        const e = q('SELECT data FROM employees WHERE id=? AND company_id=? AND deleted=0').get(ref, cid);
        if (e) { const d = JSON.parse(e.data); agent = { id: ref, name: d.name, wa: d.wa, phone: d.phone, role: d.role, roleZh: d.roleZh, branch: d.branch }; }
      }
      return send(res, 200, { car: publicCar(row), photos: photosOf(id), videos: videosOf(id), agent });
    }

    /* ---- public membership plans (no auth needed to browse) ---- */
    if (p === '/api/plans' && req.method === 'GET') {
      const list = Object.values(PLANS).map(p => ({ id: p.id, name: p.name, nameEn: p.nameEn, price: p.price, days: p.days, currency: p.currency }));
      return send(res, 200, { plans: list, simulate: alipay.simulate(), live: alipay.enabled() });
    }

    /* ---- Alipay async notify (public, form-urlencoded) ---- */
    if (p === '/api/alipay/notify' && req.method === 'POST') {
      const b = await readForm(req);
      const paid = (b.trade_status === 'TRADE_SUCCESS' || b.trade_status === 'TRADE_FINISHED');
      if (!paid) return send(res, 200, 'success'); // not a payment result yet; ack so Alipay retries later
      if (alipay.enabled() && !alipay.verify(b, alipay.cfg.alipayPublicKey)) return send(res, 400, 'sign fail');
      const order = q('SELECT * FROM orders WHERE out_trade_no=?').get(b.out_trade_no);
      if (!order) return send(res, 200, 'success');
      if (order.status !== 'paid') {
        q('UPDATE orders SET status=?, paid_at=? WHERE out_trade_no=?').run('paid', now(), b.out_trade_no);
        activatePlan(order.company_id, order.plan_id, b.trade_no);
        audit(order.company_id, 'payment.paid', order.company_id, b.out_trade_no, order.company_id);
      }
      return send(res, 200, 'success');
    }

    /* ---- Alipay return (public, browser redirect after pay) ---- */
    if (p === '/api/alipay/return' && req.method === 'GET') {
      const rurl = (alipay.cfg && alipay.cfg.returnUrl) || '/';
      res.writeHead(302, { Location: rurl + '?paid=1' });
      return res.end();
    }

    /* ---- dev simulate: mark a pending order paid (only in simulate mode) ---- */
    if (p === '/api/alipay/simulate' && req.method === 'POST') {
      if (!alipay.simulate()) return send(res, 403, { error: 'disabled' });
      const b = await readBody(req);
      const order = q('SELECT * FROM orders WHERE out_trade_no=?').get(b.outTradeNo);
      if (!order) return send(res, 404, { error: 'no_order' });
      if (order.status !== 'paid') {
        q('UPDATE orders SET status=?, paid_at=? WHERE out_trade_no=?').run('paid', now(), b.outTradeNo);
        activatePlan(order.company_id, order.plan_id, 'SIM_' + b.outTradeNo);
        audit(order.company_id, 'payment.simulated', order.company_id, b.outTradeNo, order.company_id);
      }
      return send(res, 200, { ok: true });
    }

    /* ---- self-registration (open, no auth) ---- */
    if (p === '/api/register' && req.method === 'POST') {
      const b = await readBody(req);
      const id = String(b.id || '').trim();
      const pw = String(b.password != null ? b.password : (b.pin || ''));
      const email = String(b.email || '').trim().slice(0, 120);
      if (!/^[A-Za-z0-9_]{2,20}$/.test(id)) return send(res, 400, { error: 'bad_id', detail: 'id: 2-20 letters/numbers/_' });
      const issue = pwIssue(pw);
      if (issue) return send(res, 400, { error: 'weak_password', detail: issue });
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return send(res, 400, { error: 'bad_email', detail: 'invalid e-mail address' });
      if (q('SELECT 1 FROM employees WHERE LOWER(id)=LOWER(?) AND deleted=0').get(id)) return send(res, 409, { error: 'exists', detail: 'account id already used' });
      if (email && q('SELECT 1 FROM employees WHERE LOWER(email)=LOWER(?) AND deleted=0').get(email)) return send(res, 409, { error: 'email_exists', detail: 'e-mail already registered' });

      const name = (String(b.name || id).trim().slice(0, 60)) || id;
      const wa = String(b.wa || '').replace(/[^0-9]/g, '').slice(0, 20);
      const phone = String(b.phone || '').slice(0, 40);

      let companyId, company, tier, role, roleZh;
      if (b.companyName && String(b.companyName).trim()) {
        companyId = 'co_' + crypto.randomBytes(6).toString('hex');
        const code = genCompanyCode();
        // New companies start on a trial. Lifetime (self-use) membership is
        // granted ONLY via PERMANENT_CODES. If the caller passed an explicit
        // inviteCode that matches a permanent entry, the new company inherits
        // lifetime membership immediately.
        let logo = null;
        if (b.companyLogo && typeof b.companyLogo === 'string' && b.companyLogo.startsWith('data:image') && b.companyLogo.length < 2_000_000) logo = b.companyLogo;
        const isPermanent = !!(b.inviteCode && PERMANENT_CODES.has(String(b.inviteCode).trim().toUpperCase()));
        q('INSERT INTO companies(id,name,logo,owner_id,code,plan,status,created_at,trial_ends_at,permanent) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(companyId, String(b.companyName).trim().slice(0, 80), logo, id, code, isPermanent ? 'permanent' : 'trial', 'active', now(), now() + TRIAL_DAYS * 864e5, isPermanent ? 1 : 0);
        company = companyById(companyId);
        tier = 'boss'; role = 'Boss / Owner'; roleZh = '老板 / 所有者';
      } else if (b.companyCode && String(b.companyCode).trim()) {
        const co = q('SELECT * FROM companies WHERE UPPER(code)=? AND status=?').get(String(b.companyCode).trim().toUpperCase(), 'active');
        if (!co) return send(res, 400, { error: 'bad_code', detail: 'invitation code does not match' });
        companyId = co.id; company = co;
        tier = 'customer'; role = 'Personal account'; roleZh = '个人账号';
      } else {
        return send(res, 400, { error: 'need_company', detail: 'provide companyName to create, or companyCode to join' });
      }

      const data = { name, av: name.charAt(0).toUpperCase(), tier, role, roleZh, wa, phone, branch: '' };
      q("INSERT INTO employees(id,company_id,data,pin_hash,email,cred_kind,pw_changed_at,updated_at,deleted) VALUES(?,?,?,?,?,'password',?,?,0)")
        .run(id, companyId, JSON.stringify(data), hashPin(pw), email || null, now(), now());
      const token = issueToken(id, companyId);
      audit(id, 'register', id, JSON.stringify({ company: companyId, name }), companyId);
      return send(res, 200, { token, employee: Object.assign({ id, companyId, email }, data), company: company ? publicCompany(company) : null });
    }

    /* ---- authenticated ---- */
    const emp = authOf(req);
    if (!emp) return send(res, 401, { error: 'unauthorized' });

    if (p === '/api/me') {
      const co = companyById(emp.companyId);
      return send(res, 200, { employee: emp, canEditPrices: isTop(emp), company: co ? publicCompany(co) : null, membership: co ? membershipView(co) : null, mustChangePassword: emp.credKind !== 'password' });
    }

    /* company profile — owners/partners only */
    if (p === '/api/company' && req.method === 'GET') {
      if (!isTop(emp)) return send(res, 403, { error: 'forbidden' });
      const co = companyById(emp.companyId);
      return send(res, 200, { company: co ? publicCompany(co) : null, membership: co ? membershipView(co) : null });
    }
    if (p === '/api/company' && req.method === 'PUT') {
      if (!isTop(emp)) return send(res, 403, { error: 'forbidden' });
      const b = await readBody(req);
      const co = companyById(emp.companyId);
      if (!co) return send(res, 404, { error: 'not_found' });
      if (b.name !== undefined) co.name = String(b.name).trim().slice(0, 80);
      if (b.logo !== undefined) {
        if (b.logo && typeof b.logo === 'string' && b.logo.startsWith('data:image') && b.logo.length < 2_000_000) co.logo = b.logo;
        else if (b.logo === null || b.logo === '') co.logo = null;
      }
      q('UPDATE companies SET name=?, logo=? WHERE id=?').run(co.name, co.logo, emp.companyId);
      audit(emp.id, 'company.update', emp.companyId, '', emp.companyId);
      return send(res, 200, { company: publicCompany(co) });
    }

    /* company invitation code — owners/partners only, per company */
    if (p === '/api/company/code' && req.method === 'GET') {
      if (!isTop(emp)) return send(res, 403, { error: 'forbidden' });
      const co = companyById(emp.companyId);
      return send(res, 200, { code: co ? co.code : null });
    }
    if (p === '/api/company/code' && req.method === 'POST') {
      if (!isTop(emp)) return send(res, 403, { error: 'forbidden' });
      const code = genCompanyCode();
      q('UPDATE companies SET code=? WHERE id=?').run(code, emp.companyId);
      audit(emp.id, 'company.code.regen', emp.companyId, '', emp.companyId);
      return send(res, 200, { code });
    }
    /* bind the signed-in account to the company via the invitation code */
    if (p === '/api/company/bind' && req.method === 'POST') {
      const b = await readBody(req);
      const want = String(b.code || '').trim().toUpperCase();
      const co = companyById(emp.companyId);
      const real = (co && co.code || '').toUpperCase();
      if (!real || want !== real) return send(res, 400, { error: 'bad_code', detail: 'invitation code does not match' });
      const BIND_TIERS = ['partnerA', 'manager', 'salesA', 'salesB'];
      const tier = String(b.tier || '');
      if (!BIND_TIERS.includes(tier)) return send(res, 400, { error: 'bad_tier', detail: 'choose partner or staff role' });
      const branch = String(b.branch || '').trim().slice(0, 60);
      const wa = String(b.wa || '').replace(/[^0-9]/g, '').slice(0, 20);
      const phone = String(b.phone || '').slice(0, 40);
      const row = q('SELECT * FROM employees WHERE id=? AND company_id=? AND deleted=0').get(emp.id, emp.companyId);
      if (!row) return send(res, 404, { error: 'not_found' });
      const d = JSON.parse(row.data);
      const ROLE = { partnerA: 'Co-owner (Partner)', manager: 'Manager', salesA: 'Senior Sales', salesB: 'Sales' };
      const ROLE_ZH = { partnerA: '合伙人', manager: '经理', salesA: '高级销售', salesB: '销售' };
      d.tier = tier; d.branch = branch; if (wa) d.wa = wa; if (phone) d.phone = phone;
      d.role = ROLE[tier] + (branch ? ' · ' + branch : '');
      d.roleZh = ROLE_ZH[tier] + (branch ? ' · ' + branch : '');
      q('UPDATE employees SET data=?, updated_at=? WHERE id=? AND company_id=?').run(JSON.stringify(d), now(), emp.id, emp.companyId);
      audit(emp.id, 'company.bind', emp.id, JSON.stringify({ tier }), emp.companyId);
      return send(res, 200, { employee: Object.assign({ id: emp.id, companyId: emp.companyId }, d) });
    }

    /* current company membership state (any signed-in member) */
    if (p === '/api/membership' && req.method === 'GET') {
      const co = companyById(emp.companyId);
      return send(res, 200, { membership: co ? membershipView(co) : null });
    }

    /* create a paid order (owners/partners only) */
    if (p === '/api/subscribe' && req.method === 'POST') {
      if (!isTop(emp)) return send(res, 403, { error: 'forbidden', detail: 'only owners/partners can subscribe' });
      const b = await readBody(req);
      const planId = String(b.planId || '');
      const plan = PLANS[planId];
      if (!plan || plan.price <= 0) return send(res, 400, { error: 'bad_plan', detail: 'choose monthly or yearly' });
      const co = companyById(emp.companyId);
      if (co && co.permanent) return send(res, 409, { error: 'permanent', detail: 'This company has lifetime membership — no subscription needed', simulate: alipay.simulate() });
      const outTradeNo = 'AM' + now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
      q('INSERT INTO orders(out_trade_no,company_id,plan_id,amount,status,created_at) VALUES(?,?,?,?,?,?)')
        .run(outTradeNo, emp.companyId, planId, plan.price, 'pending', now());
      let payUrl;
      if (alipay.enabled()) {
        payUrl = alipay.wapPayUrl({
          outTradeNo,
          subject: `${co ? co.name : 'Ant Motors'} · ${plan.name}`,
          totalAmount: (plan.price / 100).toFixed(2),
          passbackParams: encodeURIComponent(JSON.stringify({ companyId: emp.companyId, planId }))
        });
      } else {
        payUrl = `/api/alipay/simulate?out_trade_no=${outTradeNo}`;
      }
      audit(emp.id, 'payment.create', emp.companyId, outTradeNo, emp.companyId);
      return send(res, 200, { ok: true, outTradeNo, payUrl, simulate: alipay.simulate(), amount: plan.price, planName: plan.name });
    }

    /* create a new staff account (owners/partners only) */
    if (p === '/api/employees' && req.method === 'POST') {
      if (!isTop(emp)) return send(res, 403, { error: 'forbidden', detail: 'only owners/partners can create staff' });
      const co = companyById(emp.companyId);
      if (co && membershipView(co).expired) return send(res, 402, { error: 'payment_required', detail: 'membership expired' });
      const b = await readBody(req);
      const id = String(b.id || '').trim();
      const tier = String(b.tier || '');
      const TIERS = ['boss', 'partnerA', 'partnerB', 'manager', 'salesA', 'salesB'];
      if (!/^[A-Za-z0-9_]{2,20}$/.test(id)) return send(res, 400, { error: 'bad_id', detail: 'id: 2-20 chars, letters/numbers/_' });
      if (!TIERS.includes(tier)) return send(res, 400, { error: 'bad_tier', detail: 'unknown role' });
      const staffPw = String(b.password != null ? b.password : (b.pin || ''));
      const staffIssue = pwIssue(staffPw);
      if (staffIssue) return send(res, 400, { error: 'weak_password', detail: staffIssue });
      const staffEmail = String(b.email || '').trim().slice(0, 120);
      if (staffEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(staffEmail)) return send(res, 400, { error: 'bad_email', detail: 'invalid e-mail address' });
      if (q('SELECT 1 FROM employees WHERE LOWER(id)=LOWER(?) AND deleted=0').get(id)) return send(res, 409, { error: 'exists', detail: 'staff id already used' });
      const name = String(b.name || id).trim().slice(0, 60);
      const branch = String(b.branch || '').trim().slice(0, 60);
      const wa = String(b.wa || '').replace(/[^0-9]/g, '').slice(0, 20);
      const phone = String(b.phone || '').slice(0, 40);
      const ROLE = { boss: 'Boss / Owner', partnerA: 'Co-owner', partnerB: 'Co-owner', manager: 'Manager', salesA: 'Senior Sales', salesB: 'Sales' };
      const ROLE_ZH = { boss: '老板 / 所有者', partnerA: '合伙人', partnerB: '合伙人', manager: '经理', salesA: '高级销售', salesB: '销售' };
      const data = {
        name, av: (name || id).charAt(0).toUpperCase(), tier,
        role: ROLE[tier] + (branch ? ' · ' + branch : ''),
        roleZh: ROLE_ZH[tier] + (branch ? ' · ' + branch : ''),
        wa, phone, branch
      };
      q("INSERT INTO employees(id,company_id,data,pin_hash,email,cred_kind,pw_changed_at,updated_at,deleted) VALUES(?,?,?,?,?,'password',?,?,0)")
        .run(id, emp.companyId, JSON.stringify(data), hashPin(staffPw), staffEmail || null, now(), now());
      audit(emp.id, 'employee.create', id, JSON.stringify({ tier }), emp.companyId);
      return send(res, 200, { ok: true, id, name: data.name });
    }

    /* ---- change own password (signed in) ---- */
    if (p === '/api/password/change' && req.method === 'POST') {
      const b = await readBody(req);
      const row = q('SELECT * FROM employees WHERE id=? AND company_id=? AND deleted=0').get(emp.id, emp.companyId);
      if (!row) return send(res, 404, { error: 'not_found' });
      const current = String(b.current != null ? b.current : (b.currentPin || ''));
      if (!checkPin(current, row.pin_hash)) { audit(emp.id, 'password.change.fail', emp.id, '', emp.companyId); return send(res, 401, { error: 'bad_credentials' }); }
      const issue = pwIssue(String(b.password || ''));
      if (issue) return send(res, 400, { error: 'weak_password', detail: issue });
      if (checkPin(String(b.password), row.pin_hash)) return send(res, 400, { error: 'same_password' });
      q("UPDATE employees SET pin_hash=?, cred_kind='password', pw_changed_at=?, fail_count=0, locked_until=0 WHERE id=? AND company_id=?")
        .run(hashPin(String(b.password)), now(), emp.id, emp.companyId);
      audit(emp.id, 'password.change', emp.id, '', emp.companyId);
      return send(res, 200, { ok: true });
    }

    /* ---- set / update own recovery e-mail (signed in) ---- */
    if (p === '/api/account/email' && req.method === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().slice(0, 120);
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return send(res, 400, { error: 'bad_email' });
      if (email && q('SELECT 1 FROM employees WHERE LOWER(email)=LOWER(?) AND NOT (id=? AND company_id=?) AND deleted=0').get(email, emp.id, emp.companyId))
        return send(res, 409, { error: 'email_exists' });
      q('UPDATE employees SET email=?, updated_at=? WHERE id=? AND company_id=?').run(email || null, now(), emp.id, emp.companyId);
      audit(emp.id, 'account.email', emp.id, maskTarget(email), emp.companyId);
      return send(res, 200, { ok: true, email });
    }

    if (p === '/api/pull') {
      const out = pull(u.searchParams.get('since'), u.searchParams.get('photos') === '1', emp.companyId);
      return send(res, 200, out);
    }

    if (p === '/api/push' && req.method === 'POST') {
      const co = companyById(emp.companyId);
      if (co && membershipView(co).expired) return send(res, 402, { error: 'payment_required', detail: 'membership expired — renew to add or edit cars', simulate: alipay.simulate() });
      const b = await readBody(req);
      const r = applyPush(emp, b);
      return send(res, 200, Object.assign({ now: now() }, r));
    }

    if (p === '/api/audit' && isTop(emp)) {
      return send(res, 200, { rows: q('SELECT * FROM audit WHERE company_id=? ORDER BY id DESC LIMIT 200').all(emp.companyId) });
    }

    return send(res, 404, { error: 'no_route' });
  } catch (e) {
    console.error('[err]', e.message);
    return send(res, 400, { error: e.message });
  }
});

seed();
ensureDefaultCompany();
server.listen(PORT, () => {
  console.log(`Ant Motors sync server → http://localhost:${PORT}`);
  console.log(`  db: ${DB_PATH}`);
  console.log(`  app: ${APP_DIR}`);
  console.log(`  auth: real passwords (≥${PW_MIN} chars, mixed case + digit + symbol), lockout after ${LOCK_AFTER} failures for ${LOCK_MS / 60000} min`);
  console.log(`  mail: ${mailer.enabled() ? 'SMTP configured (' + mailer.cfg().host + ')' : 'not configured — reset codes are printed here' + (SELF_SERVE_CODE ? ' and returned to the caller (self-use mode)' : '')}`);
  console.log(`  config: ${configLoader.sources()}`);

  /* A container that writes its database outside the mounted volume will lose
   * every account and vehicle on the next redeploy. Shout about it. */
  if (inContainer() && !DB_PATH.startsWith('/data')) {
    console.warn('');
    console.warn('  ****************************************************************');
    console.warn('  *  WARNING: database is NOT on a persistent volume.            *');
    console.warn(`  *  Current path: ${DB_PATH}`);
    console.warn('  *  Everything will be ERASED on the next restart/redeploy.     *');
    console.warn('  *  Fix: mount a volume at /data, then set  DB=/data/antmotors.db *');
    console.warn('  ****************************************************************');
    console.warn('');
  } else if (DB_PATH.startsWith('/data')) {
    console.log('  storage: persistent volume at /data ✓');
  }
});
