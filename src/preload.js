const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('unravel', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveCredentials: (creds) => ipcRenderer.invoke('credentials:save', creds),
  connect: () => ipcRenderer.invoke('auth:connect'),
  disconnect: () => ipcRenderer.invoke('auth:disconnect'),
  search: (query) => ipcRenderer.invoke('gmail:search', query),
  getThread: (input) => ipcRenderer.invoke('gmail:thread', input),
  extractReview: (input) => ipcRenderer.invoke('review:extract', input),
  extractReviews: (inputs) => ipcRenderer.invoke('review:extractMulti', inputs),
  renderReview: (payload) => ipcRenderer.invoke('review:render', payload),
  renderReviewMulti: (payload) => ipcRenderer.invoke('review:renderMulti', payload),
  copyText: (text) => ipcRenderer.invoke('review:copy', text),
  markSeen: (entries) => ipcRenderer.invoke('review:markSeen', entries),
  saveReview: (payload) => ipcRenderer.invoke('review:save', payload),
  downloadZip: (payload) => ipcRenderer.invoke('zip:download', payload),
  preview: (payload) => ipcRenderer.invoke('attachment:preview', payload),
  reveal: (path) => ipcRenderer.invoke('shell:reveal', path),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  onZipProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('zip:progress', listener);
    return () => ipcRenderer.removeListener('zip:progress', listener);
  },
});
