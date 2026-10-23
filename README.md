# Relay Radio

Nostr as a radio station. Press Play and the live feed comes to you as sound: a short earcon for each kind of event, then the note read aloud.

Live: https://2three1y.github.io/relay-radio/

Made by Carter (2three1y).

## What it does

- Plays notes, replies, reposts, reactions, zaps and mentions, each with its own earcon, then reads the note aloud with a browser voice.
- A switch lets your screen reader (VoiceOver, TalkBack) read the notes instead, through one polite live region. There is also a sounds-only mode.
- Two stations: "Curated relays" (everyone posting on a few membership and web-of-trust relays) and "People I follow" (type your npub or NIP-05 address, or sign in with Nostr Login).
- Mentions and zaps to you get their own sounds and a buzz on your phone.
- An optional background bed (soft rain, brown noise or a warm radio hum), generated in the browser.
- Lock-screen play, pause and next through Media Session.
- It never posts, likes or zaps for you, and it never shows images or video.

## Keyboard

- Space: play or pause
- N: next event
- R: repeat the current event
- Z: open the current note in a Nostr app, to zap or reply there
- S: settings

## Safety filters

- Default relays: pyramid.fiatjaf.com (invite tree), nostr.wine (paid, web-of-trust filtered) and nostrelites.org (web of trust). Busier public relays are one button away in Settings.
- Always skipped: NIP-36 content warnings, NSFW hashtags and labels, sexual words and slurs, and accounts whose profile says they are adult.
- On by default, can be turned off: skip swearing, skip notes that are mostly a picture or video, English letters only.
- You can add your own muted words.
- The filter is best effort. If something slips through, press N.

## Built from starred repos

Every repo below is starred by 2three1y. Full details and license texts are on the credits page (credits.html), in credits.json, NOTICE and licenses/.

### nostr-tools
- Repo: https://github.com/nbd-wtf/nostr-tools
- License: Unlicense
- Used for: relays, events, npub and NIP-05

### nostr-login
- Repo: https://github.com/nostrband/nostr-login
- License: MIT
- Used for: the optional sign-in button (loads only when pressed)

### soundcn
- Repo: https://github.com/kapishdima/soundcn
- License: MIT (code), CC0 (Kenney sounds used)
- Used for: the earcons. The World of Warcraft collection is not used.

### speakable
- Repo: https://github.com/tollwerk/speakable
- License: MIT
- Used for: js/speech.js is adapted from it

### moodist
- Repo: https://github.com/remvze/moodist
- License: MIT (code)
- Used for: js/ambient.js adapts its WAV encoder and looping trick. No moodist sound files are used, because the repo does not say which clips are CC0 and which are Pixabay-licensed.

### web-haptics
- Repo: https://github.com/lochie/web-haptics
- License: MIT
- Used for: haptics for zaps and mentions

### a11y-dialog
- Repo: https://github.com/KittyGiraudel/a11y-dialog
- License: MIT
- Used for: the Settings dialog

### Starred but not used: bitcoin-connect
- Repo: https://github.com/getAlby/bitcoin-connect
- License: MIT
- Why: too heavy for one key. Z opens the note on njump.me, where you can zap with your own wallet.

## License

MIT. See LICENSE. Third-party notices are in NOTICE.
