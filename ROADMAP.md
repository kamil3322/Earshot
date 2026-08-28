# Where this goes next

Written at the end of the first build week, before any real usage. Read it against what you
actually learn in the first fortnight — if the test says something different, the test wins.

## Order

**Backend first, then the Mac widget, then the native app.** Not the other way round: a widget
and a phone app that each keep their own copy of your words is three separate lists that quietly
disagree. The backend is what makes the other two worth building.

---

## 1. The backend

Smaller than it sounds. One user, one dataset, no accounts, no login screen — a shared secret in
a header is enough for something only you use.

**What it needs to do**

| Endpoint | Why |
|---|---|
| `GET /state?since=<ts>` | everything changed since the client last synced |
| `POST /state` | push local changes |
| `POST /define` | words in, meanings out — the API key lives here, never in the client |

That third one removes the copy/paste round-trip to Claude, which is the biggest daily friction
left in the app.

**What it should NOT do: fetch transcripts.** YouTube blocks datacenter IPs, so a server is the
worst possible place for that. Your Mac has a residential connection and already has the script —
keep the Mac as the fetcher and let the backend be a mailbox: Mac pushes prepared episodes, phone
pulls them. That kills the AirDrop step without fighting Google.

**Suggested shape:** Cloudflare Workers + D1, or Fly.io + SQLite. Both free at this size, neither
needs a machine you maintain.

**Do this before writing any sync code — tombstones.** Right now `del-entry` removes the object
outright. With two devices, a word deleted on the phone gets resurrected by the Mac's copy on the
next sync. The fix is to mark rather than remove:

```js
e.deletedAt = Date.now();          // instead of dropping it from the array
```

…and filter deleted entries out of every view. Cheap to add now, unpleasant to retrofit once two
clients are live. Everything else the model needs for sync is already there: stable ids and
`updatedAt` on every record, and all writes funnelled through `save()`.

Last-write-wins per record is sufficient here. You are one person on two devices; you will not
edit the same word in two places in the same minute.

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

- **Sync with conflict resolution.** You are one person. Last-write-wins.
- **Accounts, sharing, multi-user.** Nothing in the design needs them.
- **An App Store release.** Personal apps do not need review, and review would ask questions
  about the microphone you do not want to answer.
