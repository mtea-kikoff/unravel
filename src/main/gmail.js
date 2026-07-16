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

// Accepts a bare hex thread id, a "thread-f:12345" id, or a Gmail URL whose
// last segment is a legacy hex id. New-style Gmail URL tokens (FMfcg…) are a
// proprietary encoding the API can't look up — steer those users to search.
function parseThreadInput(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('Paste a thread link or ID, or search your mail below.');

  if (/^[0-9a-fA-F]{12,20}$/.test(s)) return s.toLowerCase();

  const legacy = s.match(/thread-f:(\d+)/);
  if (legacy) return BigInt(legacy[1]).toString(16);

  if (s.includes('mail.google.com')) {
    const tail = s.split(/[/#]/).filter(Boolean).pop() || '';
    if (/^[0-9a-fA-F]{12,20}$/.test(tail)) return tail.toLowerCase();
    throw new Error(
      "This Gmail link uses Google's new URL format, which can't be looked up directly. Search for the thread below instead."
    );
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
  const id = parseThreadInput(input);
  const res = await gmail().users.threads.get({ userId: 'me', id, format: 'full' });
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
