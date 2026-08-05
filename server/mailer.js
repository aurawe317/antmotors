/*
 * Ant Motors — minimal SMTP sender (zero dependencies).
 *
 * Used to deliver password-reset codes. Configure in server/config.json:
 *
 *   "smtp": {
 *     "host": "smtp.qq.com",
 *     "port": 465,            // implicit TLS (recommended)
 *     "user": "you@qq.com",
 *     "pass": "authorization-code",
 *     "from": "Ant Motors <you@qq.com>"
 *   }
 *
 * If `smtp` is absent the mailer reports itself disabled and the server falls
 * back to printing the reset code in the console (self-use / dev mode).
 */
'use strict';
const tls = require('node:tls');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

/* Settings come from server/config.json locally, or SMTP_* / APP_CONFIG
 * environment variables when running on a PaaS with no config file. */
let CFG = null;
try {
  const c = require('./config-loader').load();
  if (c && c.smtp && c.smtp.host) CFG = c.smtp;
} catch (e) { console.warn('[mailer] config read failed:', e.message); }

const enabled = () => !!(CFG && CFG.host && CFG.user && CFG.pass);
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

/* Walk an SMTP script: each step waits for a reply code then sends a line. */
function converse(sock, script, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '', i = -1, done = false;
    const finish = (err) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch (_) {}
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('smtp_timeout')), timeoutMs || 15000);
    sock.setEncoding('utf8');
    sock.on('error', (e) => finish(e));
    sock.on('close', () => { if (!done) finish(new Error('smtp_closed')); });
    sock.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (!/^\d{3} /.test(last)) return;           // multi-line reply not finished
      const code = +last.slice(0, 3);
      buf = '';
      const prev = script[i];
      if (prev && prev.expect && !prev.expect.includes(code)) return finish(new Error('smtp_' + code + ': ' + last.trim()));
      if (!prev && code !== 220) return finish(new Error('smtp_greeting_' + code));
      i++;
      if (i >= script.length) return finish(null);
      sock.write(script[i].send + '\r\n');
    });
  });
}

function encodeHeader(s) { // RFC 2047 so Chinese subjects survive
  return /^[\x20-\x7E]*$/.test(s) ? s : '=?UTF-8?B?' + b64(s) + '?=';
}

/**
 * Send one plain-text mail. Resolves { delivered:true } or throws.
 */
async function sendMail({ to, subject, text }) {
  if (!enabled()) return { delivered: false, reason: 'not_configured' };
  const host = CFG.host;
  const port = +(CFG.port || 465);
  const from = CFG.from || CFG.user;
  const fromAddr = (from.match(/<([^>]+)>/) || [null, from])[1];

  const body = [
    'From: ' + (from.includes('<') ? encodeHeader(from.replace(/<.*/, '').trim()) + ' <' + fromAddr + '>' : fromAddr),
    'To: ' + to,
    'Subject: ' + encodeHeader(subject),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'Date: ' + new Date().toUTCString(),
    '',
    b64(text).replace(/(.{76})/g, '$1\r\n')
  ].join('\r\n');

  const script = [
    { send: 'EHLO antmotors', expect: [250] },
    { send: 'AUTH LOGIN', expect: [334] },
    { send: b64(CFG.user), expect: [334] },
    { send: b64(CFG.pass), expect: [235] },
    { send: 'MAIL FROM:<' + fromAddr + '>', expect: [250] },
    { send: 'RCPT TO:<' + to + '>', expect: [250, 251] },
    { send: 'DATA', expect: [354] },
    { send: body + '\r\n.', expect: [250] },
    { send: 'QUIT', expect: [221] }
  ];

  const sock = port === 465
    ? tls.connect({ host, port, servername: host, rejectUnauthorized: CFG.rejectUnauthorized !== false })
    : net.connect({ host, port });

  await converse(sock, script, CFG.timeoutMs);
  return { delivered: true };
}

module.exports = { enabled, sendMail, cfg: () => CFG };
