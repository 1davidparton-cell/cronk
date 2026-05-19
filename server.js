#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const STATIC_DIR = __dirname;
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------- CONFIG ----------
const PORT = process.env.PORT || 8787;
const SHARED_SECRET = process.env.CRONK_SECRET || '';
const CONFIG_PATH = path.join(__dirname, 'cronk.config.json');
const HISTORY_PATH = path.join(__dirname, 'cronk-history.json');
const MAX_HISTORY = 100;
const RATE_LIMIT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRY_DELAYS = [15_000, 30_000];

function resolveHome(p) {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw);
    for (const v of Object.values(cfg)) {
      if (v.home) v.home = resolveHome(v.home);
    }
    return cfg;
  } catch {
    return {
      acct1: {
        label: 'Account 1',
        home: path.join(os.homedir(), '.cronk', 'acct1'),
        prompt: 'ping',
        schedule: ['05:00'],
        days: null
      },
      acct2: {
        label: 'Account 2',
        home: path.join(os.homedir(), '.cronk', 'acct2'),
        prompt: 'ping',
        schedule: ['05:00'],
        days: null
      }
    };
  }
}

const ACCOUNTS = loadConfig();

// ---------- fire history ----------
let history = [];
try {
  history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
  if (!Array.isArray(history)) history = [];
} catch { history = []; }

function saveHistory() {
  if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
  try { fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2)); } catch {}
}

function recordFire(slug, result, source) {
  history.push({
    slug,
    ts: new Date().toISOString(),
    ok: result.ok,
    exit: result.code,
    ms: result.ms || 0,
    error: result.error || null,
    source
  });
  saveHistory();
}

function lastFireFor(slug) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].slug === slug) return history[i];
  }
  return null;
}

// ---------- rate limiting ----------
const lastFireTime = new Map();

function isRateLimited(slug) {
  const last = lastFireTime.get(slug);
  if (!last) return false;
  return (Date.now() - last) < RATE_LIMIT_MS;
}

function rateLimitRemaining(slug) {
  const last = lastFireTime.get(slug);
  if (!last) return 0;
  return Math.max(0, Math.ceil((RATE_LIMIT_MS - (Date.now() - last)) / 1000));
}

function markFired(slug) {
  lastFireTime.set(slug, Date.now());
}

// ---------- auth ----------
function authOk(req) {
  if (!SHARED_SECRET) return true;
  const h = req.headers['authorization'] || '';
  return h === `Bearer ${SHARED_SECRET}`;
}

function json(res, code, body) {
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'POST, GET, OPTIONS'
  });
  res.end(JSON.stringify(body, null, 2));
}

// ---------- in-flight tracking ----------
const inFlight = new Set();

function fireClaude(account) {
  const p = new Promise((resolve) => {
    const args = ['-p', account.prompt];
    const env = { ...process.env, HOME: account.home, USERPROFILE: account.home };
    const child = spawn('claude', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true
    });
    let out = '', err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, code: -1, error: 'timeout', out, err });
    }, 90_000);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, error: e.message, out, err });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, out: out.slice(0, 400), err: err.slice(0, 400) });
    });
  });
  inFlight.add(p);
  p.finally(() => inFlight.delete(p));
  return p;
}

// ---------- retry logic for scheduled fires ----------
async function fireWithRetry(account, slug, source) {
  let result = await fireClaude(account);
  if (result.ok) return result;

  for (let i = 0; i < MAX_RETRIES; i++) {
    console.log(`[${new Date().toISOString()}] ${source} ${slug} retry ${i + 1}/${MAX_RETRIES} in ${RETRY_DELAYS[i]}ms`);
    await new Promise(r => setTimeout(r, RETRY_DELAYS[i]));
    result = await fireClaude(account);
    if (result.ok) break;
  }
  return result;
}

// ---------- scheduler ----------
const SCHEDULES_LAST = new Map();

function minuteKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

function hhmm(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function checkSchedules() {
  const now = new Date();
  const current = hhmm(now);
  const dow = now.getDay();
  const key = minuteKey(now);

  for (const [slug, acct] of Object.entries(ACCOUNTS)) {
    if (!Array.isArray(acct.schedule) || acct.schedule.length === 0) continue;
    if (!acct.schedule.includes(current)) continue;
    if (Array.isArray(acct.days) && !acct.days.includes(dow)) continue;
    if (SCHEDULES_LAST.get(slug) === key) continue;

    SCHEDULES_LAST.set(slug, key);
    console.log(`[${new Date().toISOString()}] schedule -> firing ${slug} (${current})`);
    fireWithRetry(acct, slug, 'scheduled').then((result) => {
      const status = result.ok ? 'OK' : 'FAIL';
      markFired(slug);
      result.ms = result.ms || 0;
      recordFire(slug, result, 'scheduled');
      console.log(`[${new Date().toISOString()}] scheduled ${slug} -> ${status} (exit ${result.code})`);
    });
  }
}

function nextRunFor(acct, fromDate = new Date()) {
  if (!Array.isArray(acct.schedule) || acct.schedule.length === 0) return null;
  for (let offset = 0; offset < 8; offset++) {
    const candidate = new Date(fromDate);
    candidate.setDate(candidate.getDate() + offset);
    const dow = candidate.getDay();
    if (Array.isArray(acct.days) && !acct.days.includes(dow)) continue;
    const times = [...acct.schedule].sort();
    for (const t of times) {
      const [H, M] = t.split(':').map(Number);
      const fireAt = new Date(candidate);
      fireAt.setHours(H, M, 0, 0);
      if (fireAt > fromDate) return fireAt;
    }
  }
  return null;
}

const scheduleInterval = setInterval(checkSchedules, 15_000);
setTimeout(checkSchedules, 1_000);

// ---------- graceful shutdown ----------
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${new Date().toISOString()}] ${signal} received, shutting down...`);
  clearInterval(scheduleInterval);
  server.close();
  if (inFlight.size > 0) {
    console.log(`  Waiting for ${inFlight.size} in-flight fire(s)...`);
    await Promise.allSettled([...inFlight]);
  }
  saveHistory();
  console.log('  Bye.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ---------- http ----------
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});

  if (req.method === 'GET' && req.url === '/api/status') {
    const view = Object.fromEntries(Object.entries(ACCOUNTS).map(([slug, a]) => {
      const next = nextRunFor(a);
      const last = lastFireFor(slug);
      return [slug, {
        label: a.label,
        schedule: a.schedule || [],
        days: a.days || 'every day',
        next_auto_fire: next ? next.toISOString() : null,
        last_fire: last
      }];
    }));
    return json(res, 200, {
      ok: true,
      service: 'cronk',
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      accounts: view
    });
  }

  if (req.method === 'GET' && req.url === '/api/history') {
    return json(res, 200, { ok: true, history: history.slice(-50).reverse() });
  }

  const m = req.url && req.url.match(/^\/fire\/([a-z0-9_-]+)\/?$/i);
  if (m && (req.method === 'POST' || req.method === 'GET')) {
    if (!authOk(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    const slug = m[1];
    const acct = ACCOUNTS[slug];
    if (!acct) return json(res, 404, { ok: false, error: 'unknown account', slug });

    if (isRateLimited(slug)) {
      return json(res, 429, {
        ok: false,
        error: 'rate limited',
        retry_after: rateLimitRemaining(slug),
        slug
      });
    }

    markFired(slug);
    const t0 = Date.now();
    const result = await fireClaude(acct);
    result.ms = Date.now() - t0;
    recordFire(slug, result, 'manual');
    const code = result.ok ? 200 : 500;
    console.log(`[${new Date().toISOString()}] manual ${slug} -> ${result.ok ? 'OK' : 'FAIL'} (${result.ms}ms, exit ${result.code})`);
    return json(res, code, { ok: result.ok, slug, ms: result.ms, exit: result.code, error: result.error });
  }

  // static file serving
  const urlPath = (req.url === '/' ? '/index.html' : req.url.split('?')[0]);
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const abs = path.join(STATIC_DIR, safe);
  if (!abs.startsWith(STATIC_DIR)) return json(res, 403, { ok: false, error: 'forbidden' });

  fs.readFile(abs, (err, data) => {
    if (err) return json(res, 404, { ok: false, error: 'not found' });
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Cronk server listening on :${PORT}`);
  console.log(`Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  console.log(`Auth: ${SHARED_SECRET ? 'enabled' : 'disabled (set CRONK_SECRET to enable)'}`);
  console.log(`Config: ${fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : 'defaults (no cronk.config.json found)'}`);
  console.log(`History: ${history.length} entries`);
  for (const [slug, a] of Object.entries(ACCOUNTS)) {
    const next = nextRunFor(a);
    console.log(`  - ${slug}: schedule=[${(a.schedule || []).join(',')}]  next=${next ? next.toLocaleString() : 'none'}`);
  }
});
