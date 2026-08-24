# Earshot

Catch English words you hear but don't know — without pausing what you're listening to.

Say **"save <word>"** while a podcast plays and Earshot stores the word together with the
sentence it appeared in. Later you fill in the meanings and review the list.

---

## Why it needs its own address

The microphone is the whole point of this app, and browsers only hand it to a page that is:

1. served over **HTTPS** (or `localhost`), and
2. **not** running inside someone else's iframe.

A page embedded in another site can be refused the microphone no matter what your browser
settings say. That is why this is deployed as its own site rather than as an embedded preview.

---

## Deploying to GitHub Pages (free, ~10 minutes)

1. Create a GitHub account if you don't have one, at <https://github.com>.
2. Click **+** (top right) → **New repository**. Name it `earshot`. Make it **Public**. Create it.
3. On the empty repo page click **uploading an existing file**.
4. Drag in every file from this folder — `index.html`, `app.js`, `styles.css`,
   `manifest.webmanifest`, `sw.js`, and the three `icon-*.png` files. Commit.
5. Go to **Settings** → **Pages** (left sidebar).
6. Under *Build and deployment* → *Source*, choose **Deploy from a branch**;
   branch **main**, folder **/ (root)**. Save.
7. Wait a minute, then reload that page. It shows your address:
   `https://YOUR-USERNAME.github.io/earshot/`

Open that on your iPhone in **Safari**, tap the mic, and allow the microphone when asked.

### Putting it on the home screen

Safari → **Share** → **Add to Home Screen**. It then opens full-screen with its own icon
and works offline (the word list is stored on the device).

---

## How capture works

Pick the episode **before** you listen and paste its transcript. That's what makes the rest work:
the recognizer no longer has to guess against all of English, only against the few thousand
words that actually occur in this episode.

| You say | What is stored |
|---|---|
| `save debacle` | the word, its real sentence from the transcript, and the timestamp |
| `save meticulus` | repaired to **meticulous** — the transcript is the spelling authority |
| `note that this applies to my own flat` | the thought, plus the passage that was playing |

`save` and `catch` trigger a word. `note that`, `note this`, `remember that` and `make a note`
trigger a note. Without a transcript loaded everything still works — words are just stored
exactly as the microphone heard them, and you can re-match later.

Notes are placed by matching the last few seconds of overheard audio against the transcript, so
placement only works when the podcast reaches the microphone (speaker, not headphones). The word
lookup does not need that — it matches what *you* said.

## The rest of the loop

- **Timestamps** — tap one to jump back to that moment (YouTube and Spotify links are built
  properly; anything else gets `#t=seconds`).
- **Re-match my words** — after adding or replacing a transcript, every word already caught for
  that episode gets its sentence, timestamp and spelling refreshed.
- **Paste a list of words** — for words dictated into a note or a Siri shortcut.
- **Copy words for Claude** → paste into a Claude chat → paste the JSON reply back to fill in
  meaning, IPA, part of speech and an example.
- **Download backup** — a JSON file of everything, restorable on another device.
- **Run microphone check** — reports exactly which step the browser refuses.

---

## The code

Four files, no build step, no dependencies.

| File | What's in it |
|---|---|
| `index.html` | markup and the head (fonts, manifest, icons) |
| `styles.css` | design tokens at the top — colors, light and dark themes — then components |
| `app.js` | one IIFE, sectioned: storage → transcript index → entries → rendering → speech → episodes → tools → diagnostics |
| `sw.js` | service worker for offline. **Bump `CACHE` when you change the other files** |

### Data model

Stored in `localStorage` under `earshot.v2`. A `earshot.v1` list from an older build is migrated
automatically into an episode called *Earlier words*.

```js
{
  v: 2,
  activeId: "ep-1a2b",              // the episode you are listening to now
  episodes: [{
    id: "ep-1a2b",
    title: "Housing Market #42",
    url: "https://youtube.com/watch?v=...",   // optional, makes timestamps tappable
    transcript: "…",                          // raw pasted text
    createdAt, updatedAt
  }],
  entries: [{
    id: "w1a2b3c4",
    kind: "word",                   // "word" | "note"
    episodeId: "ep-1a2b",
    word: "meticulous",
    heardAs: "meticulus",           // set when the transcript repaired the spelling
    sentence: "It is, but the planning was not meticulous at all.",
    t: 35,                          // seconds into the episode, or null
    via: "transcript",              // where the sentence came from
    source: "voice",                // how it was captured
    createdAt, updatedAt,
    meaning: "", example: "", ipa: "", pos: ""
  }]
}
```

Notes use the same entry shape with `kind: "note"`, `text` instead of `word`, and `passage`
instead of `sentence`.

The transcript index is built on demand and never stored — `buildIndex()` turns raw text into
`{sentences: [{text, t}], vocab: {word: count}}`. That's the piece to look at first if you want
to improve matching.

### Ideas for where to take it next

- **Automatic definitions** — one tap instead of the copy/paste loop. Needs a small backend to
  hold an API key; this is the biggest quality-of-life win and your first server-side piece.
- **Spaced repetition** — a `reviewedAt` / `strength` pair on each entry and a daily queue.
- **Fetching transcripts** — YouTube captions can be pulled server-side (Google blocks
  datacenter IPs, so it's flaky); podcasts are easier — RSS gives you the MP3 and Whisper
  transcribes an hour for a few cents.
- **Share-sheet entry** — a Shortcut that sends the URL you're playing straight into a new episode.
- **Phonetic matching** — match what you said against the transcript by sound rather than
  spelling (Metaphone), which would catch the words edit distance misses.
- **Native app** — the only way to listen while another app is in the foreground.

## Licence

Yours. Do what you like with it.
