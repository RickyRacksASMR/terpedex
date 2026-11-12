/* Terpedex attribute profile.
 *
 * Works out, for any strain, a type, a best time of day, a vibe, a potency tier and an
 * aroma, from whatever is on file: reference data, lab tests, what users report, and as
 * a last resort the strain's name. Every result carries its basis so the screen can say
 * where it came from. These are tendencies, not promises: effects vary by person and batch.
 */

// What each terpene smells like, and which way it is commonly said to lean
// (negative = brighter / daytime, positive = heavier / evening).
const TERPENE_INFO = {
  Myrcene: { aroma: 'earthy, musky', lean: 1 },
  Linalool: { aroma: 'floral, lavender', lean: 1 },
  Caryophyllene: { aroma: 'pepper, spice', lean: 0.3 },
  Humulene: { aroma: 'woody, hoppy', lean: 0.2 },
  Bisabolol: { aroma: 'sweet, floral', lean: 0.3 },
  Limonene: { aroma: 'citrus', lean: -0.7 },
  Pinene: { aroma: 'pine', lean: -0.7 },
  Ocimene: { aroma: 'sweet, herbal', lean: -0.7 },
  Terpinolene: { aroma: 'fruity, piney', lean: -1.2 },
};

// Effect words used in the hand-written entries.
const EFFECT_LEAN = {
  Sleepy: 2, Heavy: 1.5, Relaxed: 0.7, Calm: 0.5, Mellow: 0.5, Hungry: 0.3,
  Energetic: -2, Uplifted: -1, Focused: -1, Clear: -0.8, Creative: -0.7, Talkative: -0.7,
};

// How users say it hit them.
const FEELS = ['Energizing', 'Balanced', 'Relaxing', 'Couch-lock', 'Sleepy'];
const FEEL_LEAN = { Energizing: -3, Balanced: 0, Relaxing: 1.8, 'Couch-lock': 3, Sleepy: 3.3 };

// Name families. Strain names loosely track genetics, so this is only used when
// nothing better is on file, and is always shown as an estimate.
const NAME_HINTS = [
  [/\b(HAZE|DURBAN|JACK|THAI|TANGIE|CLEMENTINE|LEMON SKUNK|GREEN CRACK|MAUI|COUGH|LAMBS? ?BREAD|CINDERELLA|C99|CHOCOLOPE|TRAINWRECK|TROPICANN?A|GOLDEN GOAT|SUPER LEMON|SATIVA)\b/, -2],
  [/\b(DIESEL|MIMOSA|TANGERINE|MELONADE|PINEAPPLE|AMNESIA|ISLAND)\b/, -1],
  [/\b(KUSH|AFGHANI?|BUBBA|NORTHERN LIGHTS|PUNCH|BREATH|MOTORBREATH|GMO|GARLIC|DO ?SI ?DOS?|DOSI|SLURRICANE|ZKITTLEZ|URKLE|QUERKLE|GRAND ?DADDY|GDP|PURPS?|CONFIDENTIAL|BLACKBERRY|HASH|ICE CREAM|BISCOTTI|INDICA)\b/, 2],
  [/\b(OG|PURPLE|GRAPE|CAKE|MINTS?|SHERBE?R?T|BLUEBERRY|CHEESE|OREOZ?|SUNDAE|PIE)\b/, 1],
  [/\b(COOKIES?|GELATO|RUNTZ|GLUE|GORILLA|CHEM|DAWG|STARDAWG|MAC|SKUNK|HEADBAND|DREAM|WEDDING|FRITTER|BANANA|CEREAL|BELTS|GUSHERZ?|PAYTON|WIDOW|HYBRID)\b/, 0],
];

function typeFromName(name) {
  const n = name.toUpperCase().replace(/[^A-Z0-9]+/g, ' ');
  let score = 0, hits = 0;
  for (const [re, lean] of NAME_HINTS) {
    const m = n.match(new RegExp(re.source, 'g'));
    if (m) { score += lean * m.length; hits += m.length; }
  }
  if (!hits) return null;
  return score >= 1.5 ? 'Indica' : score <= -1.5 ? 'Sativa' : 'Hybrid';
}

const TYPE_LEAN = { Indica: 2, Sativa: -2, Hybrid: 0 };

function strainProfile(s) {
  const mine = S.log[s.id] || {};
  const c = s.community || {};
  const p = { basis: [] };

  // ---- type ----
  const voted = consensus(c.types);
  if (hasOwnType(s)) p.type = { value: s.type, src: 'ON FILE' };
  else if (voted?.confirmed) p.type = { value: voted.value, src: `CONFIRMED BY ${voted.n} USERS` };
  else if (mine.type) p.type = { value: mine.type, src: 'YOUR LABEL' };
  else if (voted) p.type = { value: voted.value, src: 'ONE REPORT, UNCONFIRMED' };
  else {
    const guess = typeFromName(s.name);
    if (guess) p.type = { value: guess, src: 'ESTIMATED FROM NAME', guess: true };
  }

  // ---- terpenes ----
  let terps = (s.terpenes || '').split(',').map((t) => t.trim()).filter(Boolean);
  if (terps.length) p.terpSrc = s.fromLab ? 'LAB TESTS' : 'ON FILE';
  else {
    terps = Object.entries(c.terps || {}).sort((a, b) => b[1] - a[1]).map(([t]) => t);
    if (mine.terp && !terps.includes(mine.terp)) terps.unshift(mine.terp);
    terps = terps.slice(0, 3);
    if (terps.length) p.terpSrc = 'USER LABELS';
  }
  p.terpenes = terps;
  p.aroma = s.flavors || [...new Set(terps.map((t) => TERPENE_INFO[t]?.aroma).filter(Boolean).join(', ').split(', '))].slice(0, 4).join(', ');

  // ---- potency (flower lab numbers, else the hand-written range) ----
  const thc = s.lab?.med ?? (s.thc ? (s.thc[0] + s.thc[1]) / 2 : null);
  if (thc != null) {
    p.potency = { tier: thc >= 28 ? 'VERY STRONG' : thc >= 23 ? 'STRONG' : thc >= 18 ? 'MODERATE' : 'MILD', thc: Math.round(thc * 10) / 10, lab: !!s.lab };
  }

  // ---- lean: negative = daytime, positive = night ----
  let lean = 0, weight = 0;
  if (p.type) { const w = p.type.guess ? 1 : 2; lean += TYPE_LEAN[p.type.value] * w; weight += w; p.basis.push('TYPE'); }
  if (terps.length) {
    const share = [1.5, 1, 0.5];
    let t = 0;
    terps.slice(0, 3).forEach((name, i) => { t += (TERPENE_INFO[name]?.lean || 0) * share[i]; });
    lean += t * 1.5; weight += 1.5; p.basis.push('TERPENES');
  }
  if (s.effects) {
    let e = 0;
    for (const word of s.effects.split(',')) e += EFFECT_LEAN[word.trim()] || 0;
    lean += e; weight += 2; p.basis.push('REPORTED EFFECTS');
  }
  const feels = { ...(c.feels || {}) };
  const feelVotes = Object.values(feels).reduce((n, v) => n + v, 0);
  if (feelVotes) {
    let f = 0;
    for (const [k, v] of Object.entries(feels)) f += (FEEL_LEAN[k] || 0) * v;
    const w = Math.min(6, 1.5 * feelVotes);   // real reports outweigh guesses as they pile up
    lean += (f / feelVotes) * w; weight += w;
    p.basis.push(`${feelVotes} USER ${feelVotes === 1 ? 'RATING' : 'RATINGS'}`);
    p.feel = consensus(feels);
  } else if (mine.feel) {
    lean += FEEL_LEAN[mine.feel] * 1.5; weight += 1.5; p.basis.push('YOUR RATING');
  }

  if (!weight) return p;   // nothing to go on: no time of day or vibe
  // Dividing by weight + 2 pulls thin evidence toward the middle: a type alone can say
  // "evening", but it takes type, terpenes and reports agreeing to say "couch-lock".
  const score = lean / (weight + 2);
  p.score = score;
  if (score <= -1.1) { p.time = 'DAYTIME'; p.vibe = ['ENERGIZING', 'UPLIFTING']; }
  else if (score <= -0.35) { p.time = 'DAYTIME'; p.vibe = ['UPLIFTING', 'CLEAR-HEADED']; }
  else if (score < 0.35) { p.time = 'ANYTIME'; p.vibe = ['BALANCED']; }
  else if (score < 1.1) { p.time = 'EVENING'; p.vibe = ['RELAXING', 'MELLOW']; }
  else { p.time = 'NIGHT / SLEEP'; p.vibe = ['HEAVY', 'COUCH-LOCK LIKELY', 'SLEEPY']; }
  // A guess from the name alone is too thin to call anything stronger than a lean.
  p.thin = p.basis.length === 1 && p.type?.guess;
  return p;
}

// Rows for the entry screen.
function profileRows(s, row) {
  const p = strainProfile(s);
  const out = [];
  if (p.type && !hasOwnType(s)) out.push(row('TYPE', `${p.type.value.toUpperCase()}<br><span class="sub">${p.type.src}</span>`));
  if (p.time) {
    out.push(row('BEST FOR', p.time + (p.thin ? '?' : '')));
    out.push(row('VIBE', p.vibe.join(' · ') + (p.thin ? '<br><span class="sub">ROUGH ESTIMATE</span>' : '')));
  }
  if (p.potency) out.push(row('POTENCY', `${p.potency.tier}<br><span class="sub">${p.potency.lab ? 'MEDIAN' : 'TYPICAL'} ${p.potency.thc}% THC IN FLOWER</span>`));
  if (!s.terpenes && p.terpenes.length) out.push(row('TERPENES', `${p.terpenes.join(', ')}<br><span class="sub">FROM ${p.terpSrc}</span>`));
  if (p.aroma && !s.flavors) out.push(row('AROMA', p.aroma.toUpperCase()));
  if (p.feel) out.push(row('USERS SAY', `${p.feel.value.toUpperCase()} · ${p.feel.n} OF ${p.feel.total}${p.feel.confirmed ? ' · CONFIRMED' : ''}`));
  if (!out.length) return `<p class="sub">NO PROFILE YET. ANSWER THE LABEL QUESTIONS OR RATE IT TO START ONE.</p>`;
  return out.join('') + (p.basis.length ? `<p class="sub" style="margin-top:6px">PROFILE BASIS: ${p.basis.join(' + ')}. A TENDENCY, NOT A GUARANTEE.</p>` : '');
}

// Sentences for the voice.
function profileSpeech(s) {
  const p = strainProfile(s);
  const say = [];
  if (p.type && !hasOwnType(s)) say.push(`Type: ${p.type.value}, ${p.type.src.toLowerCase().replace('one report, unconfirmed', 'from one unconfirmed report')}.`);
  if (p.time) {
    const when = { DAYTIME: 'daytime', ANYTIME: 'any time of day', EVENING: 'the evening', 'NIGHT / SLEEP': 'night time and sleep' }[p.time];
    say.push(`${p.thin ? 'Rough estimate: best' : 'Best'} for ${when}. Expect it to be ${p.vibe.join(', ').toLowerCase().replace('couch-lock likely', 'likely to couch lock you')}.`);
  }
  if (p.potency) say.push(`Potency: ${p.potency.tier.toLowerCase()}, around ${Math.round(p.potency.thc)} percent THC in flower.`);
  if (p.terpenes.length) say.push(`Terpenes: ${p.terpenes.join(', ')}.`);
  if (p.aroma) say.push(`Aroma: ${p.aroma.toLowerCase()}.`);
  if (p.feel) say.push(`Users say it is ${p.feel.value.toLowerCase()}.`);
  return say.join(' ') + (say.length ? ' ' : '');
}
