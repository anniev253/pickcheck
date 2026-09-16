'use strict';
/*
 * Item locations from a spreadsheet (.xlsx or .csv), merged into pick-list lines.
 *
 * Works with a workbook like "Inventory Key.xlsx": one sheet per product family, each with
 * columns such as  Slot | Item Name | Product Type  (header names are configurable). Every sheet
 * is read unless "sheet" names one. A row matches a Cultivera line when the row's item name is the
 * line's strain (or appears in the product name) AND the row's product type appears in the product
 * name, so "GSC" in the Honey Crystal sheet and "GSC" in the Live Resin sheet resolve correctly.
 *
 * config.json:
 *   "locations": {
 *     "file": "C:\\Users\\me\\OneDrive - Oleum Labs\\Inventory Key.xlsx",   // local (synced) path, OR
 *     "url":  "https://...?download=1",                                     // direct-download link
 *     "sheets": ["Honey Crystal", "Live Resin", "Overstock", "Neon"],   // tabs that are mapped; omit = every sheet
 *     "nameColumn": "Item Name",       // strain / item name column
 *     "typeColumn": "Product Type",    // optional
 *     "barcodeColumn": "Barcode",      // optional: full lot barcode (or its last 4+ digits) -> exact per-lot location
 *     "locationColumn": "Slot",
 *     "refreshMinutes": 5
 *   }
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- minimal .xlsx reader (zip + sheet XML)
function readZip(buf) {
  const files = {};
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip/xlsx file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen).replace(/\\/g, '/');
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    files[name] = () => method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? raw : (() => { throw new Error('unsupported zip compression ' + method); })();
    p += 46 + nlen + xlen + clen;
  }
  return files;
}

const decodeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&');
const textOf = xml => decodeXml((xml.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join(''));
const colIndex = ref => { let n = 0; for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

function readXlsx(buf, sheetName) {
  const zip = readZip(buf);
  const get = n => zip[n] ? zip[n]().toString('utf8') : '';
  const shared = (get('xl/sharedStrings.xml').match(/<si>[\s\S]*?<\/si>/g) || []).map(textOf);
  const wb = get('xl/workbook.xml'), rels = get('xl/_rels/workbook.xml.rels');
  let sheets = [...wb.matchAll(/<sheet [^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"/g)].map(m => ({ name: decodeXml(m[1]), rid: m[2] }));
  const wanted = (Array.isArray(sheetName) ? sheetName : (sheetName ? [sheetName] : [])).map(s => String(s).toLowerCase().trim()).filter(Boolean);
  if (wanted.length) sheets = sheets.filter(s => wanted.includes(s.name.toLowerCase().trim()));
  if (!sheets.length) throw new Error(wanted.length ? 'none of the sheets ' + wanted.join(', ') + ' were found in the workbook' : 'workbook has no sheets');
  return sheets.map(sh => {
    const target = (rels.match(new RegExp('<Relationship [^>]*?Id="' + sh.rid + '"[^>]*?Target="([^"]*)"')) || rels.match(new RegExp('<Relationship [^>]*?Target="([^"]*)"[^>]*?Id="' + sh.rid + '"')) || [])[1];
    const xml = get(target ? (target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\/?xl\//, '')) : 'xl/worksheets/sheet1.xml');
    const rows = [];
    for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const cm of rm[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[2] || '', inner = cm[3] || '';
        const t = (attrs.match(/t="([^"]*)"/) || [])[1];
        let v = '';
        if (t === 's') { const i = +(inner.match(/<v>([^<]*)<\/v>/) || [])[1]; v = shared[i] || ''; }
        else if (t === 'inlineStr') v = textOf(inner);
        else v = decodeXml(((inner.match(/<v>([^<]*)<\/v>/) || [])[1] || ''));
        row[colIndex(cm[1])] = v;
      }
      rows.push(Array.from(row, x => x == null ? '' : String(x).trim()));
    }
    return { sheet: sh.name, rows };
  });
}

function readCsv(text) {
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
  return [{ sheet: 'csv', rows: rows.map(r => r.map(x => x.trim())) }];
}

// ---------------------------------------------------------------- tables -> index
const norm = s => String(s || '').toLowerCase().replace(/\*[^*]*\*/g, ' ').replace(/[^a-z0-9.]+/g, ' ').replace(/\s+/g, ' ').trim();
// Abbreviations used on the sheet's Product Type column -> words that appear in Cultivera product names.
const TYPE_ALIASES = { lr: 'live resin', cr: 'cured resin', hc: 'honey crystal', ld: 'liquid diamond', cart: 'cartridge', carts: 'cartridge', vape: 'vape', vapes: 'vape' };
const normType = s => norm(s).split(' ').map(w => TYPE_ALIASES[w] || w).join(' ').trim();

function findCol(header, wanted) {
  if (!wanted) return -1;
  const w = wanted.toLowerCase().trim();
  let i = header.findIndex(h => h.toLowerCase().trim() === w);
  if (i < 0) i = header.findIndex(h => h.toLowerCase().includes(w));
  return i;
}

function buildIndex(tables, cfg) {
  const entries = [], byLast = new Map(), sheetsUsed = [], problems = [];
  for (const { sheet, rows } of tables) {
    const headerRow = rows.findIndex(r => r.some(c => c));
    if (headerRow < 0) continue;
    const header = rows[headerRow];
    const nameI = findCol(header, cfg.nameColumn || 'item name'), typeI = findCol(header, cfg.typeColumn), last4I = findCol(header, cfg.barcodeColumn || cfg.last4Column), locI = findCol(header, cfg.locationColumn || 'slot');
    if (locI < 0 || (nameI < 0 && last4I < 0)) { problems.push(sheet + ': header is "' + header.join(' | ') + '"'); continue; }
    let n = 0;
    for (const r of rows.slice(headerRow + 1)) {
      const loc = (r[locI] || '').trim();
      if (!loc) continue;
      const name = nameI >= 0 ? norm(r[nameI]) : '';
      const type = typeI >= 0 ? normType(r[typeI]) : normType(sheet);   // no type column: the sheet name is the product family
      const last = last4I >= 0 ? String(r[last4I] || '').replace(/\D/g, '') : '';
      if (last.length >= 4) byLast.set(last, loc);
      if (name) entries.push({ name, type, loc, sheet, sheetType: normType(sheet) });
      n++;
    }
    sheetsUsed.push(sheet + ' (' + n + ')');
  }
  if (!entries.length && !byLast.size) throw new Error('no usable rows. ' + (problems.length ? 'Check the column names in config.json. Sheets seen: ' + problems.join('; ') : ''));
  return { entries, byLast, count: entries.length + byLast.size, sheetsUsed, problems };
}

// "Bubba Kush Liquid Diamond 1.0g *DOH" -> "Liquid Diamond": the product line, used as the location when nothing on the sheet matches.
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function productLine(name, strain) {
  let s = String(name || '');
  s = s.replace(/\*[^*]*\*?/g, ' ');                                   // *DOH*, *DOH
  s = s.replace(/\([^)]*\)/g, ' ');                                     // (100mg THC)
  if (strain) s = s.replace(new RegExp('^\\s*' + escapeRe(String(strain).trim()) + '(?=\\s|$)', 'i'), ' ');
  s = s.replace(/\b\d+(\.\d+)?\s*(g|mg|ml|oz|kg|lb)s?\b/gi, ' ');        // 1.0g, 100mg
  s = s.replace(/\b\d+\s*(pack|pk|ct|count|piece|pc|pcs)s?\b/gi, ' ');   // 5 Pack
  s = s.replace(/\b\d+(\.\d+)?\b/g, ' ');                               // stray numbers
  s = s.replace(/[-–—|/,]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

// Follow redirects by hand, carrying cookies between hops. A SharePoint share link sets an anonymous-access cookie on
// its first redirect and expects it on the next request; Node's fetch drops it, which ends in a 403 or a sign-in page.
async function fetchFollowingCookies(url, maxHops = 10) {
  const jar = new Map();
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PickCheckBridge/1.0', Accept: '*/*' };
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    const cookie = [...jar.entries()].map(([k, v]) => k + '=' + v).join('; ');
    const res = await fetch(current, { redirect: 'manual', headers: cookie ? { ...headers, Cookie: cookie } : headers });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) { const m = sc.match(/^([^=;]+)=([^;]*)/); if (m) jar.set(m[1].trim(), m[2]); }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      await res.arrayBuffer().catch(() => {});
      continue;
    }
    return res;
  }
  throw new Error('too many redirects');
}

// ---------------------------------------------------------------- loader with caching
function create(cfg, log) {
  if (!cfg || (!cfg.file && !cfg.url)) return null;
  let index = null, loadedAt = 0, fileMtime = 0, lastError = null;
  const refreshMs = (cfg.refreshMinutes || 5) * 60 * 1000;

  // "file" may be a full path or just the file name; a bare name is searched for in every OneDrive folder of the current user.
  let resolvedFile = null;
  function resolveFile() {
    if (resolvedFile && fs.existsSync(resolvedFile)) return resolvedFile;
    if (fs.existsSync(cfg.file)) return (resolvedFile = cfg.file);
    const base = path.basename(cfg.file).toLowerCase();
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const roots = fs.existsSync(home) ? fs.readdirSync(home).filter(n => /^onedrive/i.test(n)).map(n => path.join(home, n)) : [];
    const walk = (dir, depth) => {
      let found = null;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isFile() && ent.name.toLowerCase() === base) return full;
        if (ent.isDirectory() && depth > 0 && !ent.name.startsWith('.') && (found = walk(full, depth - 1))) return found;
      }
      return null;
    };
    for (const r of roots) { try { const hit = walk(r, 3); if (hit) return (resolvedFile = hit); } catch (e) {} }
    throw new Error('spreadsheet not found: ' + cfg.file + (roots.length ? ' (also searched ' + roots.join(', ') + ')' : '') + '. Is OneDrive synced on this PC?');
  }

  async function load() {
    let buf, label;
    if (cfg.file) {
      const file = resolveFile();
      const st = fs.statSync(file);
      if (index && st.mtimeMs === fileMtime) return;         // unchanged since last read
      buf = fs.readFileSync(file); fileMtime = st.mtimeMs; label = file;
    } else {
      if (index && Date.now() - loadedAt < refreshMs) return;
      // OneDrive/SharePoint "Anyone with the link" share links: add download=1 so the file itself comes back, and send a
      // browser-like User-Agent (SharePoint answers 403 to Node's default one).
      let dl = cfg.url;
      if (/sharepoint\.com|1drv\.ms|onedrive\.live\.com/i.test(dl) && !/[?&]download=1/.test(dl)) dl += (dl.includes('?') ? '&' : '?') + 'download=1';
      const res = await fetchFollowingCookies(dl);
      if (!res.ok) throw new Error('download failed (HTTP ' + res.status + ')' + (res.status === 403 || res.status === 401 ? '. Is the share link set to "Anyone with the link"?' : ''));
      buf = Buffer.from(await res.arrayBuffer()); label = 'download';
      if ((res.headers.get('content-type') || '').includes('text/html')) throw new Error('the link returned a web page, not the file. Use a direct-download link.');
    }
    const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
    const tables = isZip ? readXlsx(buf, cfg.sheets || cfg.sheet) : readCsv(buf.toString('utf8').replace(/^\uFEFF/, ''));
    index = buildIndex(tables, cfg);
    loadedAt = Date.now(); lastError = null;
    log('Locations loaded from ' + label + ': ' + index.sheetsUsed.join(', ') + (index.problems.length ? ' — skipped ' + index.problems.join('; ') : ''));
  }

  async function ensure() {
    try { await load(); }
    catch (e) { lastError = e.message; log('Locations: ' + e.message); }
  }

  // Product families that have no fixed slot: they only get a location when the Overstock tab lists them.
  const overstockSheet = norm(cfg.overstockSheet || 'overstock');
  const overstockOnly = (cfg.overstockOnlyTypes || ['sugar cone', 'liquid diamond', 'live resin cartridge', 'live resin stick', 'cured resin stick', 'cured diamond', 'momo']).map(norm);

  // Location for a pick-list line, in order of confidence:
  //   1. the lot's barcode is on the sheet (full barcode, or a sheet entry that is the barcode's ending)
  //   2. item name + product type match a slot (and/or an Overstock row)
  //   3. nothing matched: the product line itself ("Liquid Diamond", "Live Resin Cartridge") so the picker knows the section
  function lookup(line) {
    if (!index) return null;
    const lots = {};
    for (const a of line.allocs || []) {
      for (const bc of a.barcodes) {
        const d = String(bc || '').replace(/\D/g, '');
        if (!d) continue;
        let hit = index.byLast.get(d);
        for (let n = Math.min(8, d.length); !hit && n >= 4; n--) hit = index.byLast.get(d.slice(-n));
        if (hit) { lots[a.barcodes[0]] = hit; break; }
      }
    }
    const pname = ' ' + norm(line.name) + ' ', strain = norm(line.strain), ltype = norm(line.type);
    const restricted = !!line.sample || overstockOnly.some(t => pname.includes(' ' + t + ' '));
    let slot = null, slotScore = 0, over = null, overScore = 0;
    const wordsIn = t => !t || t.split(' ').every(w => pname.includes(' ' + w + ' '));
    for (const e of index.entries) {
      // exact strain, the strain phrase inside the product name, or a truncated sheet name ("bubblegum gelat") that starts the strain
      const nameHit = (strain && e.name === strain) || pname.includes(' ' + e.name + ' ') || (e.name.length >= 6 && (strain.startsWith(e.name) || pname.includes(' ' + e.name)));
      if (!nameHit) continue;
      // every word of the sheet's product type (or of the tab name) must appear in the product name, or match Cultivera's type field
      const typeHit = wordsIn(e.type) || wordsIn(e.sheetType) || (ltype && ltype.includes(e.type));
      if (!typeHit) continue;
      const score = e.name.length * 2 + e.type.length + (strain === e.name ? 5 : 0);
      if (norm(e.sheet) === overstockSheet) { if (score > overScore) { over = e; overScore = score; } }
      else if (!restricted && score > slotScore) { slot = e; slotScore = score; }
    }
    const parts = [slot && slot.loc, over && over.loc].filter(Boolean);
    const lotLocs = [...new Set(Object.values(lots))];
    if (lotLocs.length) return { line: lotLocs.join(' · '), lots, source: 'barcode', restricted };
    if (parts.length) return { line: parts.join(' · '), lots, source: 'sheet', restricted };
    const fallback = productLine(line.name, line.strain);
    return { line: fallback || null, lots, source: fallback ? 'productLine' : 'none', restricted };
  }

  function status() { return { source: cfg.file || cfg.url, rows: index ? index.count : 0, sheets: index ? index.sheetsUsed : null, loadedAt: loadedAt ? new Date(loadedAt).toISOString() : null, lastError }; }

  return { ensure, lookup, status };
}

module.exports = { create, readXlsx, readCsv, readZip, norm, productLine, fetchFollowingCookies };
