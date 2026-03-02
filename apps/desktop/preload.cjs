"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
window.addEventListener("wheel", (event) => {
    if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
    }
}, { passive: false, capture: true });
window.addEventListener("gesturestart", (event) => event.preventDefault(), { passive: false });
window.addEventListener("gesturechange", (event) => event.preventDefault(), { passive: false });
window.addEventListener("gestureend", (event) => event.preventDefault(), { passive: false });
const api = {
    openExternal: (url) => electron_1.ipcRenderer.invoke("app.openExternal", url),
    resolveDroppedFilePath: (file) => {
        try {
            const path = electron_1.webUtils.getPathForFile(file);
            return path || null;
        }
        catch {
            return null;
        }
    },
    docPick: () => electron_1.ipcRenderer.invoke("doc.pick"),
    onMenuFileOpen: (handler) => {
        const listener = (_event, path) => {
            handler(path);
        };
        electron_1.ipcRenderer.on("menu:file-open", listener);
        return () => {
            electron_1.ipcRenderer.removeListener("menu:file-open", listener);
        };
    },
    onAnnotationChanged: (handler) => {
        const listener = (_event, payload) => {
            handler(payload);
        };
        electron_1.ipcRenderer.on("annotation.changed", listener);
        return () => {
            electron_1.ipcRenderer.removeListener("annotation.changed", listener);
        };
    },
    docOpen: (path) => electron_1.ipcRenderer.invoke("doc.open", path),
    docParse: (docId) => electron_1.ipcRenderer.invoke("doc.parse", docId),
    docReadBinary: (path) => electron_1.ipcRenderer.invoke("doc.readBinary", path),
    citationResolve: (docId, page, x, y) => electron_1.ipcRenderer.invoke("citation.resolve", docId, page, x, y),
    citationResolveByLabel: (docId, kind, label) => electron_1.ipcRenderer.invoke("citation.resolveByLabel", docId, kind, label),
    referenceResolve: (docId, page, x, y) => electron_1.ipcRenderer.invoke("reference.resolve", docId, page, x, y),
    referenceGetEntries: (docId, indices) => electron_1.ipcRenderer.invoke("reference.getEntries", docId, indices),
    referenceSearchByText: (docId, text, limit) => electron_1.ipcRenderer.invoke("reference.searchByText", docId, text, limit),
    referenceHasEntries: (docId) => electron_1.ipcRenderer.invoke("reference.hasEntries", docId),
    referenceOpenPopup: (payload) => electron_1.ipcRenderer.invoke("reference.openPopup", payload),
    translateText: (payload) => electron_1.ipcRenderer.invoke("translate.text", payload),
    translateOpenPopup: (payload) => electron_1.ipcRenderer.invoke("translate.openPopup", payload),
    figureGetTarget: (docId, targetId) => electron_1.ipcRenderer.invoke("figure.getTarget", docId, targetId),
    figureListTargets: (docId, kind, label) => electron_1.ipcRenderer.invoke("figure.listTargets", docId, kind, label),
    figureOpenPopup: (payload) => electron_1.ipcRenderer.invoke("figure.openPopup", payload),
    recognizedOpenPopup: async (docId, kind) => {
        try {
            const result = await electron_1.ipcRenderer.invoke("recognized.openPopup", docId, kind);
            return Boolean(result);
        }
        catch {
            return false;
        }
    },
    annotationCreate: (payload) => electron_1.ipcRenderer.invoke("annotation.create", payload),
    annotationUpdate: (payload) => electron_1.ipcRenderer.invoke("annotation.update", payload),
    annotationDelete: (id) => electron_1.ipcRenderer.invoke("annotation.delete", id),
    annotationList: (docId) => electron_1.ipcRenderer.invoke("annotation.list", docId),
    annotationReloadFromPdf: (docId) => electron_1.ipcRenderer.invoke("annotation.reloadFromPdf", docId),
    captionSyncHighlights: (payload) => electron_1.ipcRenderer.invoke("caption.syncHighlights", payload),
    captionGetLinkedSnippets: (payload) => electron_1.ipcRenderer.invoke("caption.getLinkedSnippets", payload),
    annotationSaveToPdf: (docId) => electron_1.ipcRenderer.invoke("annotation.saveToPdf", docId),
    mappingBindManually: (docId, citationId, targetRect, captionText, targetPage) => electron_1.ipcRenderer.invoke("mapping.bindManually", docId, citationId, targetRect, captionText, targetPage),
};
electron_1.contextBridge.exposeInMainWorld("journalApi", api);
//# sourceMappingURL=index.js.map