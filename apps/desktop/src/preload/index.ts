import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { JournalApi } from "@journal-reader/types";

window.addEventListener(
  "wheel",
  (event) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
    }
  },
  { passive: false, capture: true },
);
window.addEventListener("gesturestart", (event) => event.preventDefault(), { passive: false });
window.addEventListener("gesturechange", (event) => event.preventDefault(), { passive: false });
window.addEventListener("gestureend", (event) => event.preventDefault(), { passive: false });

const api: JournalApi = {
  openExternal: (url) => ipcRenderer.invoke("app.openExternal", url),
  resolveDroppedFilePath: (file) => {
    try {
      const path = webUtils.getPathForFile(file);
      return path || null;
    } catch {
      return null;
    }
  },
  docPick: () => ipcRenderer.invoke("doc.pick"),
  onMenuFileOpen: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, path: string): void => {
      handler(path);
    };
    ipcRenderer.on("menu:file-open", listener);
    return () => {
      ipcRenderer.removeListener("menu:file-open", listener);
    };
  },
  onAnnotationChanged: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { docId: string; ts: number }): void => {
      handler(payload);
    };
    ipcRenderer.on("annotation.changed", listener);
    return () => {
      ipcRenderer.removeListener("annotation.changed", listener);
    };
  },
  docOpen: (path) => ipcRenderer.invoke("doc.open", path),
  docParse: (docId) => ipcRenderer.invoke("doc.parse", docId),
  docReadBinary: (path) => ipcRenderer.invoke("doc.readBinary", path),
  citationResolve: (docId, page, x, y) => ipcRenderer.invoke("citation.resolve", docId, page, x, y),
  citationResolveByLabel: (docId, kind, label) => ipcRenderer.invoke("citation.resolveByLabel", docId, kind, label),
  referenceResolve: (docId, page, x, y) => ipcRenderer.invoke("reference.resolve", docId, page, x, y),
  referenceGetEntries: (docId, indices) => ipcRenderer.invoke("reference.getEntries", docId, indices),
  referenceSearchByText: (docId, text, limit) => ipcRenderer.invoke("reference.searchByText", docId, text, limit),
  referenceHasEntries: (docId) => ipcRenderer.invoke("reference.hasEntries", docId),
  referenceOpenPopup: (payload) => ipcRenderer.invoke("reference.openPopup", payload),
  translateText: (payload) => ipcRenderer.invoke("translate.text", payload),
  translateOpenPopup: (payload) => ipcRenderer.invoke("translate.openPopup", payload),
  figureGetTarget: (docId, targetId) => ipcRenderer.invoke("figure.getTarget", docId, targetId),
  figureListTargets: (docId, kind, label) => ipcRenderer.invoke("figure.listTargets", docId, kind, label),
  figureOpenPopup: (payload) => ipcRenderer.invoke("figure.openPopup", payload),
  recognizedOpenPopup: async (docId, kind) => {
    try {
      const result = await ipcRenderer.invoke("recognized.openPopup", docId, kind);
      return Boolean(result);
    } catch {
      return false;
    }
  },
  annotationCreate: (payload) => ipcRenderer.invoke("annotation.create", payload),
  annotationUpdate: (payload) => ipcRenderer.invoke("annotation.update", payload),
  annotationDelete: (id) => ipcRenderer.invoke("annotation.delete", id),
  annotationList: (docId) => ipcRenderer.invoke("annotation.list", docId),
  annotationReloadFromPdf: (docId) => ipcRenderer.invoke("annotation.reloadFromPdf", docId),
  captionSyncHighlights: (payload) => ipcRenderer.invoke("caption.syncHighlights", payload),
  captionGetLinkedSnippets: (payload) => ipcRenderer.invoke("caption.getLinkedSnippets", payload),
  annotationSaveToPdf: (docId) => ipcRenderer.invoke("annotation.saveToPdf", docId),
  mappingBindManually: (docId, citationId, targetRect, captionText, targetPage) =>
    ipcRenderer.invoke("mapping.bindManually", docId, citationId, targetRect, captionText, targetPage),
};

contextBridge.exposeInMainWorld("journalApi", api);
