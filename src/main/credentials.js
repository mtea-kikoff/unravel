const fs = require('fs');
const path = require('path');

// A shared OAuth client can be baked into the build so coworkers connect
// without any Google Cloud setup. It's read from default-credentials.json at
// the app root (gitignored, bundled into the .app at package time). Absent in
// a plain dev checkout, in which case the app falls back to per-user setup.
let bundled = null;
try {
  const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'default-credentials.json'), 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed && parsed.clientId && parsed.clientSecret) {
    bundled = { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
  }
} catch {
  bundled = null;
}

function bundledCredentials() {
  return bundled;
}

module.exports = { bundledCredentials };
