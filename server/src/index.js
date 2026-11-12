// Terpedex shared database: a Cloudflare Worker in front of a D1 (SQLite) database.
//
//   GET  /strains  -> every strain users have reported, with who/where/label-THC summaries
//   POST /report   -> { name, device, lane, thc, type?, terp?, feel? } one device saying "I have this strain",
//                     optionally with what its label says about type and top terpene
//
//   POST /research -> { name, device } reference notes for a strain, written once by a
//                     Workers AI model and then cached for everyone
//
// Nothing here is trusted as fact: an entry only says what users reported, and how many did.
// Every query uses bound parameters, and every value written is checked against a fixed list
// or a strict pattern first.

const LANES = ['FLOWER', 'CONCENTRATES', 'TOPICALS', 'EDIBLES'];
const TYPES = ['Indica', 'Sativa', 'Hybrid'];
const FEELS = ['Energizing', 'Balanced', 'Relaxing', 'Couch-lock', 'Sleepy'];
const TERPS = ['Myrcene', 'Limonene', 'Caryophyllene', 'Pinene', 'Linalool', 'Terpinolene', 'Humulene', 'Ocimene'];
const EFFECTS = ['Sleepy', 'Heavy', 'Relaxed', 'Calm', 'Mellow', 'Hungry', 'Energetic', 'Uplifted', 'Focused', 'Clear', 'Creative', 'Talkative', 'Euphoric', 'Happy', 'Giggly'];
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
// Research draws on the account's shared daily Workers AI allowance, so keep it to a small slice.
const MAX_RESEARCH_PER_DAY = 50;
const DAY = 24 * 60 * 60 * 1000;

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
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      ...cors(origin),
    },
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
  // Label answers are tallied as votes; the app decides what counts as agreement.
  const votes = (col) => env.DB.prepare(
    `SELECT r.key, r.${col} AS v, COUNT(*) AS n FROM reports r ${where ? where + ' AND' : 'WHERE'} r.${col} IS NOT NULL GROUP BY r.key, r.${col}`,
  ).bind(...bind).all();
  const [types, terps, feels] = await Promise.all([votes('type'), votes('terp'), votes('feel')]);
  const byKey = new Map();
  for (const s of strains.results) {
    byKey.set(s.key, { key: s.key, name: s.name, users: s.users, states: (s.states || '').split(',').filter(Boolean).sort(), thc: {}, types: {}, terps: {}, feels: {} });
  }
  for (const l of lanes.results) {
    const s = byKey.get(l.key);
    if (s) s.thc[l.lane] = { n: l.n, lo: l.lo, hi: l.hi };
  }
  for (const t of types.results) { const s = byKey.get(t.key); if (s) s.types[t.v] = t.n; }
  for (const t of terps.results) { const s = byKey.get(t.key); if (s) s.terps[t.v] = t.n; }
  for (const t of feels.results) { const s = byKey.get(t.key); if (s) s.feels[t.v] = t.n; }
  const notes = await env.DB.prepare(`SELECT r.key, r.data FROM notes r ${where ? where + ' AND' : 'WHERE'} r.known = 1`).bind(...bind).all();
  for (const n of notes.results) { const s = byKey.get(n.key); if (s) s.note = JSON.parse(n.data); }
  return [...byKey.values()];
}

const SYSTEM = `You are a careful cannabis strain reference. You answer only with what established strain references and breeders widely and consistently report about a named strain.
Rules:
- Ignore phenotype or cut numbers such as "#4" when identifying the strain.
- If you do not recognise the name as an established, documented strain, or you are not confident, set "known" to false and every other field to null. Never guess, and never invent parents.
- Give lineage only when the parents are well established; otherwise null.
- No medical claims. Describe commonly reported character only.
- Reply with a single JSON object and nothing else.`;

const askFor = (name) => `Strain name: "${name}"

Return a JSON object with exactly these keys:
"known": true or false
"type": "Indica", "Sativa" or "Hybrid"
"leaning": a short phrase such as "indica-dominant hybrid, about 70/30", or null
"lineage": the parents, such as "Zkittlez x Gelato", or null
"effects": up to 4 of ${EFFECTS.join(', ')}
"overall": how it is usually described overall, one of ${FEELS.join(', ')}
"flavors": up to 3 single words
"summary": at most two plain sentences on what it is known for`;

const text = (v, max) => (typeof v === 'string' ? v.replace(/[<>\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '') || null;

// Keep only the fields and values we asked for; the model's output is untrusted.
function cleanNote(raw) {
  if (!raw || raw.known !== true) return null;
  const list = (v, max) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string').slice(0, max);
  const note = {
    type: TYPES.includes(raw.type) ? raw.type : null,
    leaning: text(raw.leaning, 60),
    lineage: text(raw.lineage, 90),
    effects: list(raw.effects, 4).filter((e) => EFFECTS.includes(e)),
    overall: FEELS.includes(raw.overall) ? raw.overall : null,
    flavors: list(raw.flavors, 3).map((f) => text(f, 16)).filter((f) => f && /^[A-Za-z][A-Za-z -]*$/.test(f)),
    summary: text(raw.summary, 320),
  };
  // "Known" with nothing to say is no use to anyone.
  return note.type || note.summary ? note : null;
}

// ---------- rate limits ----------
// Device ids are made by the app, so anyone can invent new ones; the limits that matter
// are per network address and app-wide. Addresses are never stored: each becomes a salted
// hash that changes every day, kept only as a counter key until the next day's cleanup.
const LIMITS = {
  burst: 40,              // requests per address per minute
  report: [300, 60],      // reports per day: per address, per device
  newStrain: [30, 15],    // brand-new strain names per day: per address, per device
  newStrainAll: 400,      // brand-new strain names per day across everyone
  research: [20, 15],     // AI lookups per day: per address, per device
};

// The salt is random, made by the server on first use and kept only in its database,
// so the hashes cannot be turned back into addresses.
let saltCache = null;
async function salt(env) {
  if (saltCache) return saltCache;
  const fresh = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare("INSERT OR IGNORE INTO config (k, v) VALUES ('ip_salt', ?1)").bind(fresh).run();
  const row = await env.DB.prepare("SELECT v FROM config WHERE k = 'ip_salt'").first();
  saltCache = row.v;
  return saltCache;
}

async function addressKey(req, env) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const day = Math.floor(Date.now() / DAY);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${await salt(env)}|${day}|${ip}`));
  return [...new Uint8Array(bytes)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Take one slot from a counter, atomically: a single statement both checks and counts,
// so a burst of parallel requests cannot slip past the limit.
async function take(env, bucket, max, windowMs = DAY) {
  const win = Math.floor(Date.now() / windowMs);
  const row = await env.DB.prepare(
    `INSERT INTO limits (bucket, win, n) VALUES (?1, ?2, 1)
     ON CONFLICT (bucket, win) DO UPDATE SET n = n + 1 WHERE n < ?3
     RETURNING n`,
  ).bind(bucket, win, max).first();
  return !!row;
}

async function takeAll(env, list, message) {
  for (const [bucket, max, windowMs] of list) {
    if (!(await take(env, bucket, max, windowMs))) throw new HttpError(429, message);
  }
}

// Read a small JSON body. Anything big is refused before parsing.
async function readBody(req) {
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > 2048) throw new HttpError(413, 'Request too large.');
  const raw = await req.text();
  if (raw.length > 2048) throw new HttpError(413, 'Request too large.');
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Body must be JSON.'); }
}

async function research(req, env, addr) {
  const body = await readBody(req);
  const name = String(body.name || '').replace(/\s+/g, ' ').trim();
  const key = norm(name);
  if (name.length < 3 || name.length > 40 || !/^[A-Za-z0-9#'&.\- ]+$/.test(name) || !/[A-Z]{3}/.test(key)) {
    throw new HttpError(400, 'That does not look like a strain name.');
  }
  const device = String(body.device || '');
  if (!/^[a-f0-9-]{36}$/.test(device)) throw new HttpError(400, 'Bad device id.');

  const cached = await env.DB.prepare('SELECT data FROM notes WHERE key = ?1').bind(key).first();
  if (cached) return { note: JSON.parse(cached.data), cached: true };

  if (!env.AI) throw new HttpError(503, 'Research is not set up.');
  const now = Date.now();
  // The app-wide cap goes last, so a request refused for its own limits does not use it up.
  await takeAll(env, [
    [`a:${addr}:research`, LIMITS.research[0]],
    [`d:${device}:research`, LIMITS.research[1]],
    ['all:research', MAX_RESEARCH_PER_DAY],
  ], 'Research limit reached for today.');

  let note = null, tokensIn = 0, tokensOut = 0;
  try {
    const out = await env.AI.run(MODEL, {
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: askFor(name) }],
      max_tokens: 400,
      temperature: 0.1,
    });
    tokensIn = out.usage?.prompt_tokens || 0;
    tokensOut = out.usage?.completion_tokens || 0;
    const reply = typeof out.response === 'string' ? out.response : JSON.stringify(out.response ?? '');
    const start = reply.indexOf('{'), end = reply.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('no JSON in reply');
    note = cleanNote(JSON.parse(reply.slice(start, end + 1)));
  } catch (e) {
    console.error('research failed', e);
    throw new HttpError(503, 'Research is unavailable right now.');
  }

  // "Not recognised" is cached too, so the same unknown name is not asked about twice.
  await env.DB.prepare(
    'INSERT OR IGNORE INTO notes (key, name, known, data, model, tokens_in, tokens_out, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)',
  ).bind(key, name, note ? 1 : 0, JSON.stringify(note), MODEL, tokensIn, tokensOut, device, now).run();
  return { note, cached: false };
}

async function report(req, env, addr) {
  const body = await readBody(req);

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
  const type = TYPES.includes(body.type) ? body.type : null;
  const terp = TERPS.includes(body.terp) ? body.terp : null;
  const feel = FEELS.includes(body.feel) ? body.feel : null;

  // Region comes from Cloudflare's edge, not from the client. The address itself is never stored.
  const cf = req.cf || {};
  const state = cf.country === 'US' && /^[A-Z]{2}$/.test(cf.regionCode || '') ? cf.regionCode : (cf.country || '??');

  const now = Date.now();
  await takeAll(env, [
    [`a:${addr}:report`, LIMITS.report[0]],
    [`d:${device}:report`, LIMITS.report[1]],
  ], 'Daily limit reached. Try again tomorrow.');

  const exists = await env.DB.prepare('SELECT 1 AS x FROM strains WHERE key = ?1').bind(key).first();
  if (!exists) {
    await takeAll(env, [
      [`a:${addr}:new`, LIMITS.newStrain[0]],
      [`d:${device}:new`, LIMITS.newStrain[1]],
      ['all:new', LIMITS.newStrainAll],
    ], 'Daily limit for new strains reached.');
  }

  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO strains (key, name, created_by, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(key, name, device, now),
    env.DB.prepare(
      `INSERT INTO reports (key, device, state, lane, thc, type, terp, feel, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
       ON CONFLICT (key, device) DO UPDATE SET
         state = excluded.state, lane = excluded.lane, thc = COALESCE(excluded.thc, reports.thc),
         type = COALESCE(excluded.type, reports.type), terp = COALESCE(excluded.terp, reports.terp),
         feel = COALESCE(excluded.feel, reports.feel), updated_at = excluded.updated_at`,
    ).bind(key, device, state, lane, thc, type, terp, feel, now),
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
      // Writes: browsers always send Origin on cross-site POSTs, so pages we don't know are
      // refused. A script can fake Origin, which is why the address limits below exist.
      let addr = null;
      if (req.method === 'POST') {
        if (!allowed) throw new HttpError(403, 'Origin not allowed.');
        addr = await addressKey(req, env);
        await takeAll(env, [[`a:${addr}:burst`, LIMITS.burst, 60 * 1000]], 'Too many requests. Slow down.');
        // Now and then, clear counters from before yesterday.
        if (Math.random() < 0.02) {
          await env.DB.prepare('DELETE FROM limits WHERE win < ?1 AND win > 1000000').bind(Math.floor(Date.now() / 60000) - 2 * 1440).run();
          await env.DB.prepare('DELETE FROM limits WHERE win < ?1').bind(Math.floor(Date.now() / DAY) - 1).run();
        }
      }
      if (req.method === 'GET' && url.pathname === '/strains') return json({ strains: await summaries(env) }, 200, allowed);
      if (req.method === 'POST' && url.pathname === '/report') return json(await report(req, env, addr), 200, allowed);
      if (req.method === 'POST' && url.pathname === '/research') return json(await research(req, env, addr), 200, allowed);
      if (url.pathname === '/') return json({ service: 'terpedex-api', ok: true }, 200, allowed);
      throw new HttpError(404, 'Not found.');
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, allowed);
      console.error(e);
      return json({ error: 'Server error.' }, 500, allowed);
    }
  },
};
