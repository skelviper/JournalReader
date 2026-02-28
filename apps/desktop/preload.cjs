const { contextBridge, ipcRenderer } = require('electron');

const api = {
  docPick: () => ipcRenderer.invoke('doc.pick'),
  onMenuFileOpen: (handler) => {
    const listener = (_event, path) => handler(path);
    ipcRenderer.on('menu:file-open', listener);
    return () => {
      ipcRenderer.removeListener('menu:file-open', listener);
    };
  },
  onAnnotationChanged: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('annotation.changed', listener);
    return () => {
      ipcRenderer.removeListener('annotation.changed', listener);
    };
  },
  docOpen: (path) => ipcRenderer.invoke('doc.open', path),
  docParse: (docId) => ipcRenderer.invoke('doc.parse', docId),
  docReadBinary: (path) => ipcRenderer.invoke('doc.readBinary', path),
  citationResolve: (docId, page, x, y) => ipcRenderer.invoke('citation.resolve', docId, page, x, y),
  citationResolveByLabel: (docId, kind, label) => ipcRenderer.invoke('citation.resolveByLabel', docId, kind, label),
  referenceResolve: (docId, page, x, y) => ipcRenderer.invoke('reference.resolve', docId, page, x, y),
  referenceGetEntries: (docId, indices) => ipcRenderer.invoke('reference.getEntries', docId, indices),
  referenceHasEntries: (docId) => ipcRenderer.invoke('reference.hasEntries', docId),
  referenceOpenPopup: (payload) => ipcRenderer.invoke('reference.openPopup', payload),
  figureGetTarget: (docId, targetId) => ipcRenderer.invoke('figure.getTarget', docId, targetId),
  figureOpenPopup: (payload) => ipcRenderer.invoke('figure.openPopup', payload),
  annotationCreate: (payload) => ipcRenderer.invoke('annotation.create', payload),
  annotationUpdate: (payload) => ipcRenderer.invoke('annotation.update', payload),
  annotationDelete: (id) => ipcRenderer.invoke('annotation.delete', id),
  annotationList: (docId) => ipcRenderer.invoke('annotation.list', docId),
  annotationReloadFromPdf: (docId) => ipcRenderer.invoke('annotation.reloadFromPdf', docId),
  captionSyncHighlights: (payload) => ipcRenderer.invoke('caption.syncHighlights', payload),
  captionGetLinkedSnippets: (payload) => ipcRenderer.invoke('caption.getLinkedSnippets', payload),
  annotationSaveToPdf: (docId) => ipcRenderer.invoke('annotation.saveToPdf', docId),
  mappingBindManually: (docId, citationId, targetRect, captionText, targetPage) =>
    ipcRenderer.invoke('mapping.bindManually', docId, citationId, targetRect, captionText, targetPage),
};

contextBridge.exposeInMainWorld('journalApi', api);
