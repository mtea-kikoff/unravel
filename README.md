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
npm start
```

On first launch the app walks you through a one-time Google API setup (it needs its own OAuth credentials because it talks to Gmail directly):

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), create or pick a project.
2. Enable the [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com).
3. Configure the OAuth consent screen (External is fine; add your own address as a test user while the app is unverified).
4. Create an OAuth client ID of type **Desktop app** and paste the client ID + secret into Unravel.
5. Click **Connect Gmail** — your browser opens for Google sign-in, then you're in.

## Notes & limitations

- **New-style Gmail URLs** (`…/#inbox/FMfcgz…`) use a proprietary token the Gmail API can't look up, so they can't be pasted directly — use in-app search instead, which is usually faster anyway. Legacy hex thread IDs and `thread-f:…` IDs paste fine.
- Attachments are held in memory while zipping, so multi-gigabyte threads may be slow.
- The zip preserves the thread's chronological order in its file listing.

## Stack

Electron, googleapis (Gmail REST v1), adm-zip. Plain HTML/CSS/JS renderer — no build step.
