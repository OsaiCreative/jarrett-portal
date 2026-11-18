'use strict';
// Jarrett Adams Opportunity Portal — tiny server.
// Serves the portal behind a login and keeps everyone's progress (statuses,
// checklist ticks, who changed what) in one shared JSON file on a Railway volume.
// No dependencies: Node 22 standard library only.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_DAYS = 30;
const LOG_MAX = 300;

// PORTAL_USERS = {"carla":{"name":"Carla","hash":"scrypt$<salt>$<hash>"}, ...}
let USERS = {};
try { USERS = JSON.parse(process.env.PORTAL_USERS || '{}'); } catch (e) { USERS = {}; }
const CONFIGURED = SESSION_SECRET.length >= 32 && Object.keys(USERS).length > 0;
if (!CONFIGURED) console.error('[portal] PORTAL_USERS / SESSION_SECRET missing — refusing to serve the portal.');

const INDEX = fs.readFileSync(path.join(__dirname, 'index.html'));

// ------------------------------------------------------------------ state
fs.mkdirSync(DATA_DIR, { recursive: true });
let state = { s: {}, t: {}, meta: {}, log: [] };
try {
  const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  state = { s: raw.s || {}, t: raw.t || {}, meta: raw.meta || {}, log: raw.log || [] };
} catch (e) { /* first run */ }

function persist() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
  // one dated snapshot per day, keep the last 30
  const snap = path.join(DATA_DIR, 'state-' + new Date().toISOString().slice(0, 10) + '.json');
  if (!fs.existsSync(snap)) {
    fs.copyFileSync(STATE_FILE, snap);
    const old = fs.readdirSync(DATA_DIR).filter(f => /^state-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    old.slice(0, Math.max(0, old.length - 30)).forEach(f => fs.unlinkSync(path.join(DATA_DIR, f)));
  }
}

const STATUSES = ['todo', 'working', 'submitted', 'confirmed', 'passed'];
const ID_RE = /^[a-z0-9-]{1,80}$/;
function clean(str, n) { return String(str || '').replace(/\s+/g, ' ').trim().slice(0, n); }

function applyChange(kind, id, value, label, user, opts) {
  if (!ID_RE.test(id)) return false;
  const key = kind + ':' + id;
  if (kind === 's') {
    if (!STATUSES.includes(value)) return false;
    if (opts.fillOnly && state.s[id]) return false;
    if (state.s[id] === value) return false;
    state.s[id] = value;
  } else if (kind === 't') {
    value = !!value;
    if (opts.fillOnly && id in state.t) return false;
    if (!!state.t[id] === value) return false;
    if (value) state.t[id] = true; else delete state.t[id];
  } else return false;
  const at = new Date().toISOString();
  state.meta[key] = { by: user.name, at };
  state.log.unshift({ by: user.name, at, kind, id, value, label: clean(label, 120), imported: !!opts.fillOnly });
  if (state.log.length > LOG_MAX) state.log.length = LOG_MAX;
  return true;
}

// ------------------------------------------------------------------ auth
function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const got = crypto.scryptSync(String(password), salt, expected.length);
  return crypto.timingSafeEqual(got, expected);
}
function sign(payload) { return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url'); }
function makeSession(username) {
  const payload = username + '.' + (Date.now() + SESSION_DAYS * 864e5);
  return payload + '.' + sign(payload);
}
function readSession(req) {
  const m = /(?:^|;\s*)portal_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const parts = decodeURIComponent(m[1]).split('.');
  if (parts.length !== 3) return null;
  const payload = parts[0] + '.' + parts[1];
  const a = Buffer.from(sign(payload)), b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(parts[1]) < Date.now()) return null;
  const u = USERS[parts[0]];
  return u ? { username: parts[0], name: u.name || parts[0] } : null;
}
function cookie(req, value, maxAge) {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  return 'portal_session=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + secure;
}

// simple brute-force brake: 8 failed logins per IP per 15 minutes
const fails = new Map();
function ipOf(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function blocked(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60e3) { fails.delete(ip); return false; }
  return f.count >= 8;
}
function noteFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > 15 * 60e3) fails.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

// ------------------------------------------------------------------ http helpers
const BASE_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store'
};
function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({}, BASE_HEADERS, headers || {}));
  res.end(body);
}
function json(res, code, obj) { send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' }); }
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function loginPage(message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow"><title>Sign in — Jarrett Adams Opportunity Portal</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,600;1,500&family=Archivo:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#16281D;font-family:'Archivo',sans-serif;color:#1B241E;padding:24px}
.card{width:100%;max-width:380px;background:#FBF7EE;padding:34px 30px 30px;position:relative;box-shadow:0 18px 50px rgba(0,0,0,.35)}
.card::before{content:"";position:absolute;left:0;right:0;top:0;height:4px;background:linear-gradient(90deg,#A98736,#C9A959,#A98736)}
.eyebrow{font-size:10.5px;letter-spacing:.22em;text-transform:uppercase;color:#8A6D24;margin-bottom:8px}
h1{font-family:'Cormorant Garamond',serif;font-weight:600;font-size:34px;line-height:1.05;color:#16281D;margin-bottom:22px}
h1 em{font-style:italic;color:#A98736}
label{display:block;font-size:10.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#5E6E5B;margin:14px 0 6px}
input{width:100%;padding:11px 12px;border:1px solid #D8CDB4;background:#fff;font:15px 'Archivo',sans-serif;color:#1B241E;border-radius:2px}
input:focus{outline:2px solid #C9A959;outline-offset:0;border-color:#A98736}
button{margin-top:22px;width:100%;padding:12px;border:0;background:#24402F;color:#fff;font:700 12px 'Archivo',sans-serif;letter-spacing:.14em;text-transform:uppercase;cursor:pointer;border-radius:2px}
button:hover{background:#16281D}
.msg{margin-top:16px;font-size:13px;color:#A3402A;min-height:18px}
.foot{margin-top:18px;font-size:11.5px;color:#7a857a}
</style></head><body>
<form class="card" method="POST" action="/login" autocomplete="on">
<div class="eyebrow">Redeeming Justice · Command Center</div>
<h1>Jarrett Adams<br><em>Opportunity Portal</em></h1>
<label for="u">Name</label><input id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button>
<div class="msg">${esc(message || '')}</div>
<div class="foot">Private workspace for the Jarrett Adams team.</div>
</form></body></html>`;
}

function publicState(user) {
  return { s: state.s, t: state.t, meta: state.meta, log: state.log.slice(0, 40), me: user ? { name: user.name } : null };
}

// ------------------------------------------------------------------ server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
    if (!CONFIGURED) return send(res, 503, 'Portal is not configured yet.', { 'Content-Type': 'text/plain' });

    if (p === '/login' && req.method === 'GET') {
      if (readSession(req)) return send(res, 302, '', { Location: '/' });
      return send(res, 200, loginPage(''), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (p === '/login' && req.method === 'POST') {
      const ip = ipOf(req);
      if (blocked(ip)) return send(res, 429, loginPage('Too many attempts. Try again in 15 minutes.'), { 'Content-Type': 'text/html; charset=utf-8' });
      const form = new URLSearchParams(await readBody(req, 4096));
      const username = clean(form.get('username'), 40).toLowerCase();
      const u = USERS[username];
      if (u && verifyPassword(form.get('password') || '', u.hash)) {
        fails.delete(ip);
        console.log('[portal] sign-in', username);
        return send(res, 302, '', { Location: '/', 'Set-Cookie': cookie(req, makeSession(username), SESSION_DAYS * 86400) });
      }
      noteFail(ip);
      return send(res, 401, loginPage('That name and password don\'t match.'), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (p === '/logout') return send(res, 302, '', { Location: '/login', 'Set-Cookie': cookie(req, '', 0) });

    const user = readSession(req);
    if (!user) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'signed out' });
      return send(res, 302, '', { Location: '/login' });
    }

    if (p === '/' || p === '/index.html') {
      return send(res, 200, INDEX, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (p === '/api/state' && req.method === 'GET') return json(res, 200, publicState(user));

    if ((p === '/api/update' || p === '/api/merge') && req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').includes('application/json')) return json(res, 415, { error: 'json only' });
      const body = JSON.parse(await readBody(req, 64 * 1024) || '{}');
      let changed = false;
      if (p === '/api/update') {
        changed = applyChange(body.kind, String(body.id || ''), body.value, body.label, user, {});
      } else {
        const labels = body.labels || {};
        Object.keys(body.s || {}).forEach(id => { if (applyChange('s', id, body.s[id], labels[id], user, { fillOnly: true })) changed = true; });
        Object.keys(body.t || {}).forEach(id => { if (body.t[id] && applyChange('t', id, true, labels[id], user, { fillOnly: true })) changed = true; });
      }
      if (changed) persist();
      return json(res, 200, publicState(user));
    }
    if (p === '/api/export' && req.method === 'GET') {
      return send(res, 200, JSON.stringify(state, null, 2), {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="portal-progress-' + new Date().toISOString().slice(0, 10) + '.json"'
      });
    }
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  } catch (err) {
    console.error('[portal] error', p, err && err.message);
    if (!res.headersSent) json(res, 400, { error: 'bad request' });
  }
});

server.listen(PORT, () => console.log('[portal] listening on', PORT, '· data in', DATA_DIR, '· users:', Object.keys(USERS).join(', ') || 'none'));
