// Linked files: URLs in message bodies that lead to files (Drive, Dropbox,
// OneDrive/SharePoint, or direct file URLs). Where possible they're resolved
// to real names/sizes at thread-load time and downloaded straight into the
// zip; anything unresolvable falls back to an open-in-browser row.
const { google } = require('googleapis');
const auth = require('./auth');

const MAX_LINK_FILE_BYTES = 500 * 1024 * 1024;

// Document-ish extensions only — hyperlinked images/video in email bodies are
// almost always decoration, not content.
const DIRECT_EXT_RE = /\.(pptx?|pdf|docx?|xlsx?|csv|zip|key|numbers|pages|txt)$/i;

const GOOGLE_EXPORT = {
  'application/vnd.google-apps.document': {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: '.docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: '.xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ext: '.pptx',
  },
  'application/vnd.google-apps.drawing': { mime: 'application/pdf', ext: '.pdf' },
};

function drive() {
  return google.drive({ version: 'v3', auth: auth.getAuthedClient() });
}

// --- extraction ---

function extractUrls(html, text) {
  const urls = new Set();
  for (const m of (html || '').matchAll(/href="([^"]+)"/gi)) {
    urls.add(m[1].replace(/&amp;/g, '&'));
  }
  for (const m of (text || '').matchAll(/https?:\/\/[^\s"'<>\[\]]+/g)) {
    urls.add(m[0].replace(/[.,;:!?)]+$/, ''));
  }
  return [...urls];
}

function classify(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

  const drivePatterns = [
    /drive\.google\.com\/file\/d\/([\w-]{20,})/,
    /drive\.google\.com\/open\?id=([\w-]{20,})/,
    /docs\.google\.com\/(?:document|spreadsheets|presentation|drawings)\/d\/([\w-]{20,})/,
  ];
  for (const re of drivePatterns) {
    const m = url.match(re);
    if (m) return { kind: 'link', source: 'drive', url, fileId: m[1], key: `drive:${m[1]}` };
  }

  if (/(?:www\.)?dropbox\.com\/(?:s|scl\/fi)\//.test(url)) {
    return { kind: 'link', source: 'dropbox', url, key: `url:${u.origin}${u.pathname}` };
  }

  if (/1drv\.ms\/|\.sharepoint\.com\//i.test(url)) {
    if (!DIRECT_EXT_RE.test(u.pathname) && !/1drv\.ms/.test(u.hostname)) return null;
    return { kind: 'link', source: 'onedrive', url, key: `url:${u.origin}${u.pathname}` };
  }

  if (DIRECT_EXT_RE.test(u.pathname)) {
    return { kind: 'link', source: 'direct', url, key: `url:${u.origin}${u.pathname}` };
  }

  return null;
}

function findLinks(html, text) {
  const found = [];
  const seen = new Set();
  for (const url of extractUrls(html, text)) {
    const link = classify(url);
    if (link && !seen.has(link.key)) {
      seen.add(link.key);
      found.push(link);
    }
  }
  return found;
}

// --- metadata resolution (thread-load time) ---

function nameFromUrl(url) {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    return decodeURIComponent(segs[segs.length - 1] || 'linked file');
  } catch {
    return 'linked file';
  }
}

async function headRequest(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        redirect: 'follow',
        signal: controller.signal,
      });
      res.body?.cancel?.();
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function dropboxDirectUrl(url) {
  const u = new URL(url);
  u.searchParams.set('dl', '1');
  return u.toString();
}

function filenameFromDisposition(res) {
  const cd = res.headers.get('content-disposition') || '';
  const star = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].replace(/"/g, '').trim());
    } catch {}
  }
  const plain = cd.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

async function resolveDrive(link) {
  try {
    const res = await drive().files.get({
      fileId: link.fileId,
      fields: 'name, size, mimeType',
      supportsAllDrives: true,
    });
    const { name, size, mimeType } = res.data;
    const exp = GOOGLE_EXPORT[mimeType];
    if (exp) {
      return {
        ...link,
        downloadable: true,
        filename: name + exp.ext,
        size: null,
        exportMime: exp.mime,
      };
    }
    if (mimeType?.startsWith('application/vnd.google-apps')) {
      return { ...link, downloadable: false, filename: name, reason: 'This Google file type has no downloadable format.' };
    }
    return { ...link, downloadable: true, filename: name, size: Number(size) || null };
  } catch (err) {
    const msg = String(err?.message || '');
    const insufficient = err?.code === 403 && /insufficient|scope/i.test(msg);
    return {
      ...link,
      downloadable: false,
      filename: 'Google Drive file',
      reason: insufficient
        ? 'Drive access not granted yet — disconnect and reconnect Gmail to enable Drive downloads.'
        : "You don't have access to this Drive file (or it was deleted).",
    };
  }
}

async function resolveHttp(link) {
  const fetchUrl = link.source === 'dropbox' ? dropboxDirectUrl(link.url) : link.url;
  const fallbackName = nameFromUrl(link.url);
  try {
    const res = await headRequest(fetchUrl);
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok || type.includes('text/html')) {
      return { ...link, downloadable: false, filename: fallbackName, reason: 'This link needs a browser sign-in to download.' };
    }
    const len = Number(res.headers.get('content-length')) || null;
    return {
      ...link,
      downloadable: true,
      fetchUrl,
      filename: filenameFromDisposition(res) || fallbackName,
      size: len,
    };
  } catch {
    // Ambiguous (blocked HEAD, network hiccup) — try for real at zip time.
    return { ...link, downloadable: true, fetchUrl, filename: fallbackName, size: null };
  }
}

async function resolve(link) {
  const meta = link.source === 'drive' ? await resolveDrive(link) : await resolveHttp(link);
  return meta;
}

// --- download (zip / preview time) ---

async function download(item) {
  if (item.source === 'drive') {
    const params = item.exportMime
      ? drive().files.export(
          { fileId: item.fileId, mimeType: item.exportMime },
          { responseType: 'arraybuffer' }
        )
      : drive().files.get(
          { fileId: item.fileId, alt: 'media', supportsAllDrives: true },
          { responseType: 'arraybuffer' }
        );
    const res = await params;
    return Buffer.from(res.data);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(item.fetchUrl || item.url, {
      redirect: 'follow',
      signal: controller.signal,
    });
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok) throw new Error(`Link returned ${res.status} for ${item.filename}.`);
    if (type.includes('text/html')) {
      throw new Error(`${item.filename} needs a browser sign-in — open the link instead.`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_LINK_FILE_BYTES) throw new Error(`${item.filename} is too large to zip.`);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { findLinks, resolve, download };
