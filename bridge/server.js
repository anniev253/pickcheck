'use strict';
/*
 * Pick Check bridge
 * -----------------
 * Small always-on server that:
 *   1. logs into Cultivera Pro with its own user account,
 *   2. exposes GET /api/order/<orderNo> -> normalized pick list (lines + lot barcodes + units),
 *   3. serves the Pick Check gun app (../pickcheck.html) on the same origin.
 *
 * Zero dependencies. Needs Node.js 18 or newer (built-in fetch).
 * Config lives in bridge/config.json (copy config.example.json).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;
const CONFIG_PATH = process.env.PICKCHECK_CONFIG || path.join(ROOT, 'config.json');
const APP_HTML = path.join(ROOT, '..', 'pickcheck.html');

// ---------------------------------------------------------------- config
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fail('Missing bridge\\config.json.\nCopy config.example.json to config.json and fill in the Cultivera login.');
  }
  let c;
  try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { fail('config.json is not valid JSON: ' + e.message); }
  if (!c.cultiveraUsername || !c.cultiveraPassword) fail('config.json needs "cultiveraUsername" and "cultiveraPassword".');
  const out = Object.assign({ port: 8080, apiBase: 'https://api-wa.cultiverapro.com/api', accessKey: '', appPassword: '', cacheSeconds: 20, pickerName: 'Picker' }, c);
  // updates.auto: "idle" (default) installs a pending update within ~10 min of a push once the gun has been idle 15 min;
  //               "hour" installs only at updates.autoHour; "manual" only via the reports page.
  out.updates = Object.assign({ repo: '', branch: 'main', token: '', autoHour: null, auto: 'idle', idleMinutes: 15 }, c.updates || {});
  if (out.updates.autoHour != null && !(c.updates && c.updates.auto)) out.updates.auto = 'hour';
  return out;
}
function fail(msg) { console.error('\n' + msg + '\n'); process.exit(1); }
const cfg = loadConfig();

// ---------------------------------------------------------------- logging
const ts = () => new Date().toLocaleTimeString();
const log = (...a) => console.log(ts(), ...a);
let lastError = null;
const STARTED_AT = new Date().toISOString();

// ---------------------------------------------------------------- item locations (optional spreadsheet)
const locations = require('./locations.js').create(cfg.locations, log);

// ---------------------------------------------------------------- Cultivera session
let token = null;
let tokenExp = 0;

function jwtExpiry(t) {
  try {
    const payload = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));
    return (payload.exp || 0) * 1000;
  } catch { return 0; }
}

// Node reports every network problem as "fetch failed"; surface the real cause (DNS, timeout, reset...).
function describeNetworkError(e) {
  const code = e && e.cause && (e.cause.code || e.cause.message);
  const why = code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'DNS lookup failed (no internet?)'
    : code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' ? 'connection timed out'
    : code === 'ECONNRESET' ? 'connection reset'
    : code === 'ECONNREFUSED' ? 'connection refused'
    : code ? String(code) : (e && e.message) || 'unknown error';
  return 'Cannot reach Cultivera: ' + why + '. Check this PC\'s internet connection; the bridge will keep retrying.';
}

async function login() {
  let res;
  try {
    res = await fetch(cfg.apiBase + '/v1/auth/sign-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        username: cfg.cultiveraUsername,
        password: cfg.cultiveraPassword,
        utcOffset: -new Date().getTimezoneOffset(),   // minutes east of UTC, same as moment().utcOffset()
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    const err = httpError(503, describeNetworkError(e)); err.network = true; throw err;
  }
  if (!res.ok) {
    throw httpError(502, 'Cultivera login failed (HTTP ' + res.status + '). Check cultiveraUsername / cultiveraPassword in config.json.');
  }
  const data = await res.json();
  if (data.MustAcceptTc) {
    throw httpError(502, 'This Cultivera account must accept updated Terms & Conditions. Log in once in a browser as ' + cfg.cultiveraUsername + ', accept them, then restart the bridge.');
  }
  if (!data.Token) throw httpError(502, 'Cultivera login returned no token.');
  token = data.Token;
  tokenExp = jwtExpiry(token);
  lastError = null;
  log('Logged into Cultivera as ' + cfg.cultiveraUsername + ' (session good until ' + new Date(tokenExp).toLocaleString() + ')');
}

async function ensureToken() {
  const soon = Date.now() + 15 * 60 * 1000;
  if (!token || tokenExp < soon) await login();
  return token;
}

async function api(pathname, opts = {}, retry = true) {
  const t = await ensureToken();
  let res;
  try {
    res = await fetch(cfg.apiBase + pathname, {
      ...opts,
      headers: { Authorization: 'Bearer ' + t, Accept: 'application/json', ...(opts.headers || {}) },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) { throw httpError(503, describeNetworkError(e)); }
  if (res.status === 401 && retry) { token = null; return api(pathname, opts, false); }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw httpError(res.status === 404 ? 404 : 502, 'Cultivera returned HTTP ' + res.status + ' for ' + pathname + (body ? ': ' + body.slice(0, 200) : ''));
  }
  return res.json();
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// ---------------------------------------------------------------- order lookup
const num = v => (v == null ? 0 : Number(v));
const uniq = arr => [...new Set(arr.filter(x => x != null && String(x).trim() !== '').map(x => String(x).trim()))];

const cache = new Map(); // orderNo -> {at, data}

async function getOrder(orderNoRaw) {
  const orderNo = String(orderNoRaw).replace(/\D/g, '');
  if (!orderNo) throw httpError(400, 'Order number must be numeric (e.g. 15537).');

  const hit = cache.get(orderNo);
  if (hit && Date.now() - hit.at < cfg.cacheSeconds * 1000) return hit.data;

  const look = await api('/v1/orders/get-order-by-number/' + orderNo).catch(e => {
    if (e.status === 404) throw httpError(404, 'Order ' + orderNo + ' was not found in Cultivera.');
    throw e;
  });
  if (!look || !look.Id) throw httpError(404, 'Order ' + orderNo + ' was not found in Cultivera.');

  const pl = await api('/v1/fulfillment/order-pick-list/' + look.Id);
  const products = pl.PickProducts || [];
  if (locations) await locations.ensure();

  const lines = products.map(p => ({
    itemId: p.OrderItemId,
    name: p.ProductName || ('Product ' + p.ProductId),
    type: p.ProductType || p.ProductCategory || p.ProductTypeName || '',
    strain: p.ProductStrain || '',
    size: p.ProductPackageSize || '',
    qty: num(p.Units),
    allocated: num(p.UnitsAllocated),
    sample: !!p.IsSample,
    allocs: (p.Allocations || []).map(a => ({
      barcodes: uniq([a.Barcode, a.SublottedInventoryBarcode, a.UseAltTSID ? a.AltTSID : null]),
      qty: num(a.UnitsAllocated),
      location: [a.Room, a.Aisle, a.Shelf, a.Bin].filter(Boolean).join(' / '),
    })).filter(a => a.qty > 0 && a.barcodes.length),
  }));

  // Merge spreadsheet locations: by lot barcode when the sheet has it, else by product name (+ type), else the product line.
  if (locations) for (const l of lines) {
    const hit = locations.lookup(l);
    if (!hit) continue;
    l.location = hit.line || '';
    l.locationSource = hit.source;
    for (const a of l.allocs) a.location = hit.lots[a.barcodes[0]] || (hit.source === 'sheet' ? hit.line : '') || a.location;
  }

  const data = {
    id: look.Id,
    orderNo: Number(pl.OrderNo || orderNo),
    customer: (products[0] && products[0].ClientTradename) || '',
    status: pl.Status || '',
    cancelled: !!look.IsCanceled,
    released: !!pl.Released,
    lines,
    fetchedAt: new Date().toISOString(),
  };
  cache.set(orderNo, { at: Date.now(), data });
  return data;
}

// ---------------------------------------------------------------- open orders (allocated, waiting to be picked) + lot index
let openCache = { at: 0, list: [] };
const pickCache = new Map();   // orderId -> {at, data}   (raw pick-list responses, for the lot index)

async function openOrders() {
  if (Date.now() - openCache.at < 45 * 1000) return openCache.list;
  const body = {
    Page: { Skip: 0, Take: 200, Sort: [{ field: 'EstimateDeliveryDate', dir: 'asc' }], HasSortInfo: true },
    ShowSubmitted: true, ShowPartiallySublotted: true, ShowSublotted: true, ShowManifested: false, ShowQuarantined: false, ShowInvoiced: false,
    ShowBackorders: false, ShowOnlyNonCannabis: false, HideNonSamplesOnly: false, HideSamplesOnly: false, HideReleased: false, HideCancelled: true, PartnerName: '',
  };
  const res = await api('/v1/fulfillment/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const list = (res.Data || []).filter(o => !o.IsCanceled && !o.IsCancelled).map(o => ({
    id: o.OrderId, orderNo: o.OrderNo, customer: o.Tradename || '', status: o.Status || '', deliveryDate: o.EstimateDeliveryDate || null,
    samplesOnly: !!o.IsAllSample, ready: /sublotted/i.test(o.Status) && !/partial/i.test(o.Status),
  }));
  openCache = { at: Date.now(), list };
  return list;
}

async function rawPickList(id) {
  const hit = pickCache.get(id);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;
  const data = await api('/v1/fulfillment/order-pick-list/' + id);
  pickCache.set(id, { at: Date.now(), data });
  return data;
}

// Which open orders have this lot barcode allocated? (Scanning a package or lot tag on the home screen finds its order.)
async function findByLot(barcodeRaw) {
  const d = String(barcodeRaw).replace(/\D/g, '');
  if (d.length < 6) throw httpError(400, 'Scan a lot barcode (at least 6 digits).');
  const orders = (await openOrders()).filter(o => o.ready || /partial/i.test(o.status));
  const matches = [];
  await Promise.all(orders.map(async o => {
    try {
      const pl = await rawPickList(o.id);
      for (const p of pl.PickProducts || []) for (const a of p.Allocations || []) {
        const codes = [a.Barcode, a.SublottedInventoryBarcode, a.AltTSID].filter(Boolean).map(x => String(x).replace(/\D/g, ''));
        if (codes.some(c => c === d || (d.length >= 8 && c.endsWith(d)))) { matches.push({ ...o, product: p.ProductName, units: num(a.UnitsAllocated) }); return; }
      }
    } catch (e) { /* skip an order we cannot read */ }
  }));
  return matches;
}

async function searchOrders(q) {
  const res = await api('/v1/orders/find-order-numbers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'SearchKey=' + encodeURIComponent(q),
  });
  return (Array.isArray(res) ? res : []).map(r => ({
    orderNo: r.OrderNo, customer: r.ClientTradeName || '', deliveryDate: r.DeliveryDate || null, cancelled: !!r.IsCancelled,
  }));
}

// ---------------------------------------------------------------- pick event log (CSV per day)
const DATA_DIR = path.join(ROOT, 'data');
const REPORTS_HTML = path.join(ROOT, 'reports.html');
const CSV_HEADER = ['timestamp', 'picker', 'orderNo', 'customer', 'event', 'product', 'lot', 'before', 'after', 'target', 'detail'];
let lastEventAt = 0;   // when the gun last reported activity (used to avoid updating mid-pick)
const EVENT_TYPES = new Set(['order_loaded', 'order_refreshed', 'scan_ok', 'scan_rejected', 'count_set', 'line_short', 'line_unshort', 'line_reset', 'order_complete', 'order_verified', 'order_issues', 'order_cleared']);

const pad = n => String(n).padStart(2, '0');
const localDay = ts => { const d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const clip = (v, n) => (v == null ? '' : String(v).slice(0, n));

function appendEvents(events) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const byDay = {};
  for (const e of events) (byDay[localDay(e.ts)] ||= []).push(e);
  for (const [day, evs] of Object.entries(byDay)) {
    const file = path.join(DATA_DIR, 'picks-' + day + '.csv');
    const fresh = !fs.existsSync(file);
    const rows = evs.map(e => [new Date(e.ts).toISOString(), e.picker, e.orderNo, e.customer, e.event, e.product, e.lot, e.before, e.after, e.target, e.detail].map(csvCell).join(','));
    fs.appendFileSync(file, (fresh ? CSV_HEADER.join(',') + '\n' : '') + rows.join('\n') + '\n');
  }
}

function sanitizeEvents(list) {
  if (!Array.isArray(list)) throw httpError(400, 'events must be an array');
  if (list.length > 500) throw httpError(400, 'too many events in one post (max 500)');
  return list.map(e => {
    const ts = typeof e.ts === 'number' ? e.ts : Date.parse(e.ts);
    if (!ts || !EVENT_TYPES.has(e.event)) throw httpError(400, 'bad event: ' + JSON.stringify(e).slice(0, 120));
    return {
      ts, picker: clip(e.picker, 60) || cfg.pickerName, orderNo: clip(e.orderNo, 12), customer: clip(e.customer, 80), event: e.event,
      product: clip(e.product, 120), lot: clip(e.lot, 40), before: num(e.before), after: num(e.after), target: num(e.target), detail: clip(e.detail, 200),
    };
  });
}

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function readEvents(from, to) {
  if (!fs.existsSync(DATA_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(DATA_DIR).sort()) {
    const m = f.match(/^picks-(\d{4}-\d{2}-\d{2})\.csv$/);
    if (!m || m[1] < from || m[1] > to) continue;
    const rows = parseCsv(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
    const hdr = rows.shift() || [];
    for (const r of rows) {
      if (r.length < 5) continue;
      const o = {}; hdr.forEach((h, i) => { o[h] = r[i] == null ? '' : r[i]; });
      o.before = num(o.before); o.after = num(o.after); o.target = num(o.target);
      out.push(o);
    }
  }
  return out;
}

function buildStats(events) {
  const days = {}, orders = {};
  const dayRec = d => days[d] ||= { day: d, ordersStarted: new Set(), ordersVerified: new Set(), units: 0, scans: 0, rejected: 0, counts: 0, shorts: 0 };
  for (const e of events) {
    const t = Date.parse(e.timestamp);
    const d = dayRec(localDay(t));
    const o = orders[e.orderNo] ||= { orderNo: e.orderNo, customer: e.customer, picker: e.picker, first: t, last: t, finished: null, status: 'in progress', lines: 0, targetUnits: 0, units: 0, scans: 0, rejected: 0, counts: 0, shorts: 0 };
    if (t < o.first) o.first = t; if (t > o.last) o.last = t;
    if (e.customer && !o.customer) o.customer = e.customer;
    switch (e.event) {
      case 'order_loaded': d.ordersStarted.add(e.orderNo); o.lines = e.before; o.targetUnits = e.target; break;
      case 'order_refreshed': o.lines = e.before; o.targetUnits = e.target; break;
      case 'scan_ok': { const dl = e.after - e.before; d.units += dl; o.units += dl; d.scans++; o.scans++; break; }
      case 'count_set': { const dl = e.after - e.before; d.units += dl; o.units += dl; d.counts++; o.counts++; break; }
      case 'line_reset': d.units -= e.before; o.units -= e.before; break;
      case 'scan_rejected': d.rejected++; o.rejected++; break;
      case 'line_short': d.shorts++; o.shorts++; break;
      case 'order_complete': if (!o.finished) { o.finished = t; o.status = 'complete'; } break;
      case 'order_verified': d.ordersVerified.add(e.orderNo); o.finished = t; o.status = 'verified'; break;
      case 'order_issues': o.finished = t; o.status = 'finished with issues'; break;
      case 'order_cleared': if (o.status === 'in progress') o.status = 'cleared'; break;
    }
  }
  const dayList = Object.values(days).sort((a, b) => a.day < b.day ? 1 : -1).map(d => ({ ...d, ordersStarted: d.ordersStarted.size, ordersVerified: d.ordersVerified.size }));
  const orderList = Object.values(orders).sort((a, b) => b.first - a.first).map(o => ({ ...o, first: new Date(o.first).toISOString(), last: new Date(o.last).toISOString(), finished: o.finished ? new Date(o.finished).toISOString() : null, minutes: o.finished ? Math.round((o.finished - o.first) / 6000) / 10 : null }));
  const done = orderList.filter(o => o.minutes != null);
  const totals = {
    ordersStarted: orderList.length, ordersVerified: orderList.filter(o => o.status === 'verified').length,
    units: dayList.reduce((s, d) => s + d.units, 0), scans: dayList.reduce((s, d) => s + d.scans, 0), rejected: dayList.reduce((s, d) => s + d.rejected, 0),
    avgMinutesPerOrder: done.length ? Math.round(done.reduce((s, o) => s + o.minutes, 0) / done.length * 10) / 10 : null,
  };
  return { totals, days: dayList, orders: orderList };
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > limit) { reject(httpError(413, 'body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(httpError(400, 'invalid JSON body')); } });
    req.on('error', reject);
  });
}

function dateRange(url) {
  const today = localDay(Date.now());
  const from = (url.searchParams.get('from') || today).slice(0, 10), to = (url.searchParams.get('to') || today).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw httpError(400, 'from/to must be YYYY-MM-DD');
  return { from, to };
}

// ---------------------------------------------------------------- sign-in (shared password -> session cookie)
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SESSION_DAYS = 30;
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch (e) { sessions = {}; }
function saveSessions() {
  const cutoff = Date.now() - SESSION_DAYS * 86400000;
  for (const [t, s] of Object.entries(sessions)) if (s.created < cutoff) delete sessions[t];
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions)); } catch (e) {}
}
const cookiesOf = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const isHttps = req => /https/.test(req.headers['x-forwarded-proto'] || '') || /"scheme":"https"/.test(req.headers['cf-visitor'] || '');
const clientIp = req => req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';

function isAuthed(req, url) {
  if (!cfg.appPassword) return true;                                   // no password configured: open (LAN-only use)
  if (cfg.accessKey && (req.headers['x-pickcheck-key'] || url.searchParams.get('key')) === cfg.accessKey) return true;
  const t = cookiesOf(req).pc_session;
  return !!(t && sessions[t] && Date.now() - sessions[t].created < SESSION_DAYS * 86400000);
}

const loginAttempts = new Map();   // ip -> {count, first}
function loginAllowed(ip) {
  const a = loginAttempts.get(ip);
  if (!a || Date.now() - a.first > 15 * 60000) { loginAttempts.set(ip, { count: 1, first: Date.now() }); return true; }
  a.count++;
  return a.count <= 10;
}
const safeEqual = (a, b) => { const ha = crypto.createHash('sha256').update(String(a)).digest(), hb = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(ha, hb); };

function signIn(req, res, body) {
  if (!cfg.appPassword) return send(res, 200, { ok: true, open: true });
  const ip = clientIp(req);
  if (!loginAllowed(ip)) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes and try again.' });
  if (!body || !safeEqual(body.password || '', cfg.appPassword)) return send(res, 401, { error: 'Wrong password.' });
  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = { created: Date.now(), ip, ua: String(req.headers['user-agent'] || '').slice(0, 120) };
  saveSessions();
  res.setHeader('Set-Cookie', 'pc_session=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_DAYS * 86400 + (isHttps(req) ? '; Secure' : ''));
  log('Sign-in from ' + ip);
  return send(res, 200, { ok: true });
}

function signOut(req, res) {
  const t = cookiesOf(req).pc_session;
  if (t && sessions[t]) { delete sessions[t]; saveSessions(); }
  res.setHeader('Set-Cookie', 'pc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  return send(res, 200, { ok: true });
}

// ---------------------------------------------------------------- self-update from GitHub
// The code lives in a GitHub repo (config "updates.repo", e.g. "oleumlabs/pickcheck"). "Update now" downloads the latest
// commit, checks the new server files load, backs up the current files, swaps them in and restarts. config.json, data/
// and logs/ are never touched. "Roll back" restores the previous files.
const { readZip } = require('./locations.js');
const APP_ROOT = path.join(ROOT, '..');
const VERSION_FILE = path.join(ROOT, 'VERSION');
const BACKUP_DIR = path.join(ROOT, 'backup');
const UPDATABLE = /^(pickcheck\.html|bridge\/(server\.js|locations\.js|reports\.html|picklist\.html|README\.md|MOVE-TO-NEW-PC\.md|config\.example\.json|[A-Za-z0-9._-]+\.cmd|static\/[^/]+))$/;   // .cmd covers takeover/standdown too

function currentVersion() { try { return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')); } catch (e) { return { sha: null, at: null, message: 'installed by hand (no version recorded)' }; } }
const shortSha = s => (s || '').slice(0, 7);

async function ghFetch(pathname) {
  const u = cfg.updates;
  if (!u.repo) throw httpError(400, 'No update source configured. Set "updates": { "repo": "owner/name" } in config.json.');
  const res = await fetch('https://api.github.com/repos/' + u.repo + pathname, {
    redirect: 'follow', signal: AbortSignal.timeout(60000),
    headers: { 'User-Agent': 'PickCheckBridge', Accept: 'application/vnd.github+json', ...(u.token ? { Authorization: 'Bearer ' + u.token } : {}) },
  });
  if (!res.ok) throw httpError(502, 'GitHub answered ' + res.status + ' for ' + pathname + (res.status === 404 || res.status === 401 ? '. Check updates.repo and updates.token in config.json.' : ''));
  return res;
}
async function latestCommit() {
  const j = await (await ghFetch('/commits/' + encodeURIComponent(cfg.updates.branch || 'main'))).json();
  return { sha: j.sha, at: j.commit && j.commit.committer && j.commit.committer.date, message: j.commit ? j.commit.message.split('\n')[0] : '' };
}
async function updateStatus() {
  const current = currentVersion();
  if (!cfg.updates.repo) return { configured: false, current };
  const latest = await latestCommit();
  return { configured: true, repo: cfg.updates.repo, branch: cfg.updates.branch || 'main', current, latest, updateAvailable: latest.sha !== current.sha, autoHour: cfg.updates.autoHour, auto: cfg.updates.auto, idleMinutes: cfg.updates.idleMinutes, idleFor: Math.round((Date.now() - Math.max(lastEventAt, Date.parse(STARTED_AT))) / 60000) };
}

let updating = false;
async function applyUpdate(why) {
  if (updating) throw httpError(409, 'An update is already running.');
  updating = true;
  try {
    const latest = await latestCommit();
    log('Update (' + why + '): downloading ' + shortSha(latest.sha) + ' "' + latest.message + '"');
    const buf = Buffer.from(await (await ghFetch('/zipball/' + latest.sha)).arrayBuffer());
    const zip = readZip(buf);
    const files = {};
    for (const name of Object.keys(zip)) { const rel = name.replace(/^[^/]+\//, ''); if (UPDATABLE.test(rel)) files[rel] = zip[name](); }
    if (!files['bridge/server.js'] || !files['pickcheck.html']) throw httpError(502, 'The download did not contain the app files.');

    const stage = path.join(BACKUP_DIR, 'staging'); fs.rmSync(stage, { recursive: true, force: true });
    for (const [rel, data] of Object.entries(files)) { const p = path.join(stage, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); }
    for (const f of ['bridge/server.js', 'bridge/locations.js']) {
      if (!files[f]) continue;
      const r = require('child_process').spawnSync(process.execPath, ['--check', path.join(stage, f)], { encoding: 'utf8' });
      if (r.status !== 0) throw httpError(502, 'The new ' + f + ' failed its load check; nothing was changed. ' + (r.stderr || '').slice(0, 300));
    }
    const prev = path.join(BACKUP_DIR, 'previous'); fs.rmSync(prev, { recursive: true, force: true });
    for (const rel of Object.keys(files)) {
      const live = path.join(APP_ROOT, rel);
      if (fs.existsSync(live)) { const p = path.join(prev, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.copyFileSync(live, p); }
    }
    fs.mkdirSync(prev, { recursive: true }); fs.writeFileSync(path.join(prev, 'VERSION.json'), JSON.stringify(currentVersion()));
    for (const rel of Object.keys(files)) { const live = path.join(APP_ROOT, rel); fs.mkdirSync(path.dirname(live), { recursive: true }); fs.copyFileSync(path.join(stage, rel), live); }
    fs.writeFileSync(VERSION_FILE, JSON.stringify({ sha: latest.sha, at: new Date().toISOString(), message: latest.message }));
    fs.rmSync(stage, { recursive: true, force: true });
    log('Update applied: ' + Object.keys(files).length + ' files -> ' + shortSha(latest.sha) + '. Restarting.');
    return latest;
  } finally { updating = false; }
}
function rollback() {
  const prev = path.join(BACKUP_DIR, 'previous');
  if (!fs.existsSync(prev)) throw httpError(404, 'No previous version is saved to roll back to.');
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  let n = 0;
  for (const f of walk(prev)) {
    const rel = path.relative(prev, f).replace(/\\/g, '/');
    if (rel === 'VERSION.json') continue;
    const live = path.join(APP_ROOT, rel); fs.mkdirSync(path.dirname(live), { recursive: true }); fs.copyFileSync(f, live); n++;
  }
  try { fs.writeFileSync(VERSION_FILE, fs.readFileSync(path.join(prev, 'VERSION.json'))); } catch (e) {}
  fs.rmSync(prev, { recursive: true, force: true });
  log('Rolled back ' + n + ' files to the previous version. Restarting.');
  return n;
}
function restartSoon() { setTimeout(() => process.exit(0), 700); }   // the service wrapper (NSSM) or start.cmd starts it again

// ---------------------------------------------------------------- HTTP server
const STATIC_DIR = path.join(ROOT, 'static');
const MIME = { '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.gz': 'application/gzip' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
}

function page(res, file, title) {
  if (!fs.existsSync(file)) return send(res, 500, path.basename(file) + ' not found in the bridge folder.', 'text/plain');
  const head = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><link rel="icon" href="/static/favicon-32.png"><link rel="apple-touch-icon" href="/static/favicon-180.png"><meta name="theme-color" content="#223549"></head><body style="margin:0">';
  return send(res, 200, head + fs.readFileSync(file, 'utf8') + '</body></html>', 'text/html; charset=utf-8');
}

function authorized(req, url) { return isAuthed(req, url); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    const isGet = req.method === 'GET' || req.method === 'HEAD';
    if (isGet && (p === '/' || p === '/pickcheck.html' || p === '/index.html')) return page(res, APP_HTML);
    if (isGet && p === '/reports') return page(res, REPORTS_HTML);
    if (isGet && /^\/picklist\/\d+$/.test(p)) return page(res, path.join(ROOT, 'picklist.html'));
    if (isGet && p.startsWith('/static/')) {
      const file = path.join(STATIC_DIR, path.basename(p));
      if (!fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'POST' && p === '/api/login') return signIn(req, res, await readBody(req));
    if (req.method === 'POST' && p === '/api/logout') return signOut(req, res);
    if (p === '/api/me') {
      if (!authorized(req, url)) return send(res, 401, { error: 'Sign in required.', signInRequired: true });
      return send(res, 200, { ok: true, pickerName: cfg.pickerName, open: !cfg.appPassword });
    }
    if (p === '/api/health') {
      if (!authorized(req, url)) return send(res, 401, { ok: true, bridge: 'pickcheck', signInRequired: true });
      return send(res, 200, {
        ok: true, bridge: 'pickcheck', loggedIn: !!token && tokenExp > Date.now(),
        sessionUntil: token ? new Date(tokenExp).toISOString() : null, user: cfg.cultiveraUsername, lastError, keyRequired: !!cfg.accessKey, pickerName: cfg.pickerName,
        locations: locations ? locations.status() : null, version: currentVersion(), startedAt: STARTED_AT,
      });
    }
    if (p.startsWith('/api/')) {
      if (!authorized(req, url)) return send(res, 401, { error: 'Sign in required.', signInRequired: true });
      let m;
      if (req.method === 'POST' && p === '/api/events') {
        const body = await readBody(req);
        const events = sanitizeEvents(body.events);
        if (events.length) { appendEvents(events); lastEventAt = Date.now(); }
        return send(res, 200, { ok: true, stored: events.length });
      }
      if (p === '/api/picks' || p === '/api/picks.csv') {
        const { from, to } = dateRange(url);
        const events = readEvents(from, to);
        if (p.endsWith('.csv')) {
          res.setHeader('Content-Disposition', 'attachment; filename="picks-' + from + '-to-' + to + '.csv"');
          return send(res, 200, CSV_HEADER.join(',') + '\n' + events.map(e => CSV_HEADER.map(h => csvCell(e[h])).join(',')).join('\n') + '\n', 'text/csv; charset=utf-8');
        }
        return send(res, 200, { from, to, count: events.length, events });
      }
      if (p === '/api/stats') {
        const { from, to } = dateRange(url);
        return send(res, 200, { from, to, ...buildStats(readEvents(from, to)) });
      }
      if ((m = p.match(/^\/api\/order\/([^/]+)$/))) {
        const data = await getOrder(decodeURIComponent(m[1]));
        log('Order ' + data.orderNo + ' -> ' + data.lines.length + ' lines for ' + data.customer + ' [' + data.status + ']');
        return send(res, 200, data);
      }
      if (p === '/api/update/status') return send(res, 200, await updateStatus());
      if (req.method === 'POST' && p === '/api/update/apply') { const latest = await applyUpdate('requested from the reports page'); send(res, 200, { ok: true, restarting: true, version: latest }); return restartSoon(); }
      if (req.method === 'POST' && p === '/api/update/rollback') { const n = rollback(); send(res, 200, { ok: true, restarting: true, restored: n }); return restartSoon(); }
      if (p === '/api/open-orders') return send(res, 200, { orders: await openOrders(), fetchedAt: new Date(openCache.at).toISOString() });
      if ((m = p.match(/^\/api\/find-by-lot\/([^/]+)$/))) {
        const matches = await findByLot(decodeURIComponent(m[1]));
        log('Lot lookup ' + m[1].slice(-6) + ' -> ' + matches.map(x => x.orderNo).join(', ') || 'no match');
        return send(res, 200, { matches });
      }
      if (p === '/api/search') {
        const q = (url.searchParams.get('q') || '').trim();
        if (q.length < 2) return send(res, 200, []);
        return send(res, 200, await searchOrders(q));
      }
      return send(res, 404, { error: 'Unknown API route' });
    }
    return send(res, 404, 'Not found', 'text/plain');
  } catch (e) {
    lastError = { at: new Date().toISOString(), message: e.message };
    log('ERROR ' + req.method + ' ' + p + ' -> ' + e.message);
    return send(res, e.status || 500, { error: e.message });
  }
});

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address + '  (' + name + ')');
  }
  return out;
}

// Listen on both IPv4 and IPv6 ("localhost" resolves to ::1 for some clients, including the tunnel service).
server.listen(cfg.port, '::', async () => {
  console.log('\nPick Check bridge listening on port ' + cfg.port);
  console.log('Open on the gun:');
  for (const a of lanAddresses()) console.log('   http://' + a.split(' ')[0] + ':' + cfg.port + '/');
  if (cfg.publicUrl) console.log('   ' + cfg.publicUrl + '  (via the Cloudflare Tunnel service)');
  console.log(cfg.appPassword ? 'Sign-in: shared password is set.' : 'Sign-in: NO PASSWORD SET — anyone who can reach this address can use it. Set "appPassword" in config.json before publishing it on the internet.');
  console.log('');
  try { await login(); }
  catch (e) { lastError = { at: new Date().toISOString(), message: e.message }; console.error(ts(), 'WARNING: ' + e.message); }
  if (locations) await locations.ensure();
  // Pre-build the lot index for open orders so the first "scan a package to find its order" is instant.
  const warmLots = () => openOrders().then(list => Promise.all(list.filter(o => o.ready).map(o => rawPickList(o.id).catch(() => null)))).then(() => log('Lot index ready (' + openCache.list.length + ' open orders)')).catch(e => log('Lot index: ' + e.message));
  setTimeout(warmLots, 3000);
  setInterval(warmLots, 4 * 60 * 1000);
  // Unattended updates. "idle": check GitHub every 10 minutes and install a pending update once the gun has been idle
  // for updates.idleMinutes. "hour": only during updates.autoHour. "manual": never (reports page only).
  if (cfg.updates.repo) {
    const u = cfg.updates;
    const mode = u.auto === 'manual' ? 'manual only (reports page)' : u.auto === 'hour' ? 'automatic at ' + u.autoHour + ':00' : 'automatic within ~10 min of a push, once the gun is idle ' + u.idleMinutes + ' min';
    log('Updates: ' + u.repo + ' (' + (u.branch || 'main') + '), running version ' + (shortSha(currentVersion().sha) || 'unrecorded') + ', ' + mode);
    if (u.auto !== 'manual') setInterval(async () => {
      try {
        if (u.auto === 'hour' && new Date().getHours() !== u.autoHour) return;
        if (Date.now() - Math.max(lastEventAt, Date.parse(STARTED_AT)) < u.idleMinutes * 60 * 1000) return;   // gun busy, or just restarted
        const s = await updateStatus();
        if (s.updateAvailable) { await applyUpdate('automatic'); restartSoon(); }
      } catch (e) { log('Automatic update: ' + e.message); }
    }, 10 * 60 * 1000);
  }
  // Keep the session warm so the first scan of the morning is instant. After a network blip, retry every 2 minutes
  // until Cultivera is reachable again; otherwise check every 30 minutes.
  let warmTimer = null;
  const keepWarm = async () => {
    let delay = 30 * 60 * 1000;
    try { await ensureToken(); }
    catch (e) {
      lastError = { at: new Date().toISOString(), message: e.message };
      log((e.network ? 'Keep-alive: ' : 'Keep-alive login failed: ') + e.message);
      if (e.network) delay = 2 * 60 * 1000;
    }
    warmTimer = setTimeout(keepWarm, delay);
  };
  warmTimer = setTimeout(keepWarm, 30 * 60 * 1000);
});
