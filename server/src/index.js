// Terpedex shared database: a Cloudflare Worker in front of a D1 (SQLite) database.
//
//   GET  /strains  -> every strain users have reported, with who/where/label-THC summaries
//   POST /report   -> { name, device, lane, thc } one device saying "I have this strain"
//
// Nothing here is trusted as fact: an entry only says what users reported, and how many did.

const LANES = ['FLOWER', 'CONCENTRATES', 'TOPICALS', 'EDIBLES'];
const DAY = 24 * 60 * 60 * 1000;
const MAX_REPORTS_PER_DAY = 60;
const MAX_NEW_STRAINS_PER_DAY = 15;

const norm = (s) => s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) },
  });
}

// Summaries for every strain, or for one when `key` is given.
async function summaries(env, key) {
  const where = key ? 'WHERE r.key = ?1' : '';
  const bind = key ? [key] : [];
  const strains = await env.DB.prepare(
    `SELECT s.key, s.name, COUNT(DISTINCT r.device) AS users, GROUP_CONCAT(DISTINCT r.state) AS states
       FROM strains s JOIN reports r ON r.key = s.key ${where}
      GROUP BY s.key ORDER BY users DESC LIMIT 5000`,
  ).bind(...bind).all();
  const lanes = await env.DB.prepare(
    `SELECT r.key, r.lane, COUNT(*) AS n, MIN(r.thc) AS lo, MAX(r.thc) AS hi
       FROM reports r ${where ? where + ' AND' : 'WHERE'} r.thc IS NOT NULL
      GROUP BY r.key, r.lane`,
  ).bind(...bind).all();
  const byKey = new Map();
  for (const s of strains.results) {
    byKey.set(s.key, { key: s.key, name: s.name, users: s.users, states: (s.states || '').split(',').filter(Boolean).sort(), thc: {} });
  }
  for (const l of lanes.results) {
    const s = byKey.get(l.key);
    if (s) s.thc[l.lane] = { n: l.n, lo: l.lo, hi: l.hi };
  }
  return [...byKey.values()];
}

async function report(req, env) {
  let body;
  try { body = await req.json(); } catch { throw new HttpError(400, 'Body must be JSON.'); }

  const name = String(body.name || '').replace(/\s+/g, ' ').trim();
  const key = norm(name);
  if (name.length < 3 || name.length > 40 || !/^[A-Za-z0-9#'&.\- ]+$/.test(name) || !/[A-Z]{3}/.test(key)) {
    throw new HttpError(400, 'That does not look like a strain name.');
  }
  const device = String(body.device || '');
  if (!/^[a-f0-9-]{36}$/.test(device)) throw new HttpError(400, 'Bad device id.');
  const lane = LANES.includes(body.lane) ? body.lane : 'FLOWER';
  let thc = body.thc == null ? null : Number(body.thc);
  if (thc != null && !(thc > 0 && thc <= 100)) thc = null;

  // Region comes from Cloudflare's edge, not from the client. The IP itself is never stored.
  const cf = req.cf || {};
  const state = cf.country === 'US' && /^[A-Z]{2}$/.test(cf.regionCode || '') ? cf.regionCode : (cf.country || '??');

  const now = Date.now();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE device = ?1 AND updated_at > ?2')
    .bind(device, now - DAY).first();
  if (recent.n >= MAX_REPORTS_PER_DAY) throw new HttpError(429, 'Daily limit reached. Try again tomorrow.');

  const exists = await env.DB.prepare('SELECT 1 AS x FROM strains WHERE key = ?1').bind(key).first();
  if (!exists) {
    const made = await env.DB.prepare('SELECT COUNT(*) AS n FROM strains WHERE created_by = ?1 AND created_at > ?2')
      .bind(device, now - DAY).first();
    if (made.n >= MAX_NEW_STRAINS_PER_DAY) throw new HttpError(429, 'Daily limit for new strains reached.');
  }

  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO strains (key, name, created_by, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(key, name, device, now),
    env.DB.prepare(
      `INSERT INTO reports (key, device, state, lane, thc, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT (key, device) DO UPDATE SET
         state = excluded.state, lane = excluded.lane, thc = COALESCE(excluded.thc, reports.thc), updated_at = excluded.updated_at`,
    ).bind(key, device, state, lane, thc, now),
  ]);

  return { ok: true, strain: (await summaries(env, key))[0] };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').includes(origin) ? origin : '';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(allowed) });
    try {
      if (req.method === 'GET' && url.pathname === '/strains') return json({ strains: await summaries(env) }, 200, allowed);
      if (req.method === 'POST' && url.pathname === '/report') {
        // Browsers always send Origin on cross-site POSTs; refuse pages we don't know.
        if (!allowed) throw new HttpError(403, 'Origin not allowed.');
        return json(await report(req, env), 200, allowed);
      }
      if (url.pathname === '/') return json({ service: 'terpedex-api', ok: true }, 200, allowed);
      throw new HttpError(404, 'Not found.');
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, allowed);
      console.error(e);
      return json({ error: 'Server error.' }, 500, allowed);
    }
  },
};
