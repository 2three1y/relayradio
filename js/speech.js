// Speech for Relay Radio.
// Adapted from tollwerk/speakable (MIT License, Copyright (c) 2020 tollwerk GmbH,
// https://github.com/tollwerk/speakable): the voice lookup by language with local
// voices preferred and the default voice as the fallback, refreshing the voice list
// through the onvoiceschanged property because iOS Safari has no addEventListener on
// speechSynthesis, and sentence-sized utterances chained on their end event.
// Changed for Relay Radio: works on strings instead of DOM nodes, adds rate/voice
// choice, a watchdog for engines that forget to fire "end", and cancellation.

let voices = [];
const keep = []; // hold utterances so the engine cannot garbage-collect them mid-speech (Chrome)

function refreshVoices() {
  if (!('speechSynthesis' in window)) return;
  voices = speechSynthesis.getVoices();
  listeners.forEach((fn) => fn(voices));
}
const listeners = new Set();
export function onVoices(fn) { listeners.add(fn); if (voices.length) fn(voices); }
if ('speechSynthesis' in window) {
  refreshVoices();
  if (speechSynthesis.addEventListener) speechSynthesis.addEventListener('voiceschanged', refreshVoices);
  else speechSynthesis.onvoiceschanged = refreshVoices;
}

export const supported = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

export function findVoice(lang, preferredURI) {
  if (preferredURI) {
    const chosen = voices.find((v) => v.voiceURI === preferredURI);
    if (chosen && (!lang || chosen.lang.toLowerCase().startsWith(lang.split('-')[0]))) return chosen;
  }
  const base = (lang || 'en').toLowerCase().split('-')[0];
  const pool = voices.filter((v) => v.lang.toLowerCase().replace('_', '-').split('-')[0] === base);
  return pool.find((v) => v.localService && v.default) || pool.find((v) => v.localService)
    || pool[0] || voices.find((v) => v.default) || voices[0] || null;
}

// Split into chunks the engines handle well (Chrome stops very long utterances).
export function chunk(text, max = 180) {
  const parts = text.match(/[^.!?…]+[.!?…]*\s*/g) || [text];
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > max && cur) { out.push(cur.trim()); cur = ''; }
    if (p.length > max) {
      const words = p.split(/\s+/);
      for (const w of words) {
        if ((cur + ' ' + w).length > max && cur) { out.push(cur.trim()); cur = ''; }
        cur += (cur ? ' ' : '') + w;
      }
    } else cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

let generation = 0;

export function cancel() {
  generation += 1;
  if (supported) speechSynthesis.cancel();
}

// Speak text; resolves true when finished, false when cancelled.
export function speak(text, { lang = 'en', rate = 1, voiceURI = '' } = {}) {
  if (!supported || !text) return Promise.resolve(true);
  const gen = ++generation;
  speechSynthesis.cancel();
  const pieces = chunk(text);
  return new Promise((resolve) => {
    let i = 0;
    const step = () => {
      if (gen !== generation) { resolve(false); return; }
      if (i >= pieces.length) { resolve(true); return; }
      const u = new SpeechSynthesisUtterance(pieces[i]);
      const v = findVoice(lang, voiceURI);
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = lang;
      u.rate = rate;
      u.pitch = 1;
      u.volume = 1;
      keep.push(u); if (keep.length > 8) keep.shift();
      let done = false;
      const words = pieces[i].split(/\s+/).length;
      const watchdog = setTimeout(() => finish(), (words / (2.4 * rate)) * 1000 * 2 + 4000);
      function finish() {
        if (done) return;
        done = true;
        clearTimeout(watchdog);
        i += 1;
        setTimeout(step, 60);
      }
      u.onend = finish;
      u.onerror = finish;
      speechSynthesis.speak(u);
    };
    step();
  });
}
