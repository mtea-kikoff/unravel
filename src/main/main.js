const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const store = require('./store');
const auth = require('./auth');
const gmail = require('./gmail');
const links = require('./links');

function fetchItem(item) {
  if (item.kind === 'link') return links.download(item);
  return gmail.fetchAttachment(item.messageId, item.attachmentId);
}

function itemKey(item) {
  return item.kind === 'link' ? item.key : `${item.messageId}:${item.attachmentId}`;
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 780,
    height: 840,
    minWidth: 560,
    minHeight: 620,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#f7f6f2',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function sanitizeFilename(name) {
  const cleaned = String(name)
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_")
    .replace(/^\.+/, '_')
    .trim();
  return cleaned || 'attachment';
}

function dedupeName(name, taken) {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
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

function registerIpc() {
  ipcMain.handle('state:get', () => auth.status());

  ipcMain.handle('credentials:save', (_e, { clientId, clientSecret }) => {
    if (!clientId?.trim() || !clientSecret?.trim()) {
      throw new Error('Both the client ID and client secret are needed.');
    }
    store.saveSettings({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
    return auth.status();
  });

  ipcMain.handle('auth:connect', () => auth.connect());
  ipcMain.handle('auth:disconnect', () => auth.disconnect());

  ipcMain.handle('gmail:search', (_e, query) => gmail.searchThreads(query));
  ipcMain.handle('gmail:thread', (_e, input) => gmail.getThread(input));

  ipcMain.handle('zip:download', async (_e, { subject, items }) => {
    if (!items?.length) throw new Error('No attachments selected.');

    const defaultName = `${sanitizeFilename(subject || 'attachments').slice(0, 80)}.zip`;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save attachments',
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      filters: [{ name: 'Zip archive', extensions: ['zip'] }],
    });
    if (canceled || !filePath) return { canceled: true };

    const zip = new AdmZip();
    const taken = new Set();
    let done = 0;
    let bytes = 0;

    // Fetch in parallel but add to the zip in thread order so the archive
    // reads top-to-bottom like the conversation did. A linked file that
    // fails (revoked share, login wall) doesn't sink the rest of the zip.
    const failed = [];
    const buffers = await mapWithConcurrency(items, 4, async (item) => {
      try {
        return await fetchItem(item);
      } catch (err) {
        failed.push(item.filename);
        return null;
      } finally {
        done += 1;
        win?.webContents.send('zip:progress', { done, total: items.length, filename: item.filename });
      }
    });

    // Byte-identical files (re-attached in replies, repeated signature
    // images) are zipped once; only genuinely different content gets the
    // "name (2).ext" treatment.
    const seenHashes = new Set();
    let skipped = 0;
    buffers.forEach((buf, i) => {
      if (!buf) return;
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      if (seenHashes.has(hash)) {
        skipped += 1;
        return;
      }
      seenHashes.add(hash);
      const name = dedupeName(sanitizeFilename(items[i].filename), taken);
      zip.addFile(name, buf);
      bytes += buf.length;
    });

    zip.writeZip(filePath);
    return {
      canceled: false,
      path: filePath,
      count: items.length - skipped - failed.length,
      skipped,
      failed,
      bytes,
    };
  });

  // Quick Look preview: fetch the attachment once into a temp cache, then
  // hand it to the native preview panel (space-bar-in-Finder experience).
  const PREVIEW_DIR = path.join(os.tmpdir(), 'unravel-previews');
  ipcMain.handle('attachment:preview', async (_e, item) => {
    const key = crypto.createHash('sha1').update(itemKey(item)).digest('hex').slice(0, 12);
    const dir = path.join(PREVIEW_DIR, key);
    const file = path.join(dir, sanitizeFilename(item.filename));
    if (!fs.existsSync(file)) {
      const buf = await fetchItem(item);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, buf);
    }
    win?.previewFile(file, item.filename);
  });
  app.on('will-quit', () => fs.rmSync(PREVIEW_DIR, { recursive: true, force: true }));

  ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));

  ipcMain.handle('shell:open', (_e, url) => {
    if (/^https:\/\/(console\.cloud\.google\.com|developers\.google\.com)\//.test(url)) {
      return shell.openExternal(url);
    }
    throw new Error('Blocked external URL.');
  });

  // Linked files that can't be downloaded open in the browser instead.
  ipcMain.handle('link:open', (_e, url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Blocked external URL.');
    }
    return shell.openExternal(parsed.toString());
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
