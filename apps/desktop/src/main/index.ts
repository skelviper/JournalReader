import { app, BrowserWindow, Menu, dialog, nativeImage } from "electron";
import type { NativeImage } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { join } from "node:path";
import { StorageRepository } from "@journal-reader/storage";
import { registerIpcHandlers } from "./ipc.js";

const APP_DISPLAY_NAME = "Journal Reader";
const APP_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f6f8fb"/>
      <stop offset="100%" stop-color="#e6ebf4"/>
    </linearGradient>
    <linearGradient id="core" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f2f55"/>
      <stop offset="100%" stop-color="#244f85"/>
    </linearGradient>
  </defs>
  <rect x="32" y="32" width="960" height="960" rx="220" fill="url(#bg)"/>
  <rect x="186" y="186" width="652" height="652" rx="170" fill="url(#core)"/>
  <path d="M360 330h190c98 0 162 56 162 142 0 89-67 145-170 145h-68v120h-114V330zm114 95v100h63c39 0 62-19 62-50 0-30-23-50-62-50h-63z" fill="#ffffff"/>
  <circle cx="332" cy="705" r="10" fill="#b8cdea"/>
  <circle cx="700" cy="324" r="9" fill="#b8cdea"/>
</svg>`;

let mainWindow: BrowserWindow | null = null;
let repo: StorageRepository | null = null;
let appIcon = nativeImage.createEmpty();
app.setName(APP_DISPLAY_NAME);

function buildAppIcon(): NativeImage {
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(APP_ICON_SVG)}`;
  const icon = nativeImage.createFromDataURL(dataUrl);
  if (icon.isEmpty()) {
    return nativeImage.createEmpty();
  }
  return icon.resize({ width: 512, height: 512 });
}

function applyRuntimeDockIcon(): void {
  appIcon = buildAppIcon();
  if (appIcon.isEmpty()) {
    return;
  }
  if (process.platform === "darwin") {
    app.dock?.setIcon(appIcon);
  }
}

async function openPdfFromMenu(window: BrowserWindow): Promise<void> {
  const result = await dialog.showOpenDialog(window, {
    title: "Open PDF",
    properties: ["openFile"],
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (result.canceled) {
    return;
  }
  const path = result.filePaths[0];
  if (!path) {
    return;
  }
  window.webContents.send("menu:file-open", path);
}

function installApplicationMenu(): void {
  const appMenuLabel = APP_DISPLAY_NAME;
  const template: MenuItemConstructorOptions[] = [
    {
      label: appMenuLabel,
      submenu: [{ role: "about" }, { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }],
    },
    {
      label: "File",
      submenu: [
        {
          label: "Open...",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            if (!mainWindow) {
              return;
            }
            void openPdfFromMenu(mainWindow).catch((error: unknown) => {
              const message = error instanceof Error ? error.stack ?? error.message : String(error);
              console.error("menu open failed:", message);
              dialog.showErrorBox("Open Failed", message);
            });
          },
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [{ label: "Journal Reader" }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    title: "Journal Reader",
    icon: appIcon.isEmpty() ? undefined : appIcon,
    webPreferences: {
      preload: join(app.getAppPath(), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const loadTask = devUrl
    ? mainWindow.loadURL(devUrl)
    : mainWindow.loadFile(join(app.getAppPath(), "dist/renderer/index.html"));
  void loadTask.catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error("failed to load renderer:", message);
    dialog.showErrorBox("Renderer Failed To Load", message);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  console.error("unhandledRejection:", message);
  dialog.showErrorBox("Unhandled Rejection", message);
});

process.on("uncaughtException", (error) => {
  const message = error.stack ?? error.message;
  console.error("uncaughtException:", message);
  dialog.showErrorBox("Uncaught Exception", message);
});

app
  .whenReady()
  .then(() => {
    app.setName(APP_DISPLAY_NAME);
    applyRuntimeDockIcon();
    const dbPath = join(app.getPath("userData"), "journal-reader", "reader.db");
    repo = new StorageRepository(dbPath);
    registerIpcHandlers(repo);

    installApplicationMenu();
    createMainWindow();
    installApplicationMenu();
    const topLabel = Menu.getApplicationMenu()?.items[0]?.label ?? "(none)";
    console.log(`[journal-reader] app name: ${app.getName()} | top menu: ${topLabel}`);

    app.on("browser-window-created", () => {
      installApplicationMenu();
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error("app startup failed:", message);
    dialog.showErrorBox("App Startup Failed", message);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  repo?.close();
});
