// Content filters for Relay Radio. Best effort: Nostr is open, so the N key is the last line.

const NSFW_TAGS = new Set(['nsfw', 'nsfl', 'porn', 'porno', 'nude', 'nudes', 'nudity', 'naked', 'sex', 'sexy', 'xxx',
  'onlyfans', 'adult', 'adultcontent', '18plus', '18', 'boobs', 'tits', 'hentai', 'lewd', 'gore', 'erotic', 'erotica',
  'fetish', 'kink', 'bdsm', 'milf', 'horny', 'nsfwart', 'nostrporn', 'grownostr', 'asstr', 'contentwarning', 'cw']);

const SEXUAL = /\b(nsfw|porn\w*|nudes?|nudity|naked|xxx|onlyfans|hentai|horny|sexy|sex|sexual\w*|milf|bdsm|blowjobs?|anal|cum\w*|tits|titties|boobs?|pussy|pussies|dick|dicks|cock|cocks|penis|vagina|slut\w*|whores?|fetish\w*|erotic\w*|orgasm\w*|masturbat\w*|incest|rape\w*|pedo\w*|nsfl|gore)\b/i;
const SLURS = /\b(nigg\w*|fag\w*|retard\w*|tranny|kike\w*|chink\w*|spic|spics)\b/i;
const SWEARING = /\b(fuck\w*|shit\w*|bitch\w*|bastard\w*|asshole\w*|motherf\w*|cunt\w*|wank\w*)\b/i;

export function hasWarningTags(ev) {
  for (const t of ev.tags || []) {
    const k = t[0];
    if (k === 'content-warning') return true;
    if (k === 't' && t[1] && NSFW_TAGS.has(String(t[1]).toLowerCase().replace(/[^a-z0-9]/g, ''))) return true;
    if ((k === 'l' || k === 'L') && /nsfw|content-warning|porn|sexual|nudity|gore/i.test(t.slice(1).join(' '))) return true;
  }
  return false;
}

export function textIsSensitive(text, { swearing = true, mutes = [] } = {}) {
  if (!text) return false;
  const plain = text.replace(/https?:\/\/\S+/g, ' ');
  if (/#(nsfw|nsfl|porn|nude|nudes|xxx|onlyfans|hentai|lewd|gore|adult)\b/i.test(text)) return true;
  if (SEXUAL.test(plain) || SLURS.test(plain)) return true;
  if (swearing && SWEARING.test(plain)) return true;
  const low = plain.toLowerCase();
  for (const m of mutes) if (m && low.includes(m)) return true;
  return false;
}

export function profileIsSensitive(profile, { swearing = true } = {}) {
  if (!profile) return false;
  const s = [profile.name, profile.display_name, profile.displayName, profile.about, profile.nip05].filter(Boolean).join(' ');
  if (/#?(nsfw|porn|onlyfans|xxx|18\+|hentai|nudes?|lewd|adult content)/i.test(s) || SLURS.test(s) || SEXUAL.test(s)) return true;
  const names = [profile.name, profile.display_name, profile.displayName].filter(Boolean).join(' ');
  return swearing && SWEARING.test(names.replace(/(fuck|shit|bitch|cunt)/gi, ' $1'));
}

// "English letters": most letters are Latin script. Emoji-only notes pass.
export function mostlyLatin(text) {
  const letters = text.match(/\p{L}/gu);
  if (!letters || letters.length < 4) return true;
  const latin = text.match(/\p{Script=Latin}/gu) || [];
  return latin.length / letters.length >= 0.75;
}

// Guess a BCP-47 language for the voice from the script used.
export function guessLang(text) {
  const tests = [[/\p{Script=Hiragana}|\p{Script=Katakana}/u, 'ja'], [/\p{Script=Hangul}/u, 'ko'], [/\p{Script=Han}/u, 'zh'],
    [/\p{Script=Cyrillic}/u, 'ru'], [/\p{Script=Arabic}/u, 'ar'], [/\p{Script=Hebrew}/u, 'he'], [/\p{Script=Thai}/u, 'th'],
    [/\p{Script=Devanagari}/u, 'hi'], [/\p{Script=Greek}/u, 'el']];
  for (const [re, l] of tests) if (re.test(text)) return l;
  return 'en';
}
