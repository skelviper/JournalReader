import { app, BrowserWindow, Menu, dialog, nativeImage, shell } from "electron";
import type { NativeImage } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { join } from "node:path";
import { StorageRepository } from "@journal-reader/storage";
import { registerIpcHandlers } from "./ipc.js";

const APP_DISPLAY_NAME = "Journal Reader";
const APP_AUTHOR_CREDITS = "Created by skelviper with help from Codex";
const GITHUB_REPO_URL = "https://github.com/skelviper/JournalReader";
const GITHUB_API_RELEASES_LATEST = "https://api.github.com/repos/skelviper/JournalReader/releases/latest";
const GITHUB_API_TAGS = "https://api.github.com/repos/skelviper/JournalReader/tags?per_page=1";
const APP_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#eef4ff"/>
      <stop offset="100%" stop-color="#dbe6f6"/>
    </linearGradient>
    <linearGradient id="core" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#16375f"/>
      <stop offset="100%" stop-color="#29558e"/>
    </linearGradient>
    <linearGradient id="lens" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#8ed2ff"/>
      <stop offset="100%" stop-color="#4ea7f0"/>
    </linearGradient>
  </defs>
  <rect x="38" y="38" width="948" height="948" rx="220" fill="url(#bg)"/>
  <rect x="150" y="150" width="724" height="724" rx="180" fill="url(#core)"/>
  <path d="M328 288h286c49 0 88 39 88 88v214c0 49-39 88-88 88H398l-102 102v-404c0-49 39-88 88-88z" fill="#ffffff"/>
  <path d="M404 382h216" stroke="#1b3e6b" stroke-width="26" stroke-linecap="round"/>
  <path d="M404 450h180" stroke="#1b3e6b" stroke-width="26" stroke-linecap="round"/>
  <path d="M404 518h152" stroke="#1b3e6b" stroke-width="26" stroke-linecap="round"/>
  <circle cx="690" cy="690" r="118" fill="url(#lens)" stroke="#ffffff" stroke-width="28"/>
  <path d="M770 770l88 88" stroke="#ffffff" stroke-width="32" stroke-linecap="round"/>
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

type VersionTuple = [number, number, number];

function parseSemver(raw: string): VersionTuple | null {
  const normalized = raw.trim().replace(/^v/i, "");
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return [major, minor, patch];
}

function compareSemver(a: string, b: string): number {
  const aa = parseSemver(a);
  const bb = parseSemver(b);
  if (!aa || !bb) {
    return a.localeCompare(b);
  }
  for (let i = 0; i < 3; i += 1) {
    if (aa[i] === bb[i]) {
      continue;
    }
    return aa[i]! > bb[i]! ? 1 : -1;
  }
  return 0;
}

async function fetchLatestGithubVersion(): Promise<string | null> {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "JournalReaderApp",
  };

  try {
    const releaseRes = await fetch(GITHUB_API_RELEASES_LATEST, { headers });
    if (releaseRes.ok) {
      const data = (await releaseRes.json()) as { tag_name?: string };
      const tag = data?.tag_name?.trim();
      if (tag && parseSemver(tag)) {
        return tag.replace(/^v/i, "");
      }
    }
  } catch {
    // ignore and try tag fallback
  }

  try {
    const tagRes = await fetch(GITHUB_API_TAGS, { headers });
    if (!tagRes.ok) {
      return null;
    }
    const tags = (await tagRes.json()) as Array<{ name?: string }>;
    const first = tags[0]?.name?.trim();
    if (!first || !parseSemver(first)) {
      return null;
    }
    return first.replace(/^v/i, "");
  } catch {
    return null;
  }
}

async function checkForUpdates(): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow() ?? mainWindow;
  const currentVersion = app.getVersion();
  const showInfo = async (options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> => {
    if (parent) {
      return dialog.showMessageBox(parent, options);
    }
    return dialog.showMessageBox(options);
  };

  try {
    const latestVersion = await fetchLatestGithubVersion();
    if (!latestVersion) {
      await showInfo({
        type: "info",
        title: "Check for Updates",
        message: "Unable to determine the latest version from GitHub right now.",
        detail: `Current version: ${currentVersion}\nRepository: ${GITHUB_REPO_URL}`,
      });
      return;
    }

    const cmp = compareSemver(currentVersion, latestVersion);
    if (cmp < 0) {
      const result = await showInfo({
        type: "info",
        buttons: ["Open GitHub Releases", "Later"],
        defaultId: 0,
        cancelId: 1,
        title: "Update Available",
        message: `A newer version is available: ${latestVersion}`,
        detail: `Current version: ${currentVersion}`,
      });
      if (result.response === 0) {
        await shell.openExternal(`${GITHUB_REPO_URL}/releases`);
      }
      return;
    }

    if (cmp === 0) {
      await showInfo({
        type: "info",
        title: "Up to Date",
        message: `You are running the latest version (${currentVersion}).`,
      });
      return;
    }

    await showInfo({
      type: "info",
      title: "Version Check",
      message: `You are running a newer build (${currentVersion}) than GitHub latest (${latestVersion}).`,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await showInfo({
      type: "error",
      title: "Check for Updates Failed",
      message: "Could not check GitHub version.",
      detail: message,
    });
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
      submenu: [
        {
          label: "Check for Updates...",
          click: () => {
            void checkForUpdates();
          },
        },
        {
          label: "Open GitHub Repository",
          click: () => {
            void shell.openExternal(GITHUB_REPO_URL);
          },
        },
        { type: "separator" },
        { label: APP_AUTHOR_CREDITS, enabled: false },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow(): void {
  const appPath = app.getAppPath();
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const preloadPath = devUrl ? join(appPath, "preload.cjs") : join(appPath, "dist/preload/index.cjs");

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    title: "Journal Reader",
    icon: appIcon.isEmpty() ? undefined : appIcon,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const loadTask = devUrl
    ? mainWindow.loadURL(devUrl)
    : mainWindow.loadFile(join(appPath, "dist/renderer/index.html"));
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
    app.setAboutPanelOptions({
      applicationName: APP_DISPLAY_NAME,
      applicationVersion: app.getVersion(),
      copyright: APP_AUTHOR_CREDITS,
      credits: APP_AUTHOR_CREDITS,
      website: GITHUB_REPO_URL,
    });
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
