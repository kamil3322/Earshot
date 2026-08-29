# Where this goes next

Written at the end of the first build week, before any real usage. Read it against what you
actually learn in the first fortnight — if the test says something different, the test wins.

## Order

**Backend first, then the Mac widget, then the native app.** Not the other way round: a widget
and a phone app that each keep their own copy of your words is three separate lists that quietly
disagree. The backend is what makes the other two worth building.

---

## 1. The backend — **built, v4.0**

`server/worker.js`, one Cloudflare Worker and one KV namespace. Setup and endpoint list are in
[server/README.md](server/README.md).

Two things came out differently from the plan above, and both were right:

**Accounts, not a shared secret.** The plan said a header secret was enough for one user. It
isn't — a secret in a header is a password with no way to change it, no way to sign out a lost
phone, and no way to grow. Real accounts cost about eighty lines and remove that ceiling. The
password is stretched in the browser and never sent, which also keeps it off Cloudflare.

**A server counter, not `since=<ts>`.** Selecting changes by timestamp assumes a Mac and a phone
agree about the time. They don't. Every write bumps a per-account counter and stamps the records
it touched; a client asks for everything above the number it last saw.

**Tombstones landed first, as this file insisted.** `deletedAt` instead of splicing, every view
reading through `eps()` / `ents()`, ninety-day purge. Retrofitting that after two clients were
live would have been genuinely unpleasant.

**Still true: the server does not fetch transcripts.** YouTube blocks datacenter IPs and a Worker
is a datacenter IP. Transcripts still come from the Mac, from a copy/paste, or through
`/v1/ingest` — a narrow key that can add an episode and nothing else, so Claude can push one
straight into the account from a chat. That last route is what actually killed the AirDrop step.

**Not done yet: `POST /define`.** Words in, meanings out, API key held server-side. It is the
biggest daily friction left and now a small addition rather than a new piece of infrastructure.

---

## 2. The Mac widget

There is a twenty-minute version and a weekend version, and the cheap one may be all you want.

**Cheap:** a macOS **Shortcut** that runs `earshot-transcript.py --queue` on whatever URL is on
the clipboard, placed on the desktop or in the menu bar. Copy a link, click once, episode
prepared. No Swift, no Xcode.

**Proper:** a small SwiftUI menu-bar app — today's caught words, a quick review card, and
"prepare the link on my clipboard". Worth it only once the backend exists, since otherwise it has
no words to show.

---

## 3. The native iOS app

The one thing the web app fundamentally cannot do: **listen while another app is in front**.
Everything else on the list is a convenience; this is a capability.

Build it as a **thin native shell**, not a rewrite: a `WKWebView` showing the existing app, plus
a Swift layer that owns the audio session, runs on-device speech recognition, and passes
recognised text into the page. Roughly 200 lines. You keep the UI, the transcript index, the
matching, the re-encounter logic — all of it — and gain background listening, a proper audio
session that does not stop your podcast, better recognition, and storage iOS cannot evict.

Costs: a Mac (have one), Xcode, and $99/year for the developer account. Without the account, an
app you build yourself stops working after seven days.

**Only build this if the fortnight says so** — specifically if the microphone interrupts your
podcast, or if you find yourself wanting YouTube in front while capturing.

---

## What not to build

- **Sync with conflict resolution.** You are one person. Last-write-wins, and that is what shipped.
- **Sharing and multi-user.** Accounts exist now, but only so *your* devices agree. Nothing in the
  design needs other people in it.
- **An App Store release.** Personal apps do not need review, and review would ask questions
  about the microphone you do not want to answer.
