const { shell } = require('electron');
const { google } = require('googleapis');
const http = require('http');
const crypto = require('crypto');
const store = require('./store');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

let cachedClient = null;

function hasCredentials() {
  return Boolean(store.getCredentials());
}

function status() {
  const s = store.getSettings();
  const creds = store.getCredentials();
  return {
    hasCredentials: Boolean(creds),
    // A build with a shared client baked in hides the per-user setup screen.
    managedCredentials: creds?.source === 'bundled',
    connected: Boolean(store.loadTokens()),
    email: s.email || null,
  };
}

function buildClient(redirectUri) {
  const creds = store.getCredentials();
  if (!creds) {
    throw new Error('Add your Google OAuth client ID and secret first.');
  }
  const client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, redirectUri);
  client.on('tokens', (tokens) => {
    const prev = store.loadTokens() || {};
    store.saveTokens({ ...prev, ...tokens });
  });
  return client;
}

function getAuthedClient() {
  if (cachedClient) return cachedClient;
  const tokens = store.loadTokens();
  if (!tokens) throw new Error('Not connected to Gmail.');
  const client = buildClient();
  client.setCredentials(tokens);
  cachedClient = client;
  return client;
}

const LANDING_PAGE = `<!doctype html><meta charset="utf-8">
<title>Unravel</title>
<body style="font-family:-apple-system,system-ui,sans-serif;background:#f7f6f2;color:#1f2126;
display:grid;place-items:center;height:96vh;margin:0">
<div style="text-align:center">
<div style="font-size:40px;margin-bottom:12px">&#129525;</div>
<h1 style="font-size:22px;margin:0 0 6px">Gmail connected</h1>
<p style="color:#6c6f76;margin:0">You can close this tab and return to Unravel.</p>
</div></body>`;

function connect() {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');
    const server = http.createServer();
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn(arg);
    };

    const timer = setTimeout(
      () => finish(reject, new Error('Sign-in timed out. Try connecting again.')),
      AUTH_TIMEOUT_MS
    );

    server.on('error', (err) => finish(reject, err));
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
      let client;
      try {
        client = buildClient(redirectUri);
      } catch (err) {
        return finish(reject, err);
      }

      server.on('request', async (req, res) => {
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        if (url.pathname !== '/oauth2callback') {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(LANDING_PAGE);

        try {
          if (url.searchParams.get('state') !== state) {
            throw new Error('Sign-in state mismatch. Try connecting again.');
          }
          const error = url.searchParams.get('error');
          if (error) throw new Error(`Google refused the sign-in: ${error}`);
          const code = url.searchParams.get('code');
          if (!code) throw new Error('Google did not return a sign-in code.');

          const { tokens } = await client.getToken(code);
          client.setCredentials(tokens);
          store.saveTokens(tokens);
          cachedClient = client;

          const gmail = google.gmail({ version: 'v1', auth: client });
          const profile = await gmail.users.getProfile({ userId: 'me' });
          const email = profile.data.emailAddress;
          store.saveSettings({ email });
          finish(resolve, { email });
        } catch (err) {
          finish(reject, err);
        }
      });

      const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
        state,
      });
      shell.openExternal(authUrl);
    });
  });
}

async function disconnect() {
  const tokens = store.loadTokens();
  if (tokens) {
    try {
      const client = buildClient();
      await client.revokeToken(tokens.refresh_token || tokens.access_token);
    } catch {
      // Best effort — clear local state regardless.
    }
  }
  store.clearTokens();
  store.saveSettings({ email: null });
  cachedClient = null;
}

module.exports = { status, hasCredentials, connect, disconnect, getAuthedClient };
