# Earshot

Catch English words you hear but don't know — without pausing what you're listening to.

Queue an episode with its transcript, tap play, and say **"save <word>"** or **"note that …"**
while it runs. Words come back correctly spelled, in the sentence you heard them in, with a
timestamp that jumps you back to the moment.

Three tabs: **Listen** (the queue), **Notes** (your own thoughts), **Words** (meanings and review).

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

## Getting a YouTube transcript

YouTube writes one for nearly every video — you copy it rather than make it.

**On a computer** (the reliable way): open the video → **...more** to expand the description →
**Show transcript**. The panel opens on the right. Leave timestamps ON — Earshot reads them and
turns them into tap-to-jump links. Click into the panel, select all, copy.

**On the iPhone**: tap the description, scroll down, tap **Show transcript**. It displays fine but
selecting the whole thing is awkward, so it's usually easier to copy on a Mac and let Universal
Clipboard carry it to the phone (same Apple ID, Bluetooth + Wi-Fi + Handoff on — copy on the Mac,
paste on the phone).

Auto-generated captions arrive as short unpunctuated lines with the timestamp on its own line.
`buildIndex()` detects that and groups them into ~20-word passages instead of splitting on
sentence endings, keeping each group's start time.

### Fetching it automatically — `tools/earshot-transcript.py`

A server can't do this reliably (YouTube refuses datacenter IPs) but your Mac can, because it
looks like an ordinary viewer.

```bash
brew install yt-dlp                     # once

python3 tools/earshot-transcript.py "https://www.youtube.com/watch?v=..."
```

It prints the title and copies a clean timestamped transcript to your clipboard:

```
[0:03] so the whole rollout last year was frankly a debacle nobody involved was
[0:15] and the climb back since then has been gruelling for a lot of the smaller
```

YouTube's rolling duplicate lines and inline timing tags are stripped, and the lines are grouped
into ~20-word blocks so the sentences you save read properly.

Set your address once and it can open the app with the episode half-filled:

```bash
echo 'export EARSHOT_URL="https://YOUR-NAME.github.io/earshot/"' >> ~/.zshrc

python3 tools/earshot-transcript.py --open "https://youtu.be/..."
```

Useful flags: `--lang "en.*,pl.*"`, `--words 30`, `--out episode.txt`, `--no-copy`.
It works for anything yt-dlp supports, not only YouTube.

### One tap from the phone — `tools/ios-shortcut.md`

A Shortcut isn't a browser, so CORS doesn't apply, and it runs on your home connection rather
than a datacenter, so YouTube doesn't block it. Share a video → captions fetched → Earshot opens
with the episode filled in and the transcript on the clipboard.

The Shortcut only fetches; Earshot does the parsing, which is why `buildIndex()` accepts a raw
`.vtt` caption file as well as plain text. Full build steps in `tools/ios-shortcut.md`.

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
| `app.js` | one IIFE, sectioned: storage → transcript index → entries → helpers → views → speech → actions → tools |
| `sw.js` | service worker for offline. **Bump `CACHE` when you change the other files** |

### The three tabs

**Listen** is the queue. Each row shows length, whether the transcript is loaded, and how much
you already caught in it. Tap the **play button** to make it the live episode and start the
microphone in one move; tap the **row itself** to open the episode. Rows with no transcript
show **Add** instead of play. Finished episodes collapse into a section at the bottom.

**The episode page** is where notes live: a compose box above the list, a Notes / Words switch,
and the transcript controls. **Edit** (top right) opens title, link and transcript; saving a
changed transcript re-matches that episode's words automatically.

**Notes** collects every note across episodes, grouped by episode, with search. **Words** is the
review list with its filters and the Claude round-trip. Settings (batch import, backup, the
microphone check) sits behind the gear.

### Deploying safely

`app.js` and `index.html` must ship together. If a new `app.js` runs against an older
`index.html` — a partial upload, or a stale service-worker cache — it will reference elements
that don't exist. The whole UI renders from state into `#view`, and every control is reached by delegation on a
`data-act` attribute — so a control that disappears from a template can no longer break the ones
after it. Add a control by adding markup with `data-act="thing"` and a matching entry in the
`actions` table; there is nothing to bind.

The version shows in Settings, at the bottom (`v3.0`), so you can always tell
which build a device is actually running. Bump `VERSION` in `app.js` and `CACHE` in `sw.js`
together when you deploy.

### Data model

Stored in `localStorage` under `earshot.v3`. Older `earshot.v2` and `earshot.v1` data migrates
automatically; a flat v1 list lands in an episode called *Earlier words*.

```js
{
  v: 3,
  activeId: "ep-1a2b",              // the episode you are listening to now
  episodes: [{
    id: "ep-1a2b",
    title: "Housing Market #42",
    url: "https://youtube.com/watch?v=...",   // optional, makes timestamps tappable
    transcript: "…",                          // raw pasted text, or a raw .vtt file
    status: "queued",               // "queued" | "done"
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
