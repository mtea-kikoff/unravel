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
  // With a shared client baked in, coworkers never touch OAuth setup.
  $('btn-edit-credentials').hidden = state.managedCredentials;
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

  // One or more pasted links/IDs (whitespace-, comma-, or newline-separated).
  const links = extractLinkTokens(q);
  if (links.length >= 2) {
    return openReviews(links);
  }
  if (links.length === 1) {
    return openThread(links[0]);
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
  currentReview = null;
  $('thread').hidden = true;
  $('actionbar').hidden = true;
  $('review').hidden = true;
  $('review-actionbar').hidden = true;
  $('results').hidden = lastResults.length === 0;
  setStatus('');
}

$('btn-back').addEventListener('click', closeThread);

function setAllChecked(checked) {
  document
    .querySelectorAll('#thread-messages input[type=checkbox]')
    .forEach((c) => { c.checked = checked; });
  updateTally();
}
$('btn-select-all').addEventListener('click', () => setAllChecked(true));
$('btn-deselect-all').addEventListener('click', () => setAllChecked(false));

// ---------- review extraction (GitHub PR threads) ----------

let currentReview = null;

function isLinkLike(s) {
  return (
    s.includes('mail.google.com') ||
    /^[0-9a-f]{12,20}$/i.test(s) ||
    s.includes('thread-f:') ||
    /^[BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz]{32,}$/.test(s)
  );
}

// Pull the link/ID tokens out of an input that may hold several, separated by
// whitespace, newlines, or commas.
function extractLinkTokens(q) {
  return q.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s && isLinkLike(s));
}

// Extract and consolidate several PR threads at once.
async function openReviews(links) {
  if (busy) return;
  busy = true;
  setStatus(`Reading ${links.length} threads…`);
  try {
    currentReview = await unravel.extractReviews(links);
    currentReview.multi = true;
    setStatus('');
    renderReview();
  } catch (err) {
    setStatus(errMessage(err), true);
  } finally {
    busy = false;
  }
}

$('btn-extract').addEventListener('click', async () => {
  if (busy || !currentThread) return;
  busy = true;
  const btn = $('btn-extract');
  btn.disabled = true;
  btn.textContent = 'Reading the thread…';
  try {
    currentReview = await unravel.extractReview(currentThread.id);
    renderReview();
  } catch (err) {
    toast(errMessage(err), { error: true });
  } finally {
    busy = false;
    btn.disabled = false;
    btn.textContent = 'Extract recommended changes';
  }
});

$('btn-review-back').addEventListener('click', () => {
  $('review').hidden = true;
  $('review-actionbar').hidden = true;
  // Single-thread review returns to the thread; a multi-PR run has no single
  // thread behind it, so return to the results/search state.
  if (currentReview && !currentReview.multi && currentThread) renderThread();
  else closeThread();
});

function reviewSelectAll(checked) {
  document
    .querySelectorAll('#review-findings input[type=checkbox]')
    .forEach((c) => { c.checked = checked; });
  updateReviewTally();
}
$('btn-review-all').addEventListener('click', () => reviewSelectAll(true));
$('btn-review-none').addEventListener('click', () => reviewSelectAll(false));

function fileHeader(text) {
  const h = document.createElement('div');
  h.className = 'review-file';
  h.textContent = text;
  return h;
}

function buildFindingRow(f, { showPr = false } = {}) {
  const row = document.createElement('div');
  row.className = 'finding';

  const top = document.createElement('label');
  top.className = 'finding-head';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = true;
  check.dataset.id = f.uid || f.dedupeId;
  check.addEventListener('change', updateReviewTally);
  const badge = document.createElement('span');
  badge.className = `sev sev-${(f.severity || 'other').toLowerCase()}`;
  badge.textContent = f.severity || '—';
  const title = document.createElement('span');
  title.className = 'finding-title';
  title.textContent = f.title;
  const meta = document.createElement('span');
  meta.className = 'finding-meta';
  const loc = f.lineStart ? `:${f.lineStart}${f.lineEnd && f.lineEnd !== f.lineStart ? `–${f.lineEnd}` : ''}` : '';
  const pr = showPr && f.prNumber ? `PR #${f.prNumber} · ` : '';
  const when = f.date ? ` · ${fmtDate(f.date)}` : '';
  meta.textContent = `${pr}${f.reviewer}${loc}${when}`;
  meta.title = f.date ? new Date(f.date).toLocaleString() : '';
  top.append(check, badge, title, meta);
  row.appendChild(top);

  if (f.description || f.agentPrompt || f.suggestion) {
    const body = document.createElement('div');
    body.className = 'finding-body';
    if (f.description) {
      const p = document.createElement('p');
      p.textContent = f.description;
      body.appendChild(p);
    }
    if (f.suggestion) body.appendChild(codeBlock('Suggested change', f.suggestion));
    if (f.agentPrompt) body.appendChild(codeBlock('Fix instruction', f.agentPrompt));
    row.appendChild(body);
  }
  return row;
}

function groupByFile(findings) {
  const byFile = new Map();
  for (const f of findings) {
    const k = f.file || '(no file)';
    if (!byFile.has(k)) byFile.set(k, []);
    byFile.get(k).push(f);
  }
  return byFile;
}

function renderReview() {
  $('thread').hidden = true;
  $('actionbar').hidden = true;
  $('review').hidden = false;
  $('review-actionbar').hidden = false;

  const multi = currentReview.multi;
  const s = currentReview.stats;
  const box = $('review-findings');
  box.innerHTML = '';

  if (multi) {
    const okPrs = currentReview.prs.filter((p) => p.ok && p.isPullRequest);
    $('review-title').textContent = `${okPrs.length} PR${okPrs.length === 1 ? '' : 's'} · ${s.total} recommended change${s.total === 1 ? '' : 's'}`;
    // Surface anything that couldn't contribute.
    const skipped = currentReview.prs.filter((p) => !p.ok || !p.isPullRequest);
    if (skipped.length) {
      const note = document.createElement('p');
      note.className = 'review-note';
      note.textContent =
        'Skipped: ' +
        skipped
          .map((p) => (!p.ok ? `a link (${p.error})` : `“${(p.subject || p.input).slice(0, 40)}” (not a PR thread)`))
          .join('; ');
      box.appendChild(note);
    }
  } else {
    $('review-title').textContent = `PR #${currentReview.prNumber} · ${s.total} recommended change${s.total === 1 ? '' : 's'}`;
  }

  if (!s.total) {
    const empty = document.createElement('p');
    empty.className = 'none';
    empty.textContent = 'No recommended changes found.';
    box.appendChild(empty);
    $('review-actionbar').hidden = true;
    return;
  }

  if (multi) {
    const okPrs = currentReview.prs.filter((p) => p.ok && p.isPullRequest);
    for (const pr of okPrs) {
      const prFindings = currentReview.findings.filter(
        (f) => f.prNumber === pr.prNumber && f.repo === pr.repo
      );
      if (!prFindings.length) continue;
      const prHead = document.createElement('div');
      prHead.className = 'review-pr';
      prHead.textContent = `PR #${pr.prNumber}${pr.repo ? ` — ${pr.repo}` : ''}`;
      box.appendChild(prHead);
      for (const [file, group] of groupByFile(prFindings)) {
        box.appendChild(fileHeader(file));
        for (const f of group) box.appendChild(buildFindingRow(f, { showPr: true }));
      }
    }
  } else {
    for (const [file, group] of groupByFile(currentReview.findings)) {
      box.appendChild(fileHeader(file));
      for (const f of group) box.appendChild(buildFindingRow(f));
    }
  }
  updateReviewTally();
}

function codeBlock(label, text) {
  const wrap = document.createElement('div');
  wrap.className = 'finding-code';
  const l = document.createElement('span');
  l.className = 'finding-code-label';
  l.textContent = label;
  const pre = document.createElement('pre');
  pre.textContent = text;
  wrap.append(l, pre);
  return wrap;
}

function selectedReviewIds() {
  return [...document.querySelectorAll('#review-findings input[type=checkbox]:checked')].map(
    (c) => c.dataset.id
  );
}

function updateReviewTally() {
  const n = selectedReviewIds().length;
  const total = currentReview.stats.total;
  $('review-tally').innerHTML = '';
  const strong = document.createElement('span');
  strong.textContent = `${n} of ${total} selected`;
  $('review-tally').appendChild(strong);
  $('btn-review-copy').disabled = n === 0;
  $('btn-review-save').disabled = n === 0;
}

async function renderSelectedMarkdown() {
  const selectedIds = selectedReviewIds();
  if (currentReview.multi) {
    return unravel.renderReviewMulti({
      prs: currentReview.prs,
      findings: currentReview.findings,
      selectedIds,
    });
  }
  return unravel.renderReview({
    repo: currentReview.repo,
    prNumber: currentReview.prNumber,
    findings: currentReview.findings,
    events: currentReview.events,
    selectedIds,
  });
}

$('btn-review-copy').addEventListener('click', async () => {
  try {
    const md = await renderSelectedMarkdown();
    await unravel.copyText(md);
    toast('Copied — paste it to your coding agent.');
  } catch (err) {
    toast(errMessage(err), { error: true });
  }
});

$('btn-review-save').addEventListener('click', async () => {
  try {
    const md = await renderSelectedMarkdown();
    const result = await unravel.saveReview({
      markdown: md,
      prNumber: currentReview.multi ? 'consolidated' : currentReview.prNumber,
    });
    if (!result.canceled) {
      toast('Saved recommended changes', {
        action: { label: 'Show in Finder', onClick: () => unravel.reveal(result.path) },
      });
    }
  } catch (err) {
    toast(errMessage(err), { error: true });
  }
});

function renderThread() {
  $('results').hidden = true;
  $('thread').hidden = false;
  $('review').hidden = true;
  $('review-actionbar').hidden = true;
  $('btn-back').hidden = lastResults.length === 0;
  $('thread-subject').textContent = currentThread.subject;

  // Extract banner: only on GitHub threads. Active for a detected PR; greyed
  // out with a note for a GitHub thread that has nothing to extract. Normal
  // email threads never see it. Reset the button state on every render so a
  // prior "Reading the thread…" state can't linger.
  const banner = $('pr-banner');
  const extractBtn = $('btn-extract');
  extractBtn.textContent = 'Extract recommended changes';
  if (currentThread.isPullRequest) {
    banner.hidden = false;
    banner.classList.remove('pr-banner-off');
    extractBtn.disabled = false;
    $('pr-banner-text').textContent = `Pull request #${currentThread.prNumber} — pull every reviewer's recommended changes into one brief.`;
  } else if (currentThread.isGithub) {
    banner.hidden = false;
    banner.classList.add('pr-banner-off');
    extractBtn.disabled = true;
    $('pr-banner-text').textContent = 'No pull-request review comments to extract in this GitHub thread.';
  } else {
    banner.hidden = true;
  }

  const box = $('thread-messages');
  box.innerHTML = '';

  // Attachments repeating an earlier one's name and size are almost always
  // re-sends — show only the first copy.
  const seenFiles = new Set();

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

    if (msg.attachments.length === 0 && !(msg.linkedFiles || []).length) {
      const none = document.createElement('p');
      none.className = 'none';
      none.textContent = 'No attachments';
      div.appendChild(none);
    }

    for (const att of msg.attachments) {
      const fileKey = `${att.filename}|${att.size}`;
      if (seenFiles.has(fileKey)) continue;
      seenFiles.add(fileKey);
      div.appendChild(
        fileRow({
          item: {
            kind: 'gmail',
            messageId: msg.id,
            attachmentId: att.attachmentId,
            filename: att.filename,
            size: att.size,
          },
          tag: att.inline
            ? { text: 'inline', title: 'Embedded in the message body (a signature image, usually)' }
            : null,
        })
      );
    }

    for (const lf of msg.linkedFiles || []) {
      div.appendChild(
        fileRow({
          item: lf,
          tag: {
            text: { drive: 'Drive', dropbox: 'Dropbox', onedrive: 'OneDrive' }[lf.source] || 'link',
            title: lf.downloadable
              ? 'Linked in the message body — downloads into the zip like an attachment'
              : lf.reason || "This link can't be downloaded directly.",
          },
        })
      );
    }
    box.appendChild(div);
  }

  updateTally();
}

const EYE_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5c-3.2 0-5.6 2.7-6.6 4.1a.7.7 0 0 0 0 .8C2.4 9.8 4.8 12.5 8 12.5s5.6-2.7 6.6-4.1a.7.7 0 0 0 0-.8C13.6 6.2 11.2 3.5 8 3.5Z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
const ARROW_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5h7.5V11M12.5 3.5 3.5 12.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

// One row for any file — a real attachment or a downloadable linked file
// (both get a checkbox + Quick Look), or a non-downloadable link (opens in
// the browser instead).
function fileRow({ item, tag }) {
  const downloadable = item.kind !== 'link' || item.downloadable;
  const row = document.createElement(downloadable ? 'label' : 'div');
  row.className = 'file';

  if (downloadable) {
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = true;
    check.dataset.item = JSON.stringify(item);
    check.addEventListener('change', updateTally);
    row.appendChild(check);
  }

  const name = document.createElement('span');
  name.className = 'fname';
  name.textContent = item.filename;
  name.title = item.kind === 'link' ? `${item.filename}\n${item.url}` : item.filename;
  const size = document.createElement('span');
  size.className = 'fsize';
  size.textContent = fmtSize(item.size);
  row.append(name, size);

  if (tag) {
    const el = document.createElement('span');
    el.className = 'tag';
    el.textContent = tag.text;
    el.title = tag.title;
    row.appendChild(el);
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'peek';
  if (downloadable) {
    btn.title = 'Preview';
    btn.setAttribute('aria-label', `Preview ${item.filename}`);
    btn.innerHTML = EYE_SVG;
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.classList.contains('busy')) return;
      btn.classList.add('busy');
      try {
        await unravel.preview(item);
      } catch (err) {
        toast(errMessage(err), { error: true });
      } finally {
        btn.classList.remove('busy');
      }
    });
  } else {
    btn.title = 'Open in browser';
    btn.setAttribute('aria-label', `Open ${item.filename} in browser`);
    btn.innerHTML = ARROW_SVG;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      unravel.openLink(item.url).catch((err) => toast(errMessage(err), { error: true }));
    });
  }
  row.appendChild(btn);
  return row;
}

function selectedFiles() {
  return [...document.querySelectorAll('#thread-messages input[type=checkbox]:checked')].map((c) =>
    JSON.parse(c.dataset.item)
  );
}

function updateTally() {
  const files = selectedFiles();
  const total = document.querySelectorAll('#thread-messages input[type=checkbox]').length;
  if (total === 0) {
    $('actionbar').hidden = true;
    // A PR review thread legitimately has no attachments — the extract banner
    // is the point there, so don't nag.
    if (!currentThread?.isPullRequest) toast('This thread has no attachments.', { error: true });
    return;
  }
  $('actionbar').hidden = false;
  $('tally').innerHTML = '';
  const strong = document.createElement('span');
  strong.textContent = `${files.length} of ${total} file${total === 1 ? '' : 's'}`;
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = fmtSize(files.reduce((a, f) => a + (f.size || 0), 0));
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
      const extras = [];
      if (result.skipped) {
        extras.push(`skipped ${result.skipped} identical duplicate${result.skipped === 1 ? '' : 's'}`);
      }
      if (result.failed?.length) {
        extras.push(`couldn't fetch ${result.failed.join(', ')}`);
      }
      const suffix = extras.length ? ` — ${extras.join('; ')}` : '';
      toast(`Saved ${result.count} file${result.count === 1 ? '' : 's'} (${fmtSize(result.bytes)})${suffix}`, {
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
