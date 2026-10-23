// Ambient bed for Relay Radio.
// No moodist audio files are shipped: moodist (remvze/moodist, MIT code) mixes CC0
// Freesound clips with Pixabay-licensed clips and does not say which file is which,
// so every bed here is generated in the browser. encodeWAV below is adapted from
// moodist's src/helpers/sound.ts (MIT License, Copyright (c) 2023 MAZE), which uses the
// same trick: render audio to a WAV blob and loop it in a plain <audio> element. On
// iPhone that element also puts the page in "playback" mode, so the earcons and
// voice are heard even with the ring/silent switch on, and the lock screen shows
// play/pause controls.

function writeString(view, offset, s) { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); }

export function encodeWAV(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s * 0x7fff, true);
    o += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// Seeded noise so the loop is the same every time.
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; }; }

function brown(n, r) {
  const out = new Float32Array(n); let last = 0;
  for (let i = 0; i < n; i++) { last = (last + 0.02 * r()) / 1.02; out[i] = last * 3.2; }
  return out;
}

function rain(n, sr, r) {
  const out = new Float32Array(n);
  // pink-ish wash (Paul Kellet's filter, public-domain technique)
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = r();
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.05; b6 = w * 0.115926;
  }
  // droplets: short filtered ticks at random times
  const drops = Math.floor(n / sr * 38);
  for (let d = 0; d < drops; d++) {
    const at = Math.floor(((r() + 1) / 2) * (n - 800));
    const amp = 0.05 + 0.12 * ((r() + 1) / 2);
    const len = 200 + Math.floor(((r() + 1) / 2) * 500);
    for (let k = 0; k < len; k++) out[at + k] += r() * amp * Math.exp(-k / (len / 5));
  }
  return out;
}

function hum(n, sr, r) {
  const out = new Float32Array(n);
  const f = 55;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const wobble = 1 + 0.15 * Math.sin(2 * Math.PI * 0.1 * t);
    out[i] = (0.05 * Math.sin(2 * Math.PI * f * t) + 0.025 * Math.sin(2 * Math.PI * f * 2 * t) + 0.012 * Math.sin(2 * Math.PI * f * 3 * t)) * wobble + r() * 0.012;
  }
  return out;
}

function seamless(samples, sr) {
  // crossfade the last half second into the start so the loop has no click
  const fade = Math.floor(sr * 0.5);
  const n = samples.length - fade;
  const out = new Float32Array(n);
  out.set(samples.subarray(0, n));
  for (let i = 0; i < fade; i++) {
    const a = i / fade;
    out[i] = samples[i] * a + samples[n + i] * (1 - a);
  }
  return out;
}

const cache = new Map();

// iPhone ignores <audio>.volume, so the volume is baked into the samples.
export function bedURL(kind, gain = 1) {
  const key = kind + ':' + gain.toFixed(2);
  if (cache.has(key)) return cache.get(key);
  const sr = 22050;
  let samples;
  if (kind === 'silence') {
    samples = new Float32Array(sr); samples[0] = 0.001; samples[sr - 1] = 0.001;
  } else {
    const n = sr * 12;
    const r = rng(kind.length * 7919);
    samples = seamless(kind === 'rain' ? rain(n, sr, r) : kind === 'hum' ? hum(n, sr, r) : brown(n, r), sr);
  }
  if (kind !== 'silence') for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  const url = URL.createObjectURL(encodeWAV(samples, sr));
  for (const [k, u] of cache) if (k.startsWith(kind + ':')) { URL.revokeObjectURL(u); cache.delete(k); }
  cache.set(key, url);
  return url;
}
