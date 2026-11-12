/* Terpedex prototype: retro strain index. No build step, no backend. */

const $ = (s) => document.querySelector(s);
const lcd = $('#lcd');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem('cdx_' + k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cdx_' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const TYPES = ['FLOWER', 'CONCENTRATES', 'TOPICALS', 'EDIBLES'];
const LEVELS = ['ROOKIE', 'REGULAR', 'VETERAN'];

const S = {
  screen: 'boot',
  cursor: 0,
  ageOk: store.get('age', false),
  profile: store.get('profile', null),
  log: store.get('log', {}),
  voice: store.get('voice', true),
  entry: null, isNew: false, back: 'home', backCursor: 0,
  tmpType: null, q: '', ocr: '', err: '', status: '', lastRead: '', thcSeen: null,
  cands: {}, dexAll: false,
};

/* ---------- sound + voice ---------- */
let actx;
function beep(freq = 880, ms = 45) {
  if (!S.voice) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'square'; o.frequency.value = freq; g.gain.value = 0.04;
    o.connect(g); g.connect(actx.destination);
    o.start(); o.stop(actx.currentTime + ms / 1000);
  } catch { /* no audio */ }
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  $('#led').classList.remove('on');
  if (!S.voice || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
  u.voice = voices.find((v) => /david|daniel|mark|male/i.test(v.name)) || voices[0] || null;
  u.rate = 1.02; u.pitch = 0.65;
  u.onstart = () => $('#led').classList.add('on');
  u.onend = u.onerror = () => $('#led').classList.remove('on');
  speechSynthesis.speak(u);
}

/* ---------- dex logic ---------- */
const loggedCount = () => Object.keys(S.log).length;
const dexList = () => (S.dexAll ? STRAINS : STRAINS.filter((s) => S.log[s.id]));

// Every strain by each of its names, for exact lookups.
const byKey = new Map();
for (const s of STRAINS) for (const k of s.keys) byKey.set(k, s);

// Strains measured in public lab tests (labdata.js). A lab row that matches a
// hand-written entry adds its numbers to that entry; the rest become entries of their own.
if (typeof LAB !== 'undefined') {
  for (const [name, n, lo, med, hi, terp, top, type, states] of LAB) {
    const key = normName(name);
    const lab = { n, med, terp, states: states.replace(/,/g, ', ') };
    const known = byKey.get(key);
    if (known) { known.lab = lab; continue; }
    const s = {
      id: `L:${key}`, name, type: type || 'Lab-tested', fromLab: true, strict: true, lab,
      thc: [lo, hi], terpenes: top,
      blurb: `Measured in ${n} public lab tests of flower. No lineage or effect notes on file yet.`,
      keys: [key],
    };
    STRAINS.push(s);
    byKey.set(key, s);
  }
}

// Strains other Terpedex users have reported, from the shared database. These are
// reports, not verified facts, so every entry says how many people logged it and where.
const API = location.hostname === 'localhost' ? 'http://localhost:8799' : 'https://terpedex-api.rekigo.workers.dev';
const communityBlurb = (c) => `Reported by ${c.users} Terpedex ${c.users === 1 ? 'user' : 'users'}${c.states ? ` in ${c.states}` : ''}. ` +
  (c.users < 2 ? 'Unconfirmed: only one person has logged it so far.' : 'Community entry, not lab verified.');
function applyCommunity(list) {
  for (const c of list) {
    const info = { users: c.users, states: c.states.join(', '), thc: c.thc || {} };
    const known = byKey.get(c.key);
    if (known) {
      known.community = info;
      if (known.shared) known.blurb = communityBlurb(info);
      continue;
    }
    const s = {
      id: `U:${c.key}`, no: String(STRAINS.length + 1).padStart(4, '0'), name: c.name, type: 'Community',
      shared: true, strict: true, community: info, blurb: communityBlurb(info), keys: [c.key],
    };
    STRAINS.push(s);
    byKey.set(c.key, s);
  }
}
applyCommunity(store.get('community', []));
STRAINS.forEach((s, i) => { s.no = String(i + 1).padStart(4, '0'); });

function deviceId() {
  let id = store.get('device', null);
  if (!id) { id = crypto.randomUUID(); store.set('device', id); }
  return id;
}

async function syncCommunity() {
  if (!API) return;
  try {
    const r = await fetch(`${API}/strains`);
    if (!r.ok) return;
    const { strains } = await r.json();
    store.set('community', strains);
    applyCommunity(strains);
    if (S.screen === 'home' || S.screen === 'dex') render();
  } catch { /* offline: keep the cached copy */ }
}

// Tell the shared database this device has this strain. Sends the strain name, the
// user's lane, the label THC and a random device id; nothing that identifies a person.
async function reportStrain(s, thc) {
  if (!API || !S.profile) return;
  try {
    const r = await fetch(`${API}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: s.name, device: deviceId(), lane: S.profile.type, thc: thc ?? null }),
    });
    if (!r.ok) return;
    const { strain } = await r.json();
    if (!strain) return;
    applyCommunity([strain]);
    store.set('community', [...store.get('community', []).filter((c) => c.key !== strain.key), strain]);
    if (S.screen === 'entry' && S.entry === s) render();
  } catch { /* offline: the strain is still logged on this device */ }
}

// Strains the user registers themselves when a label isn't in the reference index.
const customNames = store.get('custom', []);
function pushCustom(name, i) {
  const id = `c${i + 1}`, key = normName(name);
  const known = byKey.get(key);
  if (known) {
    // The index has since gained this strain: move the user's log onto the real entry.
    if (S.log[id]) { S.log[known.id] = S.log[known.id] || S.log[id]; delete S.log[id]; store.set('log', S.log); }
    return known;
  }
  const s = {
    id, no: String(STRAINS.length + 1).padStart(4, '0'),
    name, type: 'Unlisted', custom: true,
    blurb: 'Registered from your own label. No reference data on file for this one yet.',
    keys: [key],
  };
  STRAINS.push(s);
  byKey.set(key, s);
  return s;
}
customNames.forEach(pushCustom);

function addCustom(raw) {
  const existing = byKey.get(normName(raw));
  if (existing) return existing;
  const name = raw.trim().replace(/\s+/g, ' ').slice(0, 40).toLowerCase().replace(/(^|[\s-])\S/g, (c) => c.toUpperCase());
  customNames.push(name);
  store.set('custom', customNames);
  return pushCustom(name, customNames.length - 1);
}

function logStrain(id, thc) {
  const prev = S.log[id];
  S.log[id] = { first: prev?.first || Date.now(), n: (prev?.n || 0) + 1, thc: thc ?? prev?.thc ?? null };
  store.set('log', S.log);
  const s = STRAINS.find((x) => x.id === id);
  if (s) reportStrain(s, thc);
  return !prev;
}

function lev(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

// Words that show up on packaging and must never be taken for a strain name.
const LABEL_WORDS = new Set(('CANNABIS MARIJUANA PRODUCT PRODUCTS WARNING GOVERNMENT CALIFORNIA HARVEST PACKAGED ORIGINAL RESERVE ' +
  'ORGANIC EXOTIC CLASSIC SELECT TOTAL BATCH PREMIUM INDOOR OUTDOOR FLOWER CONCENTRATE EXTRACT ROSIN RESIN BADDER BUDDER ' +
  'SAUCE DIAMONDS LIVE CURED SOLVENTLESS NATURAL QUALITY LIMITED EDITION SPECIAL CHILDREN LICENSE TESTED MANUFACTURED').split(' '));

// Find the strain named in a blob of label text. Exact phrase wins, longest first;
// otherwise allow a few OCR misreads on longer names.
function findStrain(text) {
  const t = normName(text);
  const padded = ` ${t} `;
  const words = t.split(' ');
  let best = null;
  const offer = (s, score) => { if (!best || score > best.score) best = { s, score }; };
  for (const s of STRAINS) {
    for (const key of s.keys) {
      // Lab-sourced names include short or everyday words, so hold them to a stricter bar.
      if (s.strict && (LABEL_WORDS.has(key) || (key.length < 6 && !key.includes(' ')))) continue;
      if (padded.includes(` ${key} `)) { offer(s, 1000 + key.length); continue; }
      if (key.length < (s.strict ? 9 : 6)) continue;
      const n = key.split(' ').length;
      const allowed = Math.floor(key.length / 6);
      for (let i = 0; i + n <= words.length; i++) {
        const w = words.slice(i, i + n).join(' ');
        if (Math.abs(w.length - key.length) > allowed) continue;
        const d = lev(w, key);
        if (d <= allowed) offer(s, key.length - d * 2);
      }
    }
  }
  return best?.s || null;
}

function parseThc(text) {
  const m = /THC[^0-9\n]{0,14}(\d{1,2}(?:\.\d{1,2})?)\s*%/i.exec(text);
  return m ? parseFloat(m[1]) : null;
}

function searchStrains(q) {
  const n = normName(q);
  if (!n) return [];
  // Exact name first, then names that start with the query, then the most-tested.
  const rank = (s) => (s.keys.includes(n) ? 0 : s.keys.some((k) => k.startsWith(n)) ? 1 : 2);
  const hits = STRAINS.filter((s) => s.keys.some((k) => k.includes(n)))
    .sort((a, b) => rank(a) - rank(b) || (b.lab?.n || 0) - (a.lab?.n || 0));
  if (!hits.length) { const f = findStrain(q); if (f) hits.push(f); }
  return hits.slice(0, 6);
}

// Lines of label text that could be the strain name, counted across camera frames
// so the user can pick the name instead of typing it.
const NOT_A_NAME = /THC|CBD|TOTAL|BATCH|NET ?WT|WEIGHT|LIC|PACKAGED|HARVEST|WARNING|GOVERNMENT|MFG|EXP|TESTED|CANNABI|TERPENE|INGREDIENT|KEEP OUT|WWW|COM$|\d{3}/;
function harvest(text) {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[^A-Za-z0-9#'& ]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
    const letters = line.replace(/[^A-Z]/g, '').length;
    if (line.length < 4 || line.length > 30 || letters < 4 || letters / line.length < 0.7 || NOT_A_NAME.test(line)) continue;
    S.cands[line] = (S.cands[line] || 0) + 1;
  }
}
const candidates = () => Object.entries(S.cands).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([line]) => line);

function sprite(s) {
  let h = 2166136261;
  for (const c of s.name) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const cols = ['#7dff6a', '#2f7a2a', '#b47bff'];
  let rects = '';
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 4; x++) {
      h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
      const edge = Math.abs(3 - y) + (3 - x) > 4;
      if (edge || h % 5 < 2) continue;
      const c = cols[h % 7 === 0 ? 2 : h % 3 === 0 ? 1 : 0];
      rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${c}"/>`;
      if (x < 3) rects += `<rect x="${6 - x}" y="${y}" width="1" height="1" fill="${c}"/>`;
    }
  }
  return `<svg class="sprite" viewBox="0 0 7 7" shape-rendering="crispEdges">${rects}</svg>`;
}

function laneTip(s) {
  const p = S.profile || { type: 'FLOWER', level: 'REGULAR' };
  const rookie = p.level === 'ROOKIE';
  switch (p.type) {
    case 'CONCENTRATES':
      return 'In concentrate form, potency runs far higher than flower, commonly 60 to 90 percent THC.' + (rookie ? ' Start with a very small amount.' : '');
    case 'TOPICALS':
      return 'As a topical, it is applied to the skin and is generally not intoxicating.';
    case 'EDIBLES':
      return 'As an edible, effects can take up to two hours to arrive and last much longer.' + (rookie ? ' Start low and wait before taking more.' : '');
    default:
      if (!s.thc) return rookie ? 'Start low and go slow.' : 'https://terpedex-api.rekigo.workers.dev';
      return `Flower typically tests between ${s.thc[0]} and ${s.thc[1]} percent THC.` + (rookie ? ' Start low and go slow.' : '');
  }
}

function narration(s, isNew) {
  if (s.custom) {
    const thc = S.log[s.id]?.thc;
    return `${isNew ? 'New strain registered. ' : ''}${s.name.replace(/#/g, 'number ')}. Entry number ${Number(s.no)}. ` +
      `This one is not in the reference index yet. ${thc != null ? `Your label reads ${thc} percent THC. ` : ''}${laneTip(s)}`;
  }
  const intro = `${isNew ? 'New strain registered. ' : ''}${s.name.replace(/#/g, 'number ')}. Entry number ${Number(s.no)}. `;
  if (s.shared) {
    const thc = S.log[s.id]?.thc;
    return intro + `${s.blurb} ${thc != null ? `Your label reads ${thc} percent THC. ` : ''}${laneTip(s)}`;
  }
  if (s.fromLab) {
    return intro + (s.type !== 'Lab-tested' ? `${s.type}. ` : '') +
      `Measured in ${s.lab.n} public lab tests. THC ran from ${s.thc[0]} to ${s.thc[1]} percent, with a median of ${s.lab.med}. ` +
      (s.terpenes ? `Dominant terpenes: ${s.terpenes}. ` : '') + laneTip(s);
  }
  return intro + `${s.type}. ${s.blurb} ` +
    `Lineage: ${s.lineage.replace(/ x /g, ' crossed with ').replace(/#/g, 'number ')}. ` +
    `Dominant terpenes: ${s.terpenes}. ` +
    (s.lab ? `In ${s.lab.n} public lab tests, the median THC was ${s.lab.med} percent. ` : '') + laneTip(s);
}

function openEntry(s, isNew, back, backCursor = 0) {
  S.entry = s; S.isNew = isNew; S.back = back; S.backCursor = backCursor;
  go('entry');
  speak(narration(s, isNew));
}

/* ---------- camera + OCR ---------- */
let stream = null;
async function startCamera() {
  S.status = 'STARTING CAMERA...';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera api');
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    if (S.screen !== 'scan') return stopCamera();
    S.status = '';
    render();
    liveScan();
  } catch {
    stream = null;
    S.status = 'NO CAMERA FOUND';
    if (S.screen === 'scan') render();
  }
}
function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

function loadOCR() {
  if (window.Tesseract) return Promise.resolve();
  return new Promise((res, rej) => {
    const el = document.createElement('script');
    el.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    el.onload = res;
    el.onerror = () => rej(new Error('COULD NOT LOAD THE TEXT READER. CHECK YOUR CONNECTION.'));
    document.head.append(el);
  });
}

// One long-lived text reader, set up for scattered label text rather than paragraphs.
let workerP = null;
function getWorker() {
  if (!workerP) {
    workerP = loadOCR().then(async () => {
      const w = await Tesseract.createWorker('eng');
      await w.setParameters({ tessedit_pageseg_mode: '11' });
      return w;
    }).catch((e) => { workerP = null; throw e; });
  }
  return workerP;
}

// Greyscale, stretch the contrast and resize so letters are a readable size.
// `invert` flips light-on-dark labels, which the reader handles badly otherwise.
function prep(src, invert) {
  const scale = Math.min(2, 1600 / src.width);
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * scale); c.height = Math.round(src.height * scale);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, c.width, c.height);
  const im = x.getImageData(0, 0, c.width, c.height), d = im.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    d[i] = g; hist[g]++;
  }
  // Clip only a sliver at each end: label text can be a tiny share of the pixels.
  const cut = (d.length / 4) * 0.002;
  let lo = 0, hi = 255, acc = 0;
  for (; lo < 255; lo++) { acc += hist[lo]; if (acc > cut) break; }
  acc = 0;
  for (; hi > 0; hi--) { acc += hist[hi]; if (acc > cut) break; }
  if (hi - lo < 40) { lo = 0; hi = 255; }
  const range = hi - lo;
  for (let i = 0; i < d.length; i += 4) {
    let g = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / range));
    if (invert) g = 255 - g;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  x.putImageData(im, 0, 0);
  return c;
}

// Grab just the part of the camera frame that sits inside the on-screen box.
function grab(v) {
  const vw = v.videoWidth, vh = v.videoHeight, box = 4 / 3;
  let w = vw, h = vh;
  if (vw / vh > box) w = vh * box; else h = vw / box;
  const x0 = (vw - w) / 2 + w * 0.08, y0 = (vh - h) / 2 + h * 0.08;
  const c = document.createElement('canvas');
  c.width = Math.round(w * 0.84); c.height = Math.round(h * 0.84);
  c.getContext('2d').drawImage(v, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const scanStatus = (t) => { const el = $('#scanStatus'); if (el) el.textContent = t; };

// Keep reading frames until a strain name shows up, so the user can just move the label around.
let scanRun = 0;
async function liveScan() {
  const run = ++scanRun;
  const live = () => S.screen === 'scan' && run === scanRun;
  let pass = 0;
  scanStatus('LOADING TEXT READER...');
  while (live()) {
    const v = lcd.querySelector('video');
    if (!v || !v.videoWidth) { await wait(300); continue; }
    try {
      const w = await getWorker();
      if (!live()) return;
      const { data } = await w.recognize(prep(grab(v), pass++ % 2 === 1));
      if (!live()) return;
      const text = data.text || '';
      S.thcSeen = parseThc(text) ?? S.thcSeen;
      const words = text.replace(/[^A-Za-z0-9#%. ]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (words.length > 3) S.lastRead = words;
      if (findStrain(text)) return handleText(text);
      harvest(text);
      scanStatus(words.length > 3 ? `READING: ${words.slice(0, 60).toUpperCase()}` : 'LOOKING FOR A STRAIN NAME...');
    } catch (e) {
      scanStatus(e.message || 'SCAN ERROR');
      await wait(1500);
    }
    await wait(120);
  }
}

async function analyze(source) {
  go('analyzing');
  try {
    const bmp = await createImageBitmap(source);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    const w = await getWorker();
    let text = '';
    for (const invert of [false, true]) {
      const { data } = await w.recognize(prep(c, invert));
      if (S.screen !== 'analyzing') return;
      text += '\n' + (data.text || '');
      if (findStrain(text)) break;
    }
    handleText(text);
  } catch (e) {
    S.ocr = ''; S.err = e.message || 'SCAN FAILED';
    go('nomatch');
  }
}

function handleText(text) {
  S.ocr = text.trim(); S.err = '';
  const s = findStrain(text);
  if (!s) {
    harvest(text);
    S.thcSeen = parseThc(text) ?? S.thcSeen;
    go('nomatch'); speak('Unknown specimen. No match in the index.');
    return;
  }
  const isNew = logStrain(s.id, parseThc(text) ?? S.thcSeen);
  beep(1320, 120);
  openEntry(s, isNew, 'home');
}

$('#file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) analyze(f);
});

/* ---------- screens ---------- */
const menu = (items) => `<ul class="menu">${items.map((l, i) => `<li data-i="${i}" class="${i === S.cursor ? 'sel' : ''}">${l}</li>`).join('')}</ul>`;

const screens = {
  boot: {
    render: () => `<div class="logo">TERPEDEX</div><p class="center sub">STRAIN INDEX UNIT v0.2</p>${API ? '<p class="center sub">COMMUNITY INDEX: ONLINE</p>' : ''}<p class="center blink" style="margin-top:28px">PRESS OK</p>`,
    a: () => go(!S.ageOk ? 'age' : S.profile ? 'home' : 'type'),
  },
  age: {
    count: 2,
    render: () => `<h1>AGE CHECK</h1><p>ARE YOU 21 OR OLDER?</p>${menu(['YES', 'NO'])}`,
    a: (i) => { if (i === 0) { S.ageOk = true; store.set('age', true); go(S.profile ? 'home' : 'type'); } else go('denied'); },
  },
  denied: {
    render: () => `<h1>ACCESS DENIED</h1><p>TERPEDEX IS FOR ADULTS 21 AND OVER.</p><p class="hint">BACK: RETURN</p>`,
    a: () => go('age'), b: () => go('age'),
  },
  type: {
    count: TYPES.length,
    render: () => `<h1>WHAT'S YOUR LANE?</h1><p class="sub">THIS TUNES WHAT THE INDEX TELLS YOU.</p>${menu(TYPES)}`,
    a: (i) => { S.tmpType = TYPES[i]; go('level'); },
    b: () => { if (S.profile) go('home'); },
  },
  level: {
    count: LEVELS.length,
    render: () => `<h1>EXPERIENCE LEVEL?</h1><p class="sub">${S.tmpType}</p>${menu(LEVELS)}`,
    a: (i) => {
      S.profile = { type: S.tmpType, level: LEVELS[i] };
      store.set('profile', S.profile);
      go('home');
      speak(`Profile set. ${S.profile.type.toLowerCase()}, ${S.profile.level.toLowerCase()}. Welcome to Terpedex. Scan a label to register your first strain.`);
    },
    b: () => go('type'),
  },
  home: {
    enter: () => { S.thcSeen = null; },
    count: 5,
    render: () => `<h1>MAIN MENU</h1><p class="sub">LOGGED ${loggedCount()}/${STRAINS.length} · ${S.profile.type} · ${S.profile.level}</p><div class="rule"></div>` +
      menu(['STRAIN INDEX', 'SCAN A LABEL', 'LOOKUP BY NAME', 'CHANGE PROFILE', `VOICE: ${S.voice ? 'ON' : 'OFF'}`]),
    a: (i) => [() => go('dex'), () => go('scan'), () => go('lookup'), () => go('type'), toggleVoice][i](),
  },
  dex: {
    count: () => dexList().length,
    render: () => {
      const list = dexList();
      // The full index runs to thousands of entries, so only draw the ones near the cursor.
      const from = Math.max(0, S.cursor - 15), to = Math.min(list.length, S.cursor + 25);
      let rows = '';
      for (let i = from; i < to; i++) {
        const s = list[i], got = !!S.log[s.id];
        rows += `<li data-i="${i}" class="${i === S.cursor ? 'sel' : ''} ${got ? '' : 'locked'}"><span class="no">No.${s.no}</span>${got ? esc(s.name.toUpperCase()) + '<span class="tick">●</span>' : '- - - - - -'}</li>`;
      }
      return `<h1>${S.dexAll ? 'FULL INDEX' : 'MY STRAINS'}</h1><p class="sub">LOGGED ${loggedCount()}/${STRAINS.length} · ◀▶: ${S.dexAll ? 'MY STRAINS' : 'FULL INDEX'}</p>` +
        (list.length ? `<ul class="menu">${rows}</ul>` : `<p>NOTHING REGISTERED YET.</p><p>SCAN A LABEL OR USE LOOKUP TO LOG YOUR FIRST STRAIN.</p>`);
    },
    dir: (d) => { if (d === 'left' || d === 'right') { S.dexAll = !S.dexAll; S.cursor = 0; lcd.scrollTop = 0; render(); } },
    a: (i) => { const s = dexList()[i]; if (!s) return; if (S.log[s.id]) openEntry(s, false, 'dex', i); else { S.backCursor = i; go('locked'); } },
    b: () => go('home'),
  },
  locked: {
    render: () => `<h1>NO DATA</h1><p>THIS ENTRY HAS NOT BEEN REGISTERED YET.</p><p>SCAN A LABEL OR USE LOOKUP TO LOG IT.</p><p class="hint">BACK: RETURN</p>`,
    a: () => go('dex', S.backCursor), b: () => go('dex', S.backCursor),
  },
  entry: {
    render: () => {
      const s = S.entry, l = S.log[s.id] || {};
      const row = (label, value) => (value ? `<div class="row"><b>${label}</b><span>${value}</span></div>` : '');
      let thcRow = '';
      if (s.thc) {
        const lo = (s.thc[0] / 35) * 100, hi = (Math.min(35, s.thc[1]) / 35) * 100;
        thcRow = `<div class="row"><b>THC</b><span style="flex:1">${s.thc[0]}–${s.thc[1]}% ${s.fromLab ? 'IN LAB TESTS' : 'TYPICAL'}<br><span class="bar"><i style="left:${lo}%;width:${Math.max(2, hi - lo)}%"></i></span></span></div>`;
      }
      const tip = laneTip(s);
      return (S.isNew ? `<div class="new blink">★ NEW STRAIN REGISTERED ★</div>` : '') +
        `<div class="entry-head">${sprite(s)}<div><div class="no">No.${s.no}</div><div class="name">${esc(s.name.toUpperCase())}</div><span class="tag">${s.shared && s.community.users < 2 ? 'UNCONFIRMED' : esc(s.type.toUpperCase())}</span></div></div>` +
        `<p>${esc(s.blurb)}</p><div class="rule"></div>` +
        row('LINEAGE', s.lineage && esc(s.lineage)) +
        thcRow +
        row('LABEL', l.thc != null && `${l.thc}% THC`) +
        row('TERPENES', s.terpenes && esc(s.terpenes)) +
        row('FLAVOR', s.flavors && esc(s.flavors)) +
        row('REPORTED', s.effects && esc(s.effects)) +
        row('LAB DATA', s.lab && `${s.lab.n} FLOWER TESTS · MEDIAN ${s.lab.med}% THC${s.lab.terp ? ` · ${s.lab.terp}% TERPENES` : ''} · ${s.lab.states}`) +
        row('YOUR LANE', s.custom && S.profile.type) +
        row('COMMUNITY', s.community && [`${s.community.users} ${s.community.users === 1 ? 'USER' : 'USERS'}${s.community.states ? ` · ${s.community.states}` : ''}`,
          ...Object.entries(s.community.thc).map(([lane, t]) => `${lane} LABELS ${t.lo === t.hi ? t.lo : `${t.lo}–${t.hi}`}% THC (${t.n})`)].join('<br>')) +
        `<div class="rule"></div>` + (tip ? `<p class="sub">${esc(tip)}</p>` : '') +
        `<p class="sub">SCANNED ${l.n || 0}X · ${s.effects ? 'EFFECTS VARY BY PERSON AND BATCH. ' : ''}NOT MEDICAL ADVICE.</p>` +
        (s.lab ? `<p class="sub">LAB DATA: CANNLYTICS, CC BY 4.0.</p>` : '') +
        `<p class="hint">OK: READ ALOUD · BACK: RETURN</p>`;
    },
    dir: (d) => { if (d === 'up' || d === 'down') lcd.scrollBy({ top: d === 'up' ? -70 : 70 }); },
    a: () => speak(narration(S.entry, false)),
    b: () => { speak(''); go(S.back, S.backCursor); },
  },
  scan: {
    enter: () => { S.lastRead = ''; S.thcSeen = null; S.cands = {}; startCamera(); },
    leave: () => { scanRun++; stopCamera(); },
    render: () => `<h1>SCAN A LABEL</h1><div class="viewfinder">` +
      (stream ? `<video autoplay playsinline muted></video><div class="reticle"></div>` : `<div class="nocam">${S.status}</div>`) +
      `</div>` + (stream ? `<p id="scanStatus" class="sub" style="margin-top:8px;min-height:2.2em">LOADING TEXT READER...</p>` : '') +
      `<p class="hint">${stream ? 'HOLD THE STRAIN NAME INSIDE THE BOX. IT SCANS ON ITS OWN.<br>OK: NOT FINDING IT · ' : 'OK / '}◀▶: USE A PHOTO · BACK: RETURN</p>`,
    after: () => { const v = lcd.querySelector('video'); if (v && stream) v.srcObject = stream; },
    dir: (d) => { if (d === 'left' || d === 'right') $('#file').click(); },
    a: () => {
      if (!stream) return $('#file').click();
      S.ocr = S.lastRead || ''; S.err = S.ocr ? 'THAT NAME IS NOT IN THE INDEX YET.' : 'COULD NOT READ THE LABEL.';
      go('nomatch');
    },
    b: () => go('home'),
  },
  analyzing: {
    render: () => `<h1>ANALYZING</h1><p class="blink">READING LABEL...</p><p class="sub">FIRST SCAN TAKES LONGER WHILE THE TEXT READER LOADS.</p><p class="hint">BACK: CANCEL</p>`,
    b: () => go('home'),
  },
  nomatch: {
    count: () => candidates().length + 3,
    render: () => {
      const c = candidates();
      return `<h1>UNKNOWN SPECIMEN</h1><p>${esc(S.err || 'NO MATCH IN THE INDEX.')}</p>` +
        (c.length ? `<p class="sub">I READ THESE OFF THE LABEL. PICK THE STRAIN NAME TO REGISTER IT:</p>`
          : S.ocr ? `<p class="sub">LABEL READ: "${esc(S.ocr.replace(/\s+/g, ' ').slice(0, 90))}"</p>` : '') +
        menu([...c.map(esc), 'TYPE THE NAME INSTEAD', 'TRY AGAIN', 'MAIN MENU']);
    },
    a: (i) => {
      const c = candidates();
      if (i >= c.length) return go(['lookup', 'scan', 'home'][i - c.length]);
      const s = addCustom(c[i]);
      const isNew = logStrain(s.id, S.thcSeen);
      beep(1320, 120);
      openEntry(s, isNew, 'home');
    },
    b: () => go('home'),
  },
  lookup: {
    enter: () => { S.q = ''; },
    count: () => searchStrains(S.q).length,
    render: () => `<h1>LOOKUP BY NAME</h1><input id="q" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="TYPE A STRAIN" value="${esc(S.q)}"><div id="lk"></div><p class="hint">OK:LOG IT · BACK: RETURN</p>`,
    after: () => {
      const q = $('#q');
      q.focus();
      q.addEventListener('input', () => { S.q = q.value; S.cursor = 0; screens.lookup.soft(); });
      screens.lookup.soft();
    },
    soft: () => {
      const hits = searchStrains(S.q);
      $('#lk').innerHTML = hits.length
        ? menu(hits.map((s) => `<span class="no">No.${s.no}</span>${esc(s.name.toUpperCase())}`))
        : `<p class="sub">${S.q.trim().length >= 3 ? `NOT IN THE INDEX. PRESS OK TO ADD "${esc(S.q.trim().toUpperCase())}" AS A NEW ENTRY.` : `${STRAINS.length} STRAINS ON FILE.`}</p>`;
    },
    a: (i) => {
      const s = searchStrains(S.q)[i] || (S.q.trim().length >= 3 ? addCustom(S.q) : null);
      if (!s) return;
      const isNew = logStrain(s.id, S.thcSeen);
      beep(1320, 120);
      openEntry(s, isNew, 'home');
    },
    b: () => go('home'),
  },
};

/* ---------- engine ---------- */
function count() {
  const c = screens[S.screen].count;
  return typeof c === 'function' ? c() : c || 0;
}

function render() {
  const sc = screens[S.screen];
  lcd.innerHTML = sc.render();
  sc.after?.();
  lcd.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  $('#voiceBtn').classList.toggle('off', !S.voice);
}

function go(name, cursor = 0) {
  screens[S.screen].leave?.();
  S.screen = name; S.cursor = cursor;
  screens[name].enter?.();
  lcd.scrollTop = 0;
  render();
}

function toggleVoice() {
  S.voice = !S.voice; store.set('voice', S.voice);
  if (!S.voice) speak(''); else beep(990, 80);
  render();
}

function press(btn) {
  const sc = screens[S.screen];
  if (btn === 'voice') return toggleVoice();
  if (btn === 'scan') { beep(); return S.ageOk && S.profile ? go('scan') : null; }
  if (btn === 'index') { beep(); return S.ageOk && S.profile ? (speak(''), go('dex')) : null; }
  if (btn === 'home') { beep(); return S.ageOk && S.profile ? (speak(''), go('home')) : null; }
  if (btn === 'a') { beep(990); return sc.a?.(S.cursor); }
  if (btn === 'b') { beep(520); return sc.b?.(); }
  beep(700, 25);
  const n = count();
  if (n && (btn === 'up' || btn === 'down')) {
    S.cursor = (S.cursor + (btn === 'up' ? -1 : 1) + n) % n;
    return sc.soft ? sc.soft() : render();
  }
  sc.dir?.(btn);
}

document.querySelector('.controls').addEventListener('click', (e) => {
  const b = e.target.closest('[data-btn]');
  if (b) press(b.dataset.btn);
});

lcd.addEventListener('click', (e) => {
  const li = e.target.closest('[data-i]');
  if (li) { S.cursor = +li.dataset.i; press('a'); }
  else if (S.screen === 'boot') press('a');
});

const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'a', z: 'a', Escape: 'b', x: 'b', Backspace: 'b', s: 'scan', m: 'home', v: 'voice' };
document.addEventListener('keydown', (e) => {
  const typing = e.target.tagName === 'INPUT';
  if (typing && !['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(e.key)) return;
  const btn = KEYS[e.key];
  if (!btn) return;
  e.preventDefault();
  press(btn);
});

if ('speechSynthesis' in window) speechSynthesis.getVoices();
render();
syncCommunity();
