'use strict';
/* Branch Ops Tracker: sync server. Node built-ins only (no npm packages).
   Serves public/index.html and a small API protected by ACCESS_KEY.
   Data lives in DATA_DIR (put a Railway volume there):  state.json  +  files/  +  backups/ */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || (process.env.DATABASE_PATH ? path.dirname(process.env.DATABASE_PATH) : './data'));
const ACCESS_KEY = process.env.ACCESS_KEY || '';
const MAX_STATE = 25 * 1024 * 1024, MAX_FILE = 60 * 1024 * 1024;
const FILES = path.join(DATA_DIR, 'files'), BACKUPS = path.join(DATA_DIR, 'backups'), STATE = path.join(DATA_DIR, 'state.json');
for (const d of [DATA_DIR, FILES, BACKUPS]) fs.mkdirSync(d, { recursive: true });

/* ---------- state: { rev, keys: { name: { v, rev } } } ---------- */
let state = { rev: 0, keys: {} };
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { if (fs.existsSync(STATE)) { console.error('state.json is unreadable, refusing to start:', e.message); process.exit(1); } }
let lastBackupDay = '';
function persist() {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== lastBackupDay && fs.existsSync(STATE)) {     // one copy of the previous state per day, last 14 kept
    try {
      fs.copyFileSync(STATE, path.join(BACKUPS, 'state-' + day + '.json')); lastBackupDay = day;
      fs.readdirSync(BACKUPS).filter(f => /^state-/.test(f)).sort().slice(0, -14).forEach(f => fs.unlinkSync(path.join(BACKUPS, f)));
    } catch (e) { console.error('backup failed', e.message); }
  }
  const tmp = STATE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, STATE);
}

/* ---------- helpers ---------- */
const fname = id => Buffer.from(id, 'utf8').toString('base64url');
const unfname = f => Buffer.from(f, 'base64url').toString('utf8');
const fpath = id => path.join(FILES, fname(id));
const KEYRE = /^[A-Za-z0-9_.\-]{1,64}$/;
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const keyOk = k => ACCESS_KEY && crypto.timingSafeEqual(sha(k || ''), sha(ACCESS_KEY));
const fails = new Map();
function ipOf(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function throttled(ip) { const f = fails.get(ip); return f && f.n >= 10 && Date.now() - f.t < 10 * 60 * 1000; }
function failed(ip) { const f = fails.get(ip); if (!f || Date.now() - f.t > 10 * 60 * 1000) fails.set(ip, { n: 1, t: Date.now() }); else { f.n++; f.t = Date.now(); } }
function send(res, code, body, type, extra) {
  const b = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, cors, extra));
  res.end(b);
}
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Access-Key, X-File-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Max-Age': '600' };
function readBody(req, limit) {
  return new Promise((ok, no) => {
    const parts = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { no(Object.assign(new Error('Too large'), { code: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', no);
  });
}

/* ---------- routes ---------- */
async function api(req, res, url) {
  if (url.pathname === '/api/ping') return send(res, 200, { app: 'branch-ops-sync', configured: !!ACCESS_KEY });
  if (!ACCESS_KEY) return send(res, 503, { error: 'The server has no ACCESS_KEY variable set.' });
  const ip = ipOf(req);
  if (throttled(ip)) return send(res, 429, { error: 'Too many wrong keys. Wait 10 minutes.' });
  if (!keyOk(req.headers['x-access-key'])) { failed(ip); return send(res, 401, { error: 'Wrong access key.' }); }
  fails.delete(ip);
  const p = url.pathname, m = req.method;

  if (p === '/api/auth' && m === 'GET') return send(res, 200, { ok: true, rev: state.rev });

  if (p === '/api/state' && m === 'GET') {
    const since = +url.searchParams.get('since') || 0, keys = {};
    for (const k in state.keys) if (state.keys[k].rev > since) keys[k] = state.keys[k];
    return send(res, 200, { rev: state.rev, keys });
  }
  if (p === '/api/state' && m === 'POST') {
    let body; try { body = JSON.parse((await readBody(req, MAX_STATE)).toString('utf8')); } catch (e) { return send(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'Too large' : 'Bad JSON' }); }
    const ch = body && body.changes; if (!ch || typeof ch !== 'object') return send(res, 400, { error: 'No changes' });
    const accepted = {}, conflicts = {};
    for (const k of Object.keys(ch)) {
      if (!KEYRE.test(k) || !ch[k] || !('v' in ch[k])) continue;
      const cur = state.keys[k];
      if (cur && cur.rev > (+ch[k].base || 0)) {
        if (JSON.stringify(cur.v) === JSON.stringify(ch[k].v)) { accepted[k] = cur.rev; continue; }
        conflicts[k] = cur; continue;
      }
      state.rev++; state.keys[k] = { v: ch[k].v, rev: state.rev }; accepted[k] = state.rev;
    }
    if (Object.keys(accepted).length) persist();
    return send(res, 200, { rev: state.rev, accepted, conflicts });
  }

  if (p === '/api/files' && m === 'GET') {
    const out = {};
    for (const f of fs.readdirSync(FILES)) { if (f.endsWith('.t') || f.endsWith('.tmp')) continue; try { const st = fs.statSync(path.join(FILES, f)); out[unfname(f)] = { size: st.size, t: Math.round(st.mtimeMs) }; } catch (e) {} }
    return send(res, 200, { files: out });
  }
  const fm = p.match(/^\/api\/files\/(.+)$/);
  if (fm) {
    let id; try { id = decodeURIComponent(fm[1]); } catch (e) { return send(res, 400, { error: 'Bad id' }); }
    if (!id || id.length > 200) return send(res, 400, { error: 'Bad id' });
    const fp = fpath(id);
    if (m === 'GET') {
      if (!fs.existsSync(fp)) return send(res, 404, { error: 'No such file' });
      let type = 'application/octet-stream'; try { type = fs.readFileSync(fp + '.t', 'utf8') || type; } catch (e) {}
      return send(res, 200, fs.readFileSync(fp), type);
    }
    if (m === 'PUT') {
      let buf; try { buf = await readBody(req, MAX_FILE); } catch (e) { return send(res, 413, { error: 'File too large (60 MB max)' }); }
      fs.writeFileSync(fp + '.tmp', buf); fs.renameSync(fp + '.tmp', fp);
      fs.writeFileSync(fp + '.t', String(req.headers['x-file-type'] || '').replace(/[^\w.+\-\/]/g, '').slice(0, 100));
      return send(res, 200, { ok: true, t: Math.round(fs.statSync(fp).mtimeMs), size: buf.length });
    }
    if (m === 'DELETE') { for (const f of [fp, fp + '.t']) try { fs.unlinkSync(f); } catch (e) {} return send(res, 200, { ok: true }); }
  }
  return send(res, 404, { error: 'Not found' });
}

const PAGE = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find(f => fs.existsSync(f)) || path.join(__dirname, 'index.html');   // works with or without a public folder
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, fs.readFileSync(PAGE), 'text/html; charset=utf-8');
    if (url.pathname === '/favicon.ico') return send(res, 204, '');
    send(res, 404, 'Not found', 'text/plain');
  } catch (e) { console.error(e); try { send(res, 500, { error: 'Server error' }); } catch (_) {} }
});
server.listen(PORT, '0.0.0.0', () => {
  console.log('Branch Ops Tracker server on port ' + PORT + ', data in ' + DATA_DIR);
  if (!ACCESS_KEY) console.log('WARNING: ACCESS_KEY is not set. The API refuses all requests until you add it.');
});
