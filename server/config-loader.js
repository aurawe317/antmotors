/**
 * Unified configuration loader — zero dependencies.
 *
 * Local development reads server/config.json (gitignored, may hold secrets).
 * Cloud platforms (Railway / Render / Fly / any container) have no such file,
 * so the same settings can be supplied through environment variables.
 *
 * Precedence (later wins):
 *   1. server/config.json
 *   2. APP_CONFIG            — a whole JSON blob, e.g. {"smtp":{...}}
 *   3. Individual variables  — SMTP_HOST, PERMANENT_CODES, ALIPAY_CONFIG, ...
 *
 * Individual variables win because they are the easiest thing to tweak in a
 * PaaS dashboard without redeploying.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function readJsonFile(p) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (e) {
    console.warn('[config] could not read ' + path.basename(p) + ':', e.message);
  }
  return {};
}

function readJsonEnv(name) {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[config] ' + name + ' is not valid JSON — ignored:', e.message);
    return null;
  }
}

/** Shallow-merge that ignores undefined/null values on the right-hand side. */
function merge(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  const out = Object.assign({}, base);
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = merge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

let CACHE = null;

function load() {
  if (CACHE) return CACHE;

  let cfg = readJsonFile(CONFIG_PATH);
  cfg = merge(cfg, readJsonEnv('APP_CONFIG'));

  /* ---- SMTP from discrete variables ---- */
  const e = process.env;
  if (e.SMTP_HOST) {
    cfg.smtp = merge(cfg.smtp || {}, {
      host: e.SMTP_HOST,
      port: e.SMTP_PORT ? +e.SMTP_PORT : undefined,
      user: e.SMTP_USER,
      pass: e.SMTP_PASS,
      from: e.SMTP_FROM,
      // "false"/"0"/"no" all disable TLS; anything else (or absent) keeps it on
      secure: e.SMTP_SECURE === undefined ? undefined : !/^(false|0|no)$/i.test(e.SMTP_SECURE),
    });
  }

  /* ---- Lifetime-membership company codes ---- */
  if (e.PERMANENT_CODES !== undefined) {
    cfg.permanentCompanyCodes = e.PERMANENT_CODES
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }

  /* ---- Once real mail works, stop echoing reset codes back to the client ---- */
  if (e.SELF_SERVE_RESET_CODE !== undefined) {
    cfg.selfServeResetCode = !/^(false|0|no)$/i.test(e.SELF_SERVE_RESET_CODE);
  }

  CACHE = cfg;
  return CACHE;
}

/** Alipay keeps its own file so credentials stay isolated from app settings. */
function loadAlipay() {
  const fileCfg = readJsonFile(path.join(__dirname, 'alipay.config.json'));
  const envCfg = readJsonEnv('ALIPAY_CONFIG');
  const e = process.env;
  let cfg = merge(fileCfg, envCfg);
  if (e.ALIPAY_APP_ID) {
    cfg = merge(cfg, {
      appId: e.ALIPAY_APP_ID,
      privateKey: e.ALIPAY_PRIVATE_KEY,
      alipayPublicKey: e.ALIPAY_PUBLIC_KEY,
      notifyUrl: e.ALIPAY_NOTIFY_URL,
      returnUrl: e.ALIPAY_RETURN_URL,
      gateway: e.ALIPAY_GATEWAY,
    });
  }
  return cfg;
}

/** Where secrets came from — printed at boot so misconfiguration is obvious. */
function sources() {
  const s = [];
  if (fs.existsSync(CONFIG_PATH)) s.push('config.json');
  if (process.env.APP_CONFIG) s.push('APP_CONFIG');
  if (process.env.SMTP_HOST) s.push('SMTP_* env');
  if (process.env.PERMANENT_CODES !== undefined) s.push('PERMANENT_CODES env');
  return s.length ? s.join(' + ') : 'defaults only';
}

module.exports = { load, loadAlipay, sources, CONFIG_PATH };
