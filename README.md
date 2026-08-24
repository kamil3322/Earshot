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

| You say | What is stored |
|---|---|
| `save debacle` | the word, plus whatever the mic heard in the previous 30 seconds as context |
| `save meticulous he is very meticulous about it` | the word, plus the sentence you spoke |
| `note the word gruelling …` | same — `save`, `note` and `catch` all work as triggers |

The rolling context only works when the audio reaches the microphone (speaker, not headphones).
The reliable way to get real sentences is the transcript matcher below.

## The rest of the loop

- **Paste a list of words** — for words dictated into a note or a Siri shortcut.
- **Paste a transcript** — paste the episode transcript from Spotify / Apple Podcasts /
  YouTube; Earshot finds each word in it, pulls the real sentence, and repairs spellings the
  microphone got wrong (`meticulus` → `meticulous`).
- **Copy words for Claude** → paste into a Claude chat → paste the JSON reply back to fill in
  meaning, IPA, part of speech and an example.
- **Download backup** — a JSON file of everything, restorable on another device.
- **Run microphone check** — reports exactly which step the browser refuses, instead of
  failing silently.

---

## The code

Three files, no build step, no dependencies.

| File | What's in it |
|---|---|
| `index.html` | markup and the head (fonts, manifest, icons) |
| `styles.css` | design tokens at the top — colors, light and dark themes — then components |
| `app.js` | one IIFE, sectioned: storage → entries → rendering → speech → transcript → diagnostics |
| `sw.js` | service worker for offline. **Bump `CACHE` when you change the other files** |

Data model — one entry per caught word, in `localStorage` under `earshot.v1`:

```js
{
  id: "w1a2b3c4",
  word: "serendipity",
  sentence: "It was pure serendipity that we met.",
  source: "voice" | "typed",     // how it was captured
  via: "transcript",             // set once the sentence came from a transcript
  createdAt: 1755940000000,
  updatedAt: 1755940000000,
  meaning: "", example: "", ipa: "", pos: ""
}
```

### Ideas for where to take it next

- **Spaced repetition** — a `reviewedAt` / `strength` pair on each entry and a daily queue.
- **Automatic definitions** — a dictionary API call (needs a small backend or a free API with
  CORS enabled); this is the biggest quality-of-life win.
- **Episode grouping** — store which podcast episode each word came from and review by episode.
- **Audio snippet** — record 10 seconds around the capture so you can hear the word again.
- **Native app** — the only way to listen while another app is in the foreground. Android can
  do it with a foreground service; iOS needs a Mac, Xcode and an Apple developer account.

## Licence

Yours. Do what you like with it.
