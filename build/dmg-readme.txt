Unravel — download every attachment in a Gmail thread as one zip
================================================================

INSTALL
  1. Drag "Unravel" onto the Applications folder in this window.

FIRST LAUNCH (do this once)
  Unravel isn't signed with a paid Apple certificate, so macOS blocks it
  the first time. This is expected — here's how to get past it:

  1. Open Applications and double-click Unravel. You'll see a message that
     it "can't be opened because Apple cannot check it for malicious software."
     Click Done / Cancel.
  2. Open System Settings → Privacy & Security.
  3. Scroll down to the note "Unravel was blocked…" and click "Open Anyway."
  4. Confirm, and Unravel launches. macOS remembers — you won't be asked again.

  (Prefer Terminal? This one line does the same thing:
     xattr -dr com.apple.quarantine /Applications/Unravel.app )

USING IT
  Click "Connect Gmail" and sign in with your @kikoff.com account — no other
  setup needed. Then paste any Gmail thread link (or search your mail), pick
  the files, and download them all as one zip.

  Unravel is read-only: it can't send, change, or delete your mail or files.
