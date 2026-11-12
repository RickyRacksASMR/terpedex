/* Canadex prototype: retro strain index. No build step, no backend. */

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

// Strains the user registers themselves when a label isn't in the reference index.
const customNames = store.get('custom', []);
function pushCustom(name) {
  const s = {
    id: `c${customNames.indexOf(name) + 1}`,
    no: String(STRAINS.length + 1).padStart(3, '0'),
    name, type: 'Unlisted', custom: true,
    blurb: 'Registered from your own label. No reference data on file for this one yet.',
    keys: [normName(name)],
  };
  STRAINS.push(s);
  return s;
}
customNames.forEach(pushCustom);

function addCustom(raw) {
  const key = normName(raw);
  const existing = STRAINS.find((s) => s.keys.includes(key));
  if (existing) return existing;
  const name = raw.trim().replace(/\s+/g, ' ').slice(0, 40).toLowerCase().replace(/(^|[\s-])\S/g, (c) => c.toUpperCase());
  customNames.push(name);
  store.set('custom', customNames);
  return pushCustom(name);
}

function logStrain(id, thc) {
  const prev = S.log[id];
  S.log[id] = { first: prev?.first || Date.now(), n: (prev?.n || 0) + 1, thc: thc ?? prev?.thc ?? null };
  store.set('log', S.log);
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
      if (padded.includes(` ${key} `)) { offer(s, 1000 + key.length); continue; }
      if (key.length < 6) continue;
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
  const hits = STRAINS.filter((s) => s.keys.some((k) => k.includes(n)));
  if (!hits.length) { const f = findStrain(q); if (f) hits.push(f); }
  return hits.slice(0, 6);
}

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
      if (!s.thc) return rookie ? 'Start low and go slow.' : '';
      return `Flower typically tests between ${s.thc[0]} and ${s.thc[1]} percent THC.` + (rookie ? ' Start low and go slow.' : '');
  }
}

function narration(s, isNew) {
  if (s.custom) {
    const thc = S.log[s.id]?.thc;
    return `${isNew ? 'New strain registered. ' : ''}${s.name.replace(/#/g, 'number ')}. Entry number ${Number(s.no)}. ` +
      `This one is not in the reference index yet. ${thc != null ? `Your label reads ${thc} percent THC. ` : ''}${laneTip(s)}`;
  }
  return`${isNew ? 'New strain registered. ' : ''}${s.name}. Entry number ${s.id}. ${s.type}. ${s.blurb} ` +
    `Lineage: ${s.lineage.replace(/ x /g, ' crossed with ').replace(/#/g, 'number ')}. ` +
    `Dominant terpenes: ${s.terpenes}. ${laneTip(s)}`;
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
  if (!s) { go('nomatch'); speak('Unknown specimen. No match in the index.'); return; }
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
    render: () => `<div class="logo">CANADEX</div><p class="center sub">STRAIN INDEX UNIT v0.1</p><p class="center blink" style="margin-top:28px">PRESS OK</p>`,
    a: () => go(!S.ageOk ? 'age' : S.profile ? 'home' : 'type'),
  },
  age: {
    count: 2,
    render: () => `<h1>AGE CHECK</h1><p>ARE YOU 21 OR OLDER?</p>${menu(['YES', 'NO'])}`,
    a: (i) => { if (i === 0) { S.ageOk = true; store.set('age', true); go(S.profile ? 'home' : 'type'); } else go('denied'); },
  },
  denied: {
    render: () => `<h1>ACCESS DENIED</h1><p>CANADEX IS FOR ADULTS 21 AND OVER.</p><p class="hint">BACK: RETURN</p>`,
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
      speak(`Profile set. ${S.profile.type.toLowerCase()}, ${S.profile.level.toLowerCase()}. Welcome to Canadex. Scan a label to register your first strain.`);
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
    count: STRAINS.length,
    render: () => `<h1>STRAIN INDEX</h1><p class="sub">LOGGED ${loggedCount()}/${STRAINS.length}</p><ul class="menu">` +
      STRAINS.map((s, i) => {
        const got = !!S.log[s.id];
        return `<li data-i="${i}" class="${i === S.cursor ? 'sel' : ''} ${got ? '' : 'locked'}"><span class="no">No.${s.no}</span>${got ? esc(s.name.toUpperCase()) + '<span class="tick">●</span>' : '- - - - - -'}</li>`;
      }).join('') + '</ul>',
    a: (i) => { const s = STRAINS[i]; if (S.log[s.id]) openEntry(s, false, 'dex', i); else { S.backCursor = i; go('locked'); } },
    b: () => go('home'),
  },
  locked: {
    render: () => `<h1>NO DATA</h1><p>THIS ENTRY HAS NOT BEEN REGISTERED YET.</p><p>SCAN A LABEL OR USE LOOKUP TO LOG IT.</p><p class="hint">BACK: RETURN</p>`,
    a: () => go('dex', S.backCursor), b: () => go('dex', S.backCursor),
  },
  entry: {
    render: () => {
      const s = S.entry, l = S.log[s.id] || {};
      if (s.custom) {
        return (S.isNew ? `<div class="new blink">★ NEW STRAIN REGISTERED ★</div>` : '') +
          `<div class="entry-head">${sprite(s)}<div><div class="no">No.${s.no}</div><div class="name">${esc(s.name.toUpperCase())}</div><span class="tag">UNLISTED</span></div></div>` +
          `<p>${esc(s.blurb)}</p><div class="rule"></div>` +
          (l.thc != null ? `<div class="row"><b>LABEL</b><span>${l.thc}% THC</span></div>` : '') +
          `<div class="row"><b>YOUR LANE</b><span>${S.profile.type}</span></div>` +
          `<div class="rule"></div><p class="sub">${esc(laneTip(s))}</p>` +
          `<p class="sub">SCANNED ${l.n || 0}X · NOT MEDICAL ADVICE.</p><p class="hint">OK: READ ALOUD · BACK: RETURN</p>`;
      }
      const lo = (s.thc[0] / 35) * 100, hi = (s.thc[1] / 35) * 100;
      return (S.isNew ? `<div class="new blink">★ NEW STRAIN REGISTERED ★</div>` : '') +
        `<div class="entry-head">${sprite(s)}<div><div class="no">No.${s.no}</div><div class="name">${esc(s.name.toUpperCase())}</div><span class="tag">${s.type.toUpperCase()}</span></div></div>` +
        `<p>${esc(s.blurb)}</p><div class="rule"></div>` +
        `<div class="row"><b>LINEAGE</b><span>${esc(s.lineage)}</span></div>` +
        `<div class="row"><b>THC</b><span style="flex:1">${s.thc[0]}–${s.thc[1]}% TYPICAL<br><span class="bar"><i style="left:${lo}%;width:${hi - lo}%"></i></span></span></div>` +
        (l.thc != null ? `<div class="row"><b>LABEL</b><span>${l.thc}% THC</span></div>` : '') +
        `<div class="row"><b>TERPENES</b><span>${esc(s.terpenes)}</span></div>` +
        `<div class="row"><b>FLAVOR</b><span>${esc(s.flavors)}</span></div>` +
        `<div class="row"><b>REPORTED</b><span>${esc(s.effects)}</span></div>` +
        `<div class="rule"></div><p class="sub">${esc(laneTip(s))}</p>` +
        `<p class="sub">SCANNED ${l.n || 0}X · EFFECTS VARY BY PERSON AND BATCH. NOT MEDICAL ADVICE.</p>` +
        `<p class="hint">OK:READ ALOUD · BACK: RETURN</p>`;
    },
    dir: (d) => { if (d === 'up' || d === 'down') lcd.scrollBy({ top: d === 'up' ? -70 : 70 }); },
    a: () => speak(narration(S.entry, false)),
    b: () => { speak(''); go(S.back, S.backCursor); },
  },
  scan: {
    enter: () => { S.lastRead = ''; S.thcSeen = null; startCamera(); },
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
    count: 3,
    render: () => `<h1>UNKNOWN SPECIMEN</h1><p>${esc(S.err || 'NO MATCH IN THE INDEX.')}</p>` +
      (S.ocr ? `<p class="sub">LABEL READ: "${esc(S.ocr.replace(/\s+/g, ' ').slice(0, 90))}"</p>` : '') +
      menu(['TRY AGAIN', 'TYPE THE NAME TO ADD IT', 'MAIN MENU']),
    a: (i) => go(['scan', 'lookup', 'home'][i]),
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
  if (n > 8 && (btn === 'left' || btn === 'right')) {
    S.cursor = Math.max(0, Math.min(n - 1, S.cursor + (btn === 'left' ? -8 : 8)));
    return render();
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
