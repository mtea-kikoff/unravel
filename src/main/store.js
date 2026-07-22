const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { bundledCredentials } = require('./credentials');

function file(name) {
  return path.join(app.getPath('userData'), name);
}

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function getSettings() {
  return readJSON(file('settings.json')) || {};
}

function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  fs.writeFileSync(file('settings.json'), JSON.stringify(next, null, 2));
  return next;
}

// Effective OAuth credentials: a user's own pasted client always wins;
// otherwise the shared client baked into the build (if any).
function getCredentials() {
  const s = getSettings();
  if (s.clientId && s.clientSecret) {
    return { clientId: s.clientId, clientSecret: s.clientSecret, source: 'user' };
  }
  const bundled = bundledCredentials();
  return bundled ? { ...bundled, source: 'bundled' } : null;
}

// Tokens are encrypted with the OS keychain when available (tokens.bin),
// otherwise stored as plain JSON (tokens.json).
const ENC = () => file('tokens.bin');
const PLAIN = () => file('tokens.json');

function saveTokens(tokens) {
  const json = JSON.stringify(tokens);
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(ENC(), safeStorage.encryptString(json));
    fs.rmSync(PLAIN(), { force: true });
  } else {
    fs.writeFileSync(PLAIN(), json);
  }
}

function loadTokens() {
  try {
    if (fs.existsSync(ENC()) && safeStorage.isEncryptionAvailable()) {
      return JSON.parse(safeStorage.decryptString(fs.readFileSync(ENC())));
    }
    return readJSON(PLAIN());
  } catch {
    return null;
  }
}

function clearTokens() {
  fs.rmSync(ENC(), { force: true });
  fs.rmSync(PLAIN(), { force: true });
}

module.exports = {
  getSettings,
  saveSettings,
  getCredentials,
  saveTokens,
  loadTokens,
  clearTokens,
};
