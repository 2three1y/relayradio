import A11yDialog from '../vendor/a11y-dialog/a11y-dialog.esm.min.js';
import * as voice from './speech.js';
import { bedURL } from './ambient.js';
import { hasWarningTags, textIsSensitive, profileIsSensitive, mostlyLatin, guessLang } from './filter.js';

const NT = window.NostrTools;
const $ = (s) => document.querySelector(s);

// ---------- settings ----------
// Curated by membership: pyramid (invite tree), nostr.wine (paid, web-of-trust filtered), nostrelites (web of trust).
const DEFAULT_RELAYS = ['wss://pyramid.fiatjaf.com', 'wss://nostr.wine', 'wss://nostrelites.org'];
// Big public relays: busier, far less filtered. Also used to find posts by people you follow.
const BUSY_RELAYS = ['wss://relay.primal.net', 'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social', 'wss://nostr.mom'];
const INDEX_RELAYS = ['wss://purplepag.es', 'wss://relay.primal.net', 'wss://relay.damus.io', 'wss://nos.lol'];
const KINDS = {
  note: { label: 'Note', plural: 'Notes', sound: 'soft pluck', hap: null },
  reply: { label: 'Reply', plural: 'Replies', sound: 'water drop', hap: null },
  repost: { label: 'Repost', plural: 'Reposts', sound: 'rising whoosh', hap: null },
  reaction: { label: 'Reaction', plural: 'Reactions', sound: 'glass tink', hap: null },
  zap: { label: 'Zap', plural: 'Zaps', sound: 'three-tone zap', hap: 'success' },
  mention: { label: 'Mention', plural: 'Mentions of me', sound: 'bright chime', hap: 'nudge' },
};
const GAIN = { note: 1, reply: 0.9, repost: 0.8, reaction: 0.9, zap: 0.55, mention: 0.8, start: 0.7, stop: 0.7, error: 0.6 };

const defaults = {
  voiceMode: 'speech', voiceURI: '', rate: 1.1, maxlen: 280, sayKind: true, englishOnly: true, skipReplies: false,
  swearing: true, skipMedia: true, ambient: 'off', ambientVol: 0.35, earconVol: 0.7, haptics: true, mutes: '',
  relays: DEFAULT_RELAYS.join('\n'), station: 'global', pubkey: '',
  kinds: { note: true, reply: true, repost: true, reaction: true, zap: true, mention: true },
};
let cfg = { ...defaults };
try { const saved = JSON.parse(localStorage.getItem('relay-radio') || '{}'); cfg = { ...defaults, ...saved, kinds: { ...defaults.kinds, ...(saved.kinds || {}) } }; } catch { /* first visit */ }
const save = () => { try { localStorage.setItem('relay-radio', JSON.stringify(cfg)); } catch { /* private mode */ } };
const relays = () => cfg.relays.split(/[\s,]+/).map((r) => r.trim()).filter((r) => /^wss?:\/\/\S+$/.test(r));
const mutes = () => cfg.mutes.split(/[\n,]+/).map((m) => m.trim().toLowerCase()).filter(Boolean);

// ---------- announcer (the one polite live region) ----------
const announcer = $('#announcer');
let annTimer = null;
function announce(msg) {
  clearTimeout(annTimer);
  announcer.textContent = '';
  annTimer = setTimeout(() => { announcer.textContent = msg; }, 120);
}

// ---------- audio: earcons, ambient bed, haptics ----------
let ctx = null;
const buffers = {};
const bed = new Audio();
bed.loop = true;
bed.setAttribute('aria-hidden', 'true');
let haptics = null;

async function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') await ctx.resume().catch(() => {}); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* not supported */ }
  await Promise.all(['note', 'reply', 'repost', 'reaction', 'zap', 'mention', 'start', 'stop', 'error'].map(async (k) => {
    try {
      const res = await fetch(`sounds/${k}.mp3`);
      const data = await res.arrayBuffer();
      buffers[k] = await new Promise((ok, bad) => ctx.decodeAudioData(data, ok, bad));
    } catch { buffers[k] = null; }
  }));
}

function tone(k) {
  // fallback beep if a sound file could not be decoded
  const f = { note: 660, reply: 520, repost: 780, reaction: 990, zap: 1320, mention: 880, start: 600, stop: 400, error: 220 }[k] || 600;
  const o = ctx.createOscillator(); const g = ctx.createGain();
  o.frequency.value = f; g.gain.setValueAtTime(0.0001, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.25 * cfg.earconVol, ctx.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
  o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.3);
  return 300;
}

function earcon(k) {
  if (!ctx || cfg.earconVol <= 0) return Promise.resolve();
  let ms;
  const buf = buffers[k];
  if (buf) {
    const src = ctx.createBufferSource(); const g = ctx.createGain();
    src.buffer = buf; g.gain.value = cfg.earconVol * (GAIN[k] || 1);
    src.connect(g).connect(ctx.destination); src.start();
    ms = buf.duration * 1000;
  } else ms = tone(k);
  return new Promise((r) => setTimeout(r, Math.min(ms, 900) + 120));
}

function updateBed() {
  const kind = state.playing && cfg.ambient !== 'off' ? cfg.ambient : 'silence';
  const url = bedURL(kind, Number(cfg.ambientVol));
  if (bed.src !== url) { bed.src = url; }
  if (state.playing) bed.play().catch(() => {}); else bed.pause();
}

async function buzz(k) {
  const pattern = KINDS[k] && KINDS[k].hap;
  if (!cfg.haptics || !pattern) return;
  try {
    if (!haptics) { const m = await import('../vendor/web-haptics/web-haptics.mjs'); haptics = new m.WebHaptics(); }
    haptics.trigger(pattern);
  } catch { /* no haptics here */ }
}

// ---------- profiles ----------
const profiles = new Map(); // pubkey -> {name, ...}
const muted = new Set();
const wanted = new Set();
let profileTimer = null;
function wantProfile(pk) {
  if (!pk || profiles.has(pk) || wanted.has(pk)) return;
  wanted.add(pk);
  clearTimeout(profileTimer);
  profileTimer = setTimeout(fetchProfiles, 700);
}
function fetchProfiles() {
  const authors = [...wanted].filter((pk) => !profiles.has(pk)).slice(0, 150);
  wanted.clear();
  if (!authors.length) return;
  authors.forEach((pk) => profiles.set(pk, null));
  const sub = pool.subscribe([...new Set([...relays().slice(0, 3), ...INDEX_RELAYS])], { kinds: [0], authors }, {
    onevent(ev) {
      try {
        const p = JSON.parse(ev.content);
        const prev = profiles.get(ev.pubkey);
        if (prev && prev.created_at >= ev.created_at) return;
        p.created_at = ev.created_at;
        profiles.set(ev.pubkey, p);
        if (profileIsSensitive(p)) muted.add(ev.pubkey);
      } catch { /* bad profile json */ }
    },
    oneose() { sub.close(); },
  });
  setTimeout(() => sub.close(), 6000);
}
function nameOf(pk) {
  const p = profiles.get(pk);
  const n = p && (p.display_name || p.displayName || p.name);
  if (n && String(n).trim()) return clean(String(n)).slice(0, 40);
  return 'someone';
}

// ---------- text cleanup ----------
function domain(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'a site'; } }
function clean(s) {
  return s
    .replace(/nostr:(npub1[02-9ac-hj-np-z]+|nprofile1[02-9ac-hj-np-z]+)/gi, (m, id) => {
      try { const d = NT.nip19.decode(id); const pk = d.type === 'npub' ? d.data : d.data.pubkey; return '@' + nameOf(pk); } catch { return 'someone'; }
    })
    .replace(/nostr:(note1|nevent1|naddr1)[02-9ac-hj-np-z]+/gi, '(a quoted note)')
    .replace(/https?:\/\/\S+/gi, (u) => {
      if (/\.(jpe?g|png|gif|webp|avif|heic)(\?\S*)?$/i.test(u)) return '(image)';
      if (/\.(mp4|mov|webm|m3u8)(\?\S*)?$/i.test(u)) return '(video)';
      if (/\.(mp3|m4a|wav|ogg|flac)(\?\S*)?$/i.test(u)) return '(audio)';
      return `(link to ${domain(u)})`;
    })
    .replace(/\blnbc[0-9a-z]{20,}\b/gi, '(a lightning invoice)')
    .replace(/\b[0-9a-f]{32,}\b/gi, '')
    .replace(/\b[A-Za-z0-9+/=_-]{48,}\b/g, '')
    .replace(/#(\w)/g, '$1')
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function cut(s, max) {
  if (s.length <= max) return s;
  const c = s.slice(0, max);
  return c.slice(0, Math.max(c.lastIndexOf(' '), max - 20)).trim() + '… and more.';
}

function zapSats(ev) {
  const b = (ev.tags.find((t) => t[0] === 'bolt11') || [])[1] || '';
  const m = /^ln(?:bc|tb|bcrt|tbs)(\d+)([munp]?)/i.exec(b);
  if (!m) return 0;
  const mult = { m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, '': 1 }[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * mult * 1e8);
}

// ---------- classify an incoming event into a radio item ----------
const seen = new Set();
const seenText = new Set();
const lastByAuthor = new Map();

function okText(text) {
  if (textIsSensitive(text, { swearing: cfg.swearing, mutes: mutes() })) return false;
  if (cfg.englishOnly && !mostlyLatin(text)) return false;
  return true;
}

function toItem(ev, origin) {
  if (seen.has(ev.id)) return null;
  seen.add(ev.id);
  if (seen.size > 5000) seen.clear();
  if (muted.has(ev.pubkey)) return null;
  if (hasWarningTags(ev)) return null;
  const me = cfg.pubkey;
  const mentionsMe = me && ev.pubkey !== me && ev.tags.some((t) => t[0] === 'p' && t[1] === me);
  const item = { id: ev.id, ev, author: ev.pubkey, at: ev.created_at, origin, kind: null, text: '', target: null, amount: 0 };
  wantProfile(ev.pubkey);
  if (ev.kind === 1) {
    if (!okText(ev.content)) return null;
    const c = clean(ev.content);
    const words = c.replace(/\((image|video|audio|link to [^)]*|a quoted note)\)/g, '').trim();
    if (words.length < 2) return null;
    if (cfg.skipMedia && /\((image|video)\)/.test(c) && words.length < 80) return null;
    const key = c.slice(0, 80).toLowerCase();
    if (seenText.has(key)) return null;
    seenText.add(key); if (seenText.size > 2000) seenText.clear();
    let isReply = false;
    try { const r = NT.nip10.parse(ev); isReply = !!(r.reply || r.root); } catch { isReply = ev.tags.some((t) => t[0] === 'e'); }
    item.kind = mentionsMe ? 'mention' : isReply ? 'reply' : 'note';
    if (isReply) { const p = ev.tags.filter((t) => t[0] === 'p').map((t) => t[1]); item.target = p[0] || null; if (item.target) wantProfile(item.target); }
    item.raw = ev.content;
  } else if (ev.kind === 6) {
    let inner = null;
    try { inner = ev.content ? JSON.parse(ev.content) : null; } catch { inner = null; }
    if (inner && (hasWarningTags(inner) || !okText(inner.content || '') || muted.has(inner.pubkey))) return null;
    item.kind = mentionsMe ? 'mention' : 'repost';
    item.target = (inner && inner.pubkey) || ((ev.tags.find((t) => t[0] === 'p') || [])[1]) || null;
    if (item.target) wantProfile(item.target);
    item.raw = inner && inner.content ? inner.content : '';
  } else if (ev.kind === 7) {
    item.kind = 'reaction';
    const ps = ev.tags.filter((t) => t[0] === 'p');
    item.target = (ps[ps.length - 1] || [])[1] || null;
    if (item.target) wantProfile(item.target);
    const c = (ev.content || '+').trim();
    if (c.length > 16 || textIsSensitive(c, { swearing: true, mutes: mutes() })) return null;
    item.reaction = c;
  } else if (ev.kind === 9735) {
    item.kind = 'zap';
    item.amount = zapSats(ev);
    item.target = (ev.tags.find((t) => t[0] === 'p') || [])[1] || null;
    try {
      const req = JSON.parse((ev.tags.find((t) => t[0] === 'description') || [])[1] || '{}');
      if (req.pubkey) { item.author = req.pubkey; wantProfile(req.pubkey); }
      if (req.tags && hasWarningTags(req)) return null;
      item.raw = req.content || '';
      if (item.raw && !okText(item.raw)) item.raw = '';
    } catch { item.raw = ''; }
    if (item.target) wantProfile(item.target);
    if (muted.has(item.author)) return null;
  } else return null;
  if (!cfg.kinds[item.kind]) return null;
  if (origin === 'global' && item.kind === 'reply' && cfg.skipReplies) return null;
  if (origin === 'global' && (item.kind === 'note' || item.kind === 'reply')) {
    const last = lastByAuthor.get(ev.pubkey) || 0;
    if (Date.now() - last < 90000) return null;
    lastByAuthor.set(ev.pubkey, Date.now());
  }
  return item;
}

function reactionWords(r) {
  if (r === '+' || r === '') return 'liked';
  if (r === '-') return 'disliked';
  const sc = /^:([\w-]+):$/.exec(r);
  if (sc) return `reacted with ${sc[1].replace(/[_-]/g, ' ')}`;
  return `reacted ${r}`;
}

function wordsFor(item) {
  const who = nameOf(item.author);
  const to = item.target ? (item.target === cfg.pubkey ? 'you' : nameOf(item.target)) : 'someone';
  const body = item.raw ? cut(clean(item.raw), Number(cfg.maxlen)) : '';
  const lead = cfg.sayKind;
  switch (item.kind) {
    case 'note': return { head: lead ? `Note from ${who}.` : `${who}:`, body };
    case 'reply': return { head: lead ? `${who} replied${item.target ? ' to ' + to : ''}.` : `${who}:`, body };
    case 'mention': return { head: `${who} mentioned you${item.ev.kind === 6 ? ' in a repost' : ''}.`, body };
    case 'repost': return { head: `${who} reposted ${to === 'someone' ? 'a note' : to}.`, body };
    case 'reaction': return { head: `${who} ${reactionWords(item.reaction)} ${to === 'you' ? 'your note' : 'a note by ' + to}.`, body: '' };
    case 'zap': return { head: `Zap! ${who} sent ${item.amount ? item.amount.toLocaleString('en-US') + ' sats' : 'sats'} to ${to}.`, body };
    default: return { head: '', body };
  }
}

// ---------- the queue ----------
const buckets = { mention: [], zap: [], note: [], reply: [], repost: [], reaction: [] };
const CAP = { mention: 20, zap: 6, note: 8, reply: 5, repost: 4, reaction: 4 };
const ROTATION = ['note', 'reply', 'note', 'reaction', 'note', 'repost', 'note', 'reply', 'reaction'];
let rot = 0;

function queued() { return Object.values(buckets).reduce((a, b) => a + b.length, 0); }
function enqueue(item) {
  const b = buckets[item.kind];
  // keep each bucket oldest-first so a backlog plays in order and catches up to live
  let i = b.length;
  while (i > 0 && b[i - 1].at > item.at) i -= 1;
  b.splice(i, 0, item);
  while (b.length > CAP[item.kind]) b.shift();
  if (state.playing && state.waiting) advance();
  renderStatus();
}
function takeNext() {
  if (buckets.mention.length) return buckets.mention.shift();
  if (buckets.zap.length) return buckets.zap.shift();
  for (let i = 0; i < ROTATION.length; i++) {
    const k = ROTATION[(rot + i) % ROTATION.length];
    if (buckets[k].length) { rot = (rot + i + 1) % ROTATION.length; return buckets[k].shift(); }
  }
  return null;
}

// ---------- player ----------
const state = { playing: false, waiting: false, current: null, token: 0, station: cfg.station, connected: 0, follows: [] };
const playBtn = $('#play');

function renderStatus() {
  const s = $('#status');
  const where = state.station === 'following' ? 'People I follow' : 'Curated relays';
  if (!state.playing) { s.textContent = `Stopped. ${where}. Press Play to tune in.`; return; }
  const q = queued();
  s.textContent = `${state.waiting ? 'Listening for the next event' : 'Playing'}. ${where}. ${state.connected} of ${relays().length} relays connected. ${q} waiting.`;
}

function renderNow(item, words) {
  const box = $('#now');
  box.replaceChildren();
  const meta = document.createElement('p'); meta.className = 'meta';
  const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = KINDS[item.kind].label;
  const when = new Date(item.at * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  meta.append(kind, document.createTextNode(`${words.head} ${when}`));
  box.append(meta);
  if (words.body) { const t = document.createElement('p'); t.className = 'text'; t.textContent = words.body; t.lang = guessLang(words.body); box.append(t); }
  const a = document.createElement('a'); a.href = noteLink(item); a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Open this note in a Nostr app';
  const p = document.createElement('p'); p.append(a); box.append(p);
}

function addHistory(item, words) {
  const ol = $('#history');
  const li = document.createElement('li');
  const who = document.createElement('span'); who.className = 'who'; who.textContent = words.head;
  li.append(who);
  if (words.body) li.append(document.createTextNode(' ' + words.body));
  li.append(document.createTextNode(' '));
  const a = document.createElement('a'); a.href = noteLink(item); a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Open';
  li.append(a);
  ol.prepend(li);
  while (ol.children.length > 10) ol.lastElementChild.remove();
  $('#history-empty').hidden = true;
}

function noteLink(item) {
  try {
    const ev = item.ev;
    let id = ev.id; let author = ev.pubkey;
    if (ev.kind === 6 || ev.kind === 7 || ev.kind === 9735) {
      const e = ev.tags.filter((t) => t[0] === 'e'); if (e.length) id = e[e.length - 1][1];
      author = item.target || undefined;
    }
    return 'https://njump.me/' + NT.nip19.neventEncode({ id, author, relays: relays().slice(0, 2) });
  } catch { return 'https://njump.me/'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (u) => u.trim().toLowerCase().replace(/\/+$/, '');
async function waitForNames(pks, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && pks.some((pk) => pk && !profiles.get(pk))) await sleep(150);
}

async function playItem(item) {
  const tok = ++state.token;
  voice.cancel();
  state.current = item; state.waiting = false;
  await waitForNames([item.author, item.target], 1500);
  if (tok !== state.token) return;
  const words = wordsFor(item);
  renderNow(item, words);
  renderStatus();
  updateMediaSession(item, words);
  buzz(item.kind);
  await earcon(item.kind);
  if (tok !== state.token) return;
  const text = `${words.head} ${words.body}`.trim();
  if (cfg.voiceMode === 'speech' && voice.supported) {
    await voice.speak(text, { lang: guessLang(words.body || words.head), rate: Number(cfg.rate), voiceURI: cfg.voiceURI });
  } else if (cfg.voiceMode === 'screenreader') {
    announce(text);
    const w = text.split(/\s+/).length;
    await sleep(Math.max(2500, (w / (2.6 * Number(cfg.rate))) * 1000 + 1200));
  } else {
    await sleep(1400);
  }
  if (tok !== state.token) return;
  if (!item.played) { item.played = true; addHistory(item, words); }
  await sleep(500);
  if (tok !== state.token || !state.playing) return;
  advance();
}

function advance() {
  if (!state.playing) return;
  const next = takeNext();
  if (!next) { state.waiting = true; state.token++; renderStatus(); return; }
  playItem(next);
}

async function play() {
  await initAudio();
  state.playing = true;
  playBtn.textContent = 'Pause'; playBtn.dataset.on = 'true';
  updateBed();
  connect();
  await earcon('start');
  announce(`Playing ${state.station === 'following' ? 'people you follow' : 'the curated relays'}.`);
  if (state.current && !state.current.played) playItem(state.current); else advance();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
}

function pause() {
  state.playing = false; state.waiting = false; state.token++;
  voice.cancel();
  playBtn.textContent = 'Play'; playBtn.dataset.on = 'false';
  updateBed();
  earcon('stop');
  announce('Paused.');
  renderStatus();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
}

function toggle() { if (state.playing) pause(); else play(); }
function next() {
  if (!state.playing) { announce('Press Play first.'); return; }
  voice.cancel();
  advance();
  if (state.waiting) announce('Nothing new yet. Listening.');
}
function repeat() {
  if (!state.current) { announce('Nothing to repeat yet.'); return; }
  if (!state.playing) { state.playing = true; playBtn.textContent = 'Pause'; playBtn.dataset.on = 'true'; updateBed(); connect(); }
  playItem(state.current);
}
function openNote() {
  if (!state.current) { announce('Nothing playing yet.'); return; }
  window.open(noteLink(state.current), '_blank', 'noopener');
}

function updateMediaSession(item, words) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: words.head, artist: 'Relay Radio', album: state.station === 'following' ? 'People I follow' : 'Curated relays' });
  } catch { /* older browsers */ }
}
if ('mediaSession' in navigator) {
  try {
    navigator.mediaSession.setActionHandler('play', () => { if (!state.playing) play(); });
    navigator.mediaSession.setActionHandler('pause', () => { if (state.playing) pause(); });
    navigator.mediaSession.setActionHandler('nexttrack', () => next());
  } catch { /* not supported */ }
}

// ---------- relays ----------
const pool = new NT.SimplePool();
let subs = [];
let connectedFor = '';
let statusTimer = null;

function closeSubs() { subs.forEach((s) => { try { s.close(); } catch { /* closed */ } }); subs = []; }

function connect() {
  const key = state.station + '|' + cfg.pubkey + '|' + relays().join(',') + '|' + JSON.stringify(cfg.kinds) + '|' + state.follows.length;
  if (key === connectedFor) return;
  connectedFor = key;
  closeSubs();
  for (const k of Object.keys(buckets)) buckets[k] = [];
  const now = Math.floor(Date.now() / 1000);
  const rs = relays();
  if (!rs.length) { announce('No relays set. Add some in Settings.'); return; }
  const on = (origin) => ({ onevent(ev) { const it = toItem(ev, origin); if (it) enqueue(it); } });
  const kinds = [];
  if (cfg.kinds.note || cfg.kinds.reply || cfg.kinds.mention) kinds.push(1);
  if (cfg.kinds.repost) kinds.push(6);
  if (cfg.kinds.reaction) kinds.push(7);
  if (cfg.kinds.zap) kinds.push(9735);
  if (state.station === 'global') {
    if (kinds.length) subs.push(pool.subscribe(rs, { kinds, since: now - 5 }, on('global')));
    subs.push(pool.subscribe(rs, { kinds: [1], limit: 20 }, on('global')));
    if (cfg.kinds.repost) subs.push(pool.subscribe(rs, { kinds: [6], limit: 4 }, on('global')));
  } else {
    const frs = [...new Set([...rs, ...BUSY_RELAYS])];
    const authors = state.follows;
    for (let i = 0; i < authors.length; i += 250) {
      const chunkA = authors.slice(i, i + 250);
      const fk = kinds.filter((k) => k === 1 || k === 6);
      if (fk.length) {
        subs.push(pool.subscribe(frs, { kinds: fk, authors: chunkA, since: now - 3 * 3600, limit: 15 }, on('following')));
      }
    }
    if (!authors.length) announce('No follows found for this account yet, so nothing will play on this station.');
  }
  if (cfg.pubkey && cfg.kinds.mention !== false) {
    subs.push(pool.subscribe([...new Set([...rs, ...BUSY_RELAYS])], { kinds: [1, 6, 7, 9735], '#p': [cfg.pubkey], since: now - 60 }, on('mentions')));
  }
  clearInterval(statusTimer);
  statusTimer = setInterval(() => {
    try {
      const m = pool.listConnectionStatus();
      const mine = new Set(relays().map(norm));
      state.connected = [...m.entries()].filter(([u, ok]) => ok && mine.has(norm(u))).length;
    } catch { state.connected = 0; }
    renderStatus();
  }, 2500);
}

// ---------- account ----------
async function resolveAccount(input) {
  const v = input.trim().replace(/^nostr:/, '');
  if (/^npub1|^nprofile1/.test(v)) {
    const d = NT.nip19.decode(v);
    return d.type === 'npub' ? d.data : d.data.pubkey;
  }
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
  if (v.includes('@') || v.includes('.')) {
    const p = await NT.nip05.queryProfile(v.includes('@') ? v : '_@' + v);
    if (p && p.pubkey) return p.pubkey;
  }
  throw new Error('not found');
}

async function loadFollows() {
  if (!cfg.pubkey) { state.follows = []; return; }
  try {
    const ev = await pool.get([...new Set([...INDEX_RELAYS, ...relays()])], { kinds: [3], authors: [cfg.pubkey] }, { maxWait: 5000 });
    state.follows = ev ? [...new Set(ev.tags.filter((t) => t[0] === 'p' && /^[0-9a-f]{64}$/.test(t[1])).map((t) => t[1]))] : [];
  } catch { state.follows = []; }
}

async function setAccount(pk, how) {
  cfg.pubkey = pk; save();
  wantProfile(pk);
  $('#account-state').textContent = 'Loading your follow list…';
  await loadFollows();
  const n = state.follows.length;
  setTimeout(() => {
    const msg = `Account added${how ? ' with ' + how : ''}: ${nameOf(pk) === 'someone' ? 'your account' : nameOf(pk)}. ${n} follow${n === 1 ? '' : 's'} found. Mentions and zaps to you will play with their own sounds.`;
    $('#account-state').textContent = msg;
    announce(msg);
  }, 1200);
  $('#signout').hidden = false;
  if (n) { setStation('following'); }
  connectedFor = '';
  if (state.playing) connect();
}

function forget() {
  cfg.pubkey = ''; state.follows = []; save();
  $('#account-state').textContent = 'Not signed in. You are listening to the curated relays.';
  $('#signout').hidden = true;
  setStation('global');
  announce('Account forgotten. Back to the curated relays.');
  try { document.dispatchEvent(new Event('nlLogout')); } catch { /* nostr-login not loaded */ }
}

function setStation(st) {
  state.station = st; cfg.station = st; save();
  document.querySelectorAll('input[name=station]').forEach((r) => { r.checked = r.value === st; });
  $('#station-note').textContent = st === 'following'
    ? (cfg.pubkey ? 'Playing notes and reposts from people you follow, plus anything that mentions or zaps you.' : 'Add your account below first, then this station plays people you follow.')
    : 'Plays everyone posting on a few curated relays, with sensitive notes filtered out. To hear people you follow, add your account below.';
  connectedFor = '';
  if (state.playing) { connect(); state.current = null; voice.cancel(); advance(); }
  renderStatus();
}

let nlLoaded = false;
function nostrLogin() {
  const launch = () => {
    document.dispatchEvent(new CustomEvent('nlLaunch', { detail: 'welcome-login' }));
    setTimeout(() => {
      if (!document.querySelector('dialog nl-auth')) announce('Nostr Login is taking a while to open. You can also type your npub in the box above.');
    }, 12000);
  };
  if (nlLoaded) { launch(); return; }
  announce('Opening Nostr Login. This can take a few seconds.');
  const s = document.createElement('script');
  s.src = 'vendor/nostr-login/nostr-login.js';
  s.dataset.noBanner = 'true';
  s.dataset.methods = 'connect,extension,readOnly';
  s.dataset.startScreen = 'welcome-login';
  s.dataset.title = 'Relay Radio';
  s.dataset.description = 'Sign in to hear people you follow. Relay Radio only reads your public key and never posts for you.';
  s.onload = () => { nlLoaded = true; setTimeout(launch, 300); };
  s.onerror = () => announce('Nostr Login could not load. Type your npub instead.');
  document.body.append(s);
}
document.addEventListener('nlAuth', async (e) => {
  const t = e.detail && e.detail.type;
  if (t === 'login' || t === 'signup') {
    try { const pk = await window.nostr.getPublicKey(); if (pk) setAccount(pk, 'Nostr Login'); } catch { announce('Sign in did not finish.'); }
  }
});

// ---------- settings dialog ----------
const dialogEl = $('#settings');
const dialog = new A11yDialog(dialogEl);
$('#settings-open').addEventListener('click', () => dialog.show());
dialog.on('hide', () => { if (state.playing) connect(); });

function fillSettings() {
  document.querySelectorAll('input[name=voiceMode]').forEach((r) => { r.checked = r.value === cfg.voiceMode; });
  $('#rate').value = cfg.rate; $('#rate-out').textContent = `${Number(cfg.rate).toFixed(1)}×`;
  $('#maxlen').value = String(cfg.maxlen);
  ['sayKind', 'englishOnly', 'skipReplies', 'swearing', 'skipMedia', 'haptics'].forEach((k) => { $('#' + k).checked = !!cfg[k]; });
  $('#ambient').value = cfg.ambient; $('#ambientVol').value = cfg.ambientVol; $('#earconVol').value = cfg.earconVol;
  $('#mutes').value = cfg.mutes; $('#relays').value = cfg.relays;
  const box = $('#kind-toggles'); box.replaceChildren();
  for (const [k, info] of Object.entries(KINDS)) {
    const l = document.createElement('label');
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = cfg.kinds[k] !== false; c.dataset.kind = k;
    c.addEventListener('change', () => { cfg.kinds[k] = c.checked; save(); });
    l.append(c, document.createTextNode(` ${info.plural}`));
    box.append(l);
  }
}
fillSettings();

function fillVoices(list) {
  const sel = $('#voice');
  const cur = cfg.voiceURI;
  sel.replaceChildren(new Option('Automatic', ''));
  list.filter((v) => /^en/i.test(v.lang)).concat(list.filter((v) => !/^en/i.test(v.lang)))
    .forEach((v) => sel.append(new Option(`${v.name} (${v.lang})`, v.voiceURI)));
  sel.value = cur;
}
voice.onVoices(fillVoices);
if (!voice.supported) {
  $('#voice').disabled = true;
  if (cfg.voiceMode === 'speech') cfg.voiceMode = 'screenreader';
}

$('#settings-form').addEventListener('change', (e) => {
  const t = e.target;
  if (t.name === 'voiceMode') cfg.voiceMode = t.value;
  else if (t.id === 'voice') cfg.voiceURI = t.value;
  else if (t.id === 'maxlen') cfg.maxlen = Number(t.value);
  else if (['sayKind', 'englishOnly', 'skipReplies', 'swearing', 'skipMedia', 'haptics'].includes(t.id)) cfg[t.id] = t.checked;
  else if (t.id === 'ambient') { cfg.ambient = t.value; updateBed(); }
  else if (t.id === 'ambientVol') { cfg.ambientVol = Number(t.value); updateBed(); }
  else if (t.id === 'earconVol') cfg.earconVol = Number(t.value);
  else if (t.id === 'mutes') cfg.mutes = t.value;
  else if (t.id === 'relays') cfg.relays = t.value;
  save();
});
$('#rate').addEventListener('input', (e) => { cfg.rate = Number(e.target.value); $('#rate-out').textContent = `${cfg.rate.toFixed(1)}×`; save(); });
$('#relays-reset').addEventListener('click', () => { cfg.relays = DEFAULT_RELAYS.join('\n'); $('#relays').value = cfg.relays; save(); announce('Relays reset to the curated list.'); });
$('#relays-busy').addEventListener('click', () => { cfg.relays = BUSY_RELAYS.join('\n'); $('#relays').value = cfg.relays; save(); announce('Switched to the busy public relays. Much more to hear, and less filtered.'); });

// ---------- legend ----------
const legend = $('#legend');
for (const [k, info] of Object.entries(KINDS)) {
  const li = document.createElement('li');
  const b = document.createElement('button'); b.type = 'button';
  b.textContent = `${info.label}: ${info.sound}`;
  b.addEventListener('click', async () => { await initAudio(); earcon(k); if (info.hap) buzz(k); });
  li.append(b); legend.append(li);
}

// ---------- wiring ----------
playBtn.addEventListener('click', toggle);
$('#next').addEventListener('click', next);
$('#repeat').addEventListener('click', repeat);
$('#open').addEventListener('click', openNote);
$('#signout').addEventListener('click', forget);
$('#nostr-login').addEventListener('click', nostrLogin);
document.querySelectorAll('input[name=station]').forEach((r) => r.addEventListener('change', () => {
  if (r.value === 'following' && !cfg.pubkey) { setStation('following'); $('#npub').focus(); announce('Type your npub or NIP-05 address first.'); return; }
  setStation(r.value);
}));
$('#npub-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('#npub').value;
  if (!v.trim()) { announce('Type your npub or NIP-05 address first.'); $('#npub').focus(); return; }
  try { const pk = await resolveAccount(v); $('#npub').value = ''; setAccount(pk); } catch { announce('That account was not found. Check the npub or address and try again.'); $('#npub').focus(); }
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (dialogEl.getAttribute('aria-hidden') !== 'true') return;
  const t = e.target;
  if (t.closest && t.closest('input, textarea, select, [contenteditable]')) return;
  const k = e.key.toLowerCase();
  if (k === ' ' || e.code === 'Space') {
    if (t.closest && t.closest('button, a, summary')) return;
    e.preventDefault(); toggle();
  } else if (k === 'n') { e.preventDefault(); next(); }
  else if (k === 'r') { e.preventDefault(); repeat(); }
  else if (k === 'z') { e.preventDefault(); openNote(); }
  else if (k === 's') { e.preventDefault(); dialog.show(); }
});

// restore
if (cfg.pubkey) {
  $('#signout').hidden = false;
  $('#account-state').textContent = 'Account saved on this device. Loading your follow list…';
  wantProfile(cfg.pubkey);
  loadFollows().then(() => {
    $('#account-state').textContent = `Account saved on this device. ${state.follows.length} follows found.`;
    connectedFor = '';
    if (state.playing) connect();
  });
}
setStation(cfg.station === 'following' && cfg.pubkey ? 'following' : 'global');
renderStatus();
