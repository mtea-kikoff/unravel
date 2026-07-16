/* global unravel */
const $ = (id) => document.getElementById(id);

const views = { setup: $('view-setup'), connect: $('view-connect'), main: $('view-main') };
let currentThread = null;
let lastResults = [];
let busy = false;

// ---------- helpers ----------

function show(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

function fmtSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function fmtDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
    year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}

function senderName(from) {
  const m = from.match(/^"?([^"<]+)"?\s*</);
  return (m ? m[1] : from).trim();
}

function setStatus(text, isError = false) {
  const el = $('status-line');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('error', isError);
}

let toastTimer = null;
function toast(text, { error = false, action = null } = {}) {
  const el = $('toast');
  $('toast-text').textContent = text;
  el.classList.toggle('error', error);
  const btn = $('toast-action');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = action.onClick;
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 10000 : 5000);
}

function errMessage(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ---------- boot ----------

async function boot() {
  const state = await unravel.getState();
  $('account').hidden = !state.connected;
  if (state.connected) {
    $('account-email').textContent = state.email || '';
    show('main');
    $('input-search').focus();
  } else if (state.hasCredentials) {
    show('connect');
  } else {
    show('setup');
  }
}

// ---------- setup & connect ----------

$('form-credentials').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await unravel.saveCredentials({
      clientId: $('input-client-id').value,
      clientSecret: $('input-client-secret').value,
    });
    show('connect');
  } catch (err) {
    toast(errMessage(err), { error: true });
  }
});

$('btn-connect').addEventListener('click', async () => {
  const btn = $('btn-connect');
  btn.disabled = true;
  btn.textContent = 'Waiting for Google…';
  try {
    const { email } = await unravel.connect();
    $('account').hidden = false;
    $('account-email').textContent = email;
    show('main');
    $('input-search').focus();
  } catch (err) {
    toast(errMessage(err), { error: true });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect Gmail';
  }
});

$('btn-edit-credentials').addEventListener('click', () => show('setup'));

$('btn-disconnect').addEventListener('click', async () => {
  await unravel.disconnect();
  $('account').hidden = true;
  closeThread();
  $('results').hidden = true;
  show('connect');
});

document.querySelectorAll('[data-open]').forEach((el) =>
  el.addEventListener('click', () => unravel.openExternal(el.dataset.open))
);

// ---------- search ----------

$('form-search').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  const q = $('input-search').value.trim();
  closeThread();

  // A pasted link or ID opens the thread directly.
  if (q.includes('mail.google.com') || /^[0-9a-f]{12,20}$/i.test(q) || q.includes('thread-f:')) {
    return openThread(q);
  }

  busy = true;
  setStatus('Searching…');
  $('results').hidden = true;
  try {
    lastResults = await unravel.search(q);
    renderResults();
    setStatus(lastResults.length ? '' : 'No threads matched. Try a broader search.');
  } catch (err) {
    setStatus(errMessage(err), true);
  } finally {
    busy = false;
  }
});

function renderResults() {
  const box = $('results');
  box.innerHTML = '';
  for (const r of lastResults) {
    const btn = document.createElement('button');
    btn.className = 'result';
    btn.innerHTML = `
      <div class="subject"></div>
      <div class="meta">
        <span class="senders"></span>
        <span>·</span><span class="count"></span>
        <span>·</span><span class="date"></span>
      </div>
      <div class="snippet"></div>`;
    btn.querySelector('.subject').textContent = r.subject;
    btn.querySelector('.senders').textContent = r.senders.slice(0, 3).join(', ') + (r.senders.length > 3 ? '…' : '');
    btn.querySelector('.count').textContent = `${r.messageCount} message${r.messageCount === 1 ? '' : 's'}`;
    btn.querySelector('.date').textContent = fmtDate(r.date);
    btn.querySelector('.snippet').textContent = r.snippet;
    btn.addEventListener('click', () => openThread(r.id));
    box.appendChild(btn);
  }
  box.hidden = lastResults.length === 0;
}

// ---------- thread ----------

async function openThread(input) {
  if (busy) return;
  busy = true;
  setStatus('Opening thread…');
  try {
    currentThread = await unravel.getThread(input);
    setStatus('');
    renderThread();
  } catch (err) {
    setStatus(errMessage(err), true);
  } finally {
    busy = false;
  }
}

function closeThread() {
  currentThread = null;
  $('thread').hidden = true;
  $('actionbar').hidden = true;
  $('results').hidden = lastResults.length === 0;
  setStatus('');
}

$('btn-back').addEventListener('click', closeThread);

function renderThread() {
  $('results').hidden = true;
  $('thread').hidden = false;
  $('btn-back').hidden = lastResults.length === 0;
  $('thread-subject').textContent = currentThread.subject;

  const box = $('thread-messages');
  box.innerHTML = '';

  for (const msg of currentThread.messages) {
    const div = document.createElement('div');
    div.className = 'message';
    const head = document.createElement('div');
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = senderName(msg.from);
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = fmtDate(msg.date);
    head.append(who, when);
    div.appendChild(head);

    if (msg.attachments.length === 0) {
      const none = document.createElement('p');
      none.className = 'none';
      none.textContent = 'No attachments';
      div.appendChild(none);
    }

    for (const att of msg.attachments) {
      const row = document.createElement('label');
      row.className = 'file';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = !att.inline;
      check.dataset.messageId = msg.id;
      check.dataset.attachmentId = att.attachmentId;
      check.dataset.filename = att.filename;
      check.dataset.size = att.size;
      check.addEventListener('change', updateTally);
      const name = document.createElement('span');
      name.className = 'fname';
      name.textContent = att.filename;
      name.title = att.filename;
      const size = document.createElement('span');
      size.className = 'fsize';
      size.textContent = fmtSize(att.size);
      row.append(check, name, size);
      if (att.inline) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'inline';
        tag.title = 'Embedded in the message body (a signature image, usually)';
        row.appendChild(tag);
      }
      div.appendChild(row);
    }
    box.appendChild(div);
  }

  updateTally();
}

function selectedFiles() {
  return [...document.querySelectorAll('#thread-messages input[type=checkbox]:checked')].map((c) => ({
    messageId: c.dataset.messageId,
    attachmentId: c.dataset.attachmentId,
    filename: c.dataset.filename,
    size: Number(c.dataset.size),
  }));
}

function updateTally() {
  const files = selectedFiles();
  const total = document.querySelectorAll('#thread-messages input[type=checkbox]').length;
  if (total === 0) {
    $('actionbar').hidden = true;
    toast('This thread has no attachments.', { error: true });
    return;
  }
  $('actionbar').hidden = false;
  $('tally').innerHTML = '';
  const strong = document.createElement('span');
  strong.textContent = `${files.length} of ${total} file${total === 1 ? '' : 's'}`;
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = fmtSize(files.reduce((a, f) => a + f.size, 0));
  $('tally').append(strong, sub);
  $('btn-download').disabled = files.length === 0;
}

// ---------- download ----------

unravel.onZipProgress(({ done, total, filename }) => {
  $('progress-fill').style.width = `${Math.round((done / total) * 100)}%`;
  $('progress-label').textContent = `${done}/${total} · ${filename}`;
});

$('btn-download').addEventListener('click', async () => {
  if (busy || !currentThread) return;
  const items = selectedFiles();
  if (!items.length) return;

  busy = true;
  const btn = $('btn-download');
  btn.disabled = true;
  btn.textContent = 'Pulling files…';
  $('progress').hidden = false;
  $('progress-fill').style.width = '0%';
  $('progress-label').textContent = `0/${items.length}`;

  try {
    const result = await unravel.downloadZip({ subject: currentThread.subject, items });
    if (!result.canceled) {
      toast(`Saved ${result.count} file${result.count === 1 ? '' : 's'} (${fmtSize(result.bytes)})`, {
        action: { label: 'Show in Finder', onClick: () => unravel.reveal(result.path) },
      });
    }
  } catch (err) {
    toast(errMessage(err), { error: true });
  } finally {
    busy = false;
    btn.disabled = false;
    btn.textContent = 'Download .zip';
    $('progress').hidden = true;
  }
});

boot();
