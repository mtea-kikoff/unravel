const { google } = require('googleapis');
const auth = require('./auth');

function gmail() {
  return google.gmail({ version: 'v1', auth: auth.getAuthedClient() });
}

function header(message, name) {
  const headers = message.payload?.headers || [];
  const hit = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return hit ? hit.value : '';
}

// --- New-style Gmail URL tokens (FMfcgz…) ---
// The token is a big number written in base 40 (a consonant-only alphabet).
// Re-expressed in base 64 it becomes base64 text that decodes to
// "thread-f:<decimal>" (or bare "f:<decimal>"), and that decimal is the
// legacy hex id the Gmail API accepts. Reverse-engineered by Arsenal Recon:
// https://github.com/ArsenalRecon/GmailURLDecoder
const TOKEN_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz';
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeNewToken(token) {
  let n = 0n;
  for (const ch of token) {
    const d = TOKEN_ALPHABET.indexOf(ch);
    if (d === -1) return null;
    n = n * 40n + BigInt(d);
  }
  let b64 = '';
  while (n > 0n) {
    b64 = B64_ALPHABET[Number(n % 64n)] + b64;
    n /= 64n;
  }
  try {
    return Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function newTokenToHexId(token) {
  // A copied URL can drag extra characters along; trim from the right until
  // the token decodes (Arsenal Recon's correction step). 32 is the minimum
  // token length.
  for (let t = token; t.length >= 32; t = t.slice(0, -1)) {
    const text = decodeNewToken(t);
    if (!text) continue;
    const f = text.match(/f:(\d+)\s*$/);
    if (f) return BigInt(f[1]).toString(16);
    if (/a:/.test(text)) {
      throw new Error(
        'This link points to a thread only you have sent mail in ("thread-a"), which Gmail gives a private id with no API equivalent. Search for the thread instead.'
      );
    }
  }
  return null;
}

const NEW_TOKEN_RE = /^[BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz]{32,}$/;

// Accepts a Gmail URL (both legacy hex and new FMfcgz… formats), a bare hex
// thread id, a bare new-format token, or a "thread-f:12345" id.
function parseThreadInput(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('Paste a thread link or ID, or search your mail below.');

  if (/^[0-9a-fA-F]{12,20}$/.test(s)) return s.toLowerCase();

  const legacy = s.match(/thread-f:(\d+)/);
  if (legacy) return BigInt(legacy[1]).toString(16);

  if (NEW_TOKEN_RE.test(s)) {
    const hex = newTokenToHexId(s);
    if (hex) return hex;
  }

  if (s.includes('mail.google.com')) {
    const tail = (s.split('?')[0] || '').split(/[/#]/).filter(Boolean).pop() || '';
    if (/^[0-9a-fA-F]{12,20}$/.test(tail)) return tail.toLowerCase();
    if (NEW_TOKEN_RE.test(tail)) {
      const hex = newTokenToHexId(tail);
      if (hex) return hex;
    }
    throw new Error("Couldn't read a thread id out of that Gmail link. Try searching instead.");
  }

  throw new Error("That doesn't look like a Gmail thread link or ID. Try searching instead.");
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function searchThreads(query) {
  const q = (query || '').trim() || 'has:attachment';
  const list = await gmail().users.threads.list({ userId: 'me', q, maxResults: 25 });
  const threads = list.data.threads || [];

  return mapWithConcurrency(threads, 6, async (t) => {
    const detail = await gmail().users.threads.get({
      userId: 'me',
      id: t.id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'],
    });
    const messages = detail.data.messages || [];
    const first = messages[0] || {};
    const last = messages[messages.length - 1] || {};
    const senders = [
      ...new Set(
        messages
          .map((m) => header(m, 'From').replace(/\s*<[^>]*>/, '').replace(/^"|"$/g, '').trim())
          .filter(Boolean)
      ),
    ];
    return {
      id: t.id,
      subject: header(first, 'Subject') || '(no subject)',
      senders,
      date: Number(last.internalDate) || null,
      messageCount: messages.length,
      snippet: t.snippet || '',
    };
  });
}

function collectAttachments(part, found) {
  if (!part) return;
  if (part.filename && part.body?.attachmentId) {
    const disposition = (part.headers || [])
      .find((h) => h.name.toLowerCase() === 'content-disposition')?.value || '';
    found.push({
      attachmentId: part.body.attachmentId,
      filename: part.filename,
      mimeType: part.mimeType || 'application/octet-stream',
      size: part.body.size || 0,
      inline: /^\s*inline/i.test(disposition),
    });
  }
  for (const child of part.parts || []) collectAttachments(child, found);
}

async function getThread(input) {
  let id = parseThreadInput(input);
  let res;
  try {
    res = await gmail().users.threads.get({ userId: 'me', id, format: 'full' });
  } catch (err) {
    // The id may be a message id (links to a reply mid-thread) — resolve it
    // to its thread.
    if (err?.code !== 404 && err?.response?.status !== 404) throw err;
    const msg = await gmail().users.messages.get({ userId: 'me', id, format: 'minimal' });
    id = msg.data.threadId;
    res = await gmail().users.threads.get({ userId: 'me', id, format: 'full' });
  }
  const messages = (res.data.messages || []).map((m) => {
    const attachments = [];
    collectAttachments(m.payload, attachments);
    return {
      id: m.id,
      from: header(m, 'From'),
      date: Number(m.internalDate) || null,
      attachments,
    };
  });
  const subject = messages.length
    ? header(res.data.messages[0], 'Subject') || '(no subject)'
    : '(no subject)';
  return { id: res.data.id, subject, messages };
}

async function fetchAttachment(messageId, attachmentId) {
  const res = await gmail().users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });
  return Buffer.from(res.data.data, 'base64url');
}

module.exports = { searchThreads, getThread, fetchAttachment, parseThreadInput };
