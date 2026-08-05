'use strict';
/*
 * Alipay (支付宝) client — config-driven, zero external deps.
 * Uses 手机网站支付 (alipay.trade.wap.pay) which works for both web and
 * in-app (the pay URL is rendered as a QR the user scans with Alipay).
 *
 * Credentials come from (precedence high→low):
 *   1. ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY / ALIPAY_PUBLIC_KEY / ALIPAY_NOTIFY_URL
 *      (individual env vars — recommended for Railway / Render)
 *   2. ALIPAY_CONFIG           (a whole JSON blob, e.g. {"appId":"..."})
 *   3. server/alipay.config.json  (gitignored, local development)
 *
 * If none of the above is present, the module runs in SIMULATE mode so the
 * whole billing flow (order → QR → callback → activation) can be developed /
 * tested without a real Alipay merchant account.
 *
 * To go live:
 *   1. Create an app at https://open.alipay.com (手机网站支付 product).
 *   2. Copy your app private key + Alipay public key.
 *   3. Set the env vars above (or fill alipay.config.json locally).
 *   4. Set gateway to the production URL and a public notifyUrl.
 */
const crypto = require('node:crypto');

let cfg = null;
try { cfg = require('./config-loader').loadAlipay(); } catch { cfg = null; }

function enabled() { return !!(cfg && cfg.appId && cfg.appPrivateKey && cfg.alipayPublicKey); }
function simulate() { return !enabled() || !!(cfg && cfg.simulate); }

/* Alipay timestamps must be Asia/Shanghai wall-clock: yyyy-MM-dd HH:mm:ss */
function beijingTime() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function sign(params, privateKey) {
  const keys = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] != null)
    .sort();
  const str = keys.map(k => `${k}=${params[k]}`).join('&');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(str, 'utf8');
  return signer.sign(privateKey, 'base64');
}

function verify(params, publicKey) {
  const s = params.sign;
  if (!s) return false;
  const keys = Object.keys(params).filter(k => k !== 'sign' && k !== 'sign_type').sort();
  const str = keys.map(k => `${k}=${params[k]}`).join('&');
  try {
    const v = crypto.createVerify('RSA-SHA256');
    v.update(str, 'utf8');
    return v.verify(publicKey, s, 'base64');
  } catch { return false; }
}

/* Build the signed gateway URL for alipay.trade.wap.pay */
function wapPayUrl({ outTradeNo, subject, totalAmount, passbackParams }) {
  const gateway = (cfg && cfg.gateway) || 'https://openapi.alipay.com/gateway.do';
  const params = {
    app_id: cfg.appId,
    method: 'alipay.trade.wap.pay',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: beijingTime(),
    version: '1.0',
    notify_url: (cfg && cfg.notifyUrl) || '',
    return_url: (cfg && cfg.returnUrl) || '',
    biz_content: JSON.stringify({
      out_trade_no: outTradeNo,
      product_code: 'QUICK_WAP_WAY',
      subject,
      total_amount: totalAmount,
      quit_url: (cfg && cfg.returnUrl) || '',
      passback_params: passbackParams || ''
    })
  };
  params.sign = sign(params, cfg.appPrivateKey);
  const qs = Object.keys(params).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  return gateway + '?' + qs;
}

module.exports = { enabled, simulate, beijingTime, sign, verify, wapPayUrl, cfg };
