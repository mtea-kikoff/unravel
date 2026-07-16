# Unravel

A macOS/Windows/Linux desktop app that downloads **every attachment in a Gmail thread at once** and hands them to you as a single zip. Gmail's UI only lets you save attachments one email at a time; Unravel fixes that.

## How it works

1. Search your mail (Gmail query syntax, e.g. `from:brunner has:attachment`) or paste a thread link/ID.
2. Unravel lists every attachment across the whole thread — every message, every file, with sizes. Inline images (signature logos etc.) are detected and unchecked by default.
3. One click: everything is fetched in parallel and written to a zip wherever you choose. Duplicate filenames are deduped (`report.xlsx`, `report (2).xlsx`).

Everything runs locally. Unravel talks to the Gmail API directly from your machine with a **read-only** scope (`gmail.readonly`) — it cannot send, modify, or delete mail, and nothing passes through a third-party server. OAuth tokens are encrypted with the OS keychain (Electron `safeStorage`).

## Setup

```bash
npm install
npm start        # run from source
npm run pack     # build Unravel.app (macOS arm64) into dist/, then drag to /Applications
```

On first launch the app walks you through a one-time Google API setup (it needs its own OAuth credentials because it talks to Gmail directly):

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), create or pick a project.
2. Enable the [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com).
3. Configure the OAuth consent screen (External is fine; add your own address as a test user while the app is unverified).
4. Create an OAuth client ID of type **Desktop app** and paste the client ID + secret into Unravel.
5. Click **Connect Gmail** — your browser opens for Google sign-in, then you're in.

## Notes & limitations

- **Any Gmail thread URL can be pasted directly**, including new-style links (`…/#inbox/FMfcgz…` or `…/#search/…/FMfcgz…`). Those tokens are decoded locally (base-40 → base-64 scheme reverse-engineered by [Arsenal Recon](https://github.com/ArsenalRecon/GmailURLDecoder)) into the legacy hex id the API accepts. The one exception is `thread-a` tokens — threads where every message was sent by you — which have no API-resolvable id; use search for those.
- Attachments are held in memory while zipping, so multi-gigabyte threads may be slow.
- The zip preserves the thread's chronological order in its file listing.

## Stack

Electron, googleapis (Gmail REST v1), adm-zip. Plain HTML/CSS/JS renderer — no build step.
