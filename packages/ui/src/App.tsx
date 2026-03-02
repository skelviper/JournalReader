import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import type { MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from "react";
import { getDocument, GlobalWorkerOptions, Util } from "pdfjs-dist";
import type {
  AnnotationItem,
  FigureTargetCandidate,
  NoteTextStyle,
  Rect,
  RecognizedPopupKind,
  TargetKind,
  TranslateProvider,
} from "@journal-reader/types";
import type { JournalApi } from "./api.js";
import "./styles.css";

type PDFDocumentProxy = Awaited<ReturnType<typeof getDocument>["promise"]>;
type PDFPageProxy = Awaited<ReturnType<PDFDocumentProxy["getPage"]>>;

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

type ToolMode = "none" | "highlight" | "text-note" | "sticky" | "manual-bind";

type ParseStats = {
  refsCount: number;
  figuresCount: number;
  tablesCount: number;
  suppCount: number;
};

type CitationHit = {
  citationId: string;
  kind: string;
  label: string;
  page: number;
};

type SelectionMenuState = {
  x: number;
  y: number;
  text: string;
  page: number;
};

type SelectionAction = {
  id: number;
  kind: "highlight";
  page: number;
};

type HighlightMenuState = {
  x: number;
  y: number;
  annotationId: string;
};

type TranslationSettings = {
  provider: TranslateProvider;
  sourceLang: string;
  targetLang: string;
};

type DragState = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
} | null;

type MarqueeState = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  additive: boolean;
} | null;

type NoteMoveState = {
  ids: string[];
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
} | null;

type PdfRenderTask = {
  promise: Promise<unknown>;
  cancel: () => void;
};

type PixelRegion = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

type PixelBox = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
  score: number;
};

type PageVisualMask = {
  page: PDFPageProxy;
  pageRect: Rect;
  viewport: ReturnType<PDFPageProxy["getViewport"]>;
  mask: Uint8Array;
  width: number;
  height: number;
};

const MIN_SCALE = 0.8;
const MAX_SCALE = 2.8;
const PINCH_BASE_GAIN = 0.00155;
const PINCH_MIN_ABS_DELTA = 0.05;
const PINCH_MAX_REL_STEP = 0.065;
const PINCH_SMOOTH_ALPHA = 0.45;
const HIGHLIGHT_COLORS = [
  { label: "Yellow", value: "#fce588" },
  { label: "Green", value: "#b8f3b4" },
  { label: "Pink", value: "#f9c5e5" },
  { label: "Blue", value: "#b9d9ff" },
] as const;
const NOTE_FONTS = [
  { label: "SF Pro", value: "\"SF Pro Text\", -apple-system, BlinkMacSystemFont, sans-serif" },
  { label: "Times", value: "\"Times New Roman\", Times, serif" },
  { label: "Helvetica", value: "\"Helvetica Neue\", Helvetica, Arial, sans-serif" },
  { label: "Menlo", value: "Menlo, Monaco, monospace" },
] as const;
const NOTE_FONT_SIZES = [16, 20, 24, 28, 32, 40] as const;
const MENU_VIEWPORT_MARGIN = 8;
const TRANSLATION_SETTINGS_KEY = "journal-reader.translation-settings.v2";
const TRANSLATION_PROVIDERS: Array<{ value: TranslateProvider; label: string }> = [
  { value: "google", label: "Google Translate" },
  { value: "libre", label: "LibreTranslate" },
  { value: "mymemory", label: "MyMemory" },
];
const TRANSLATION_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: "auto", label: "Auto Detect" },
  { value: "en", label: "English" },
  { value: "zh-CN", label: "Chinese (Simplified)" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "es", label: "Spanish" },
  { value: "it", label: "Italian" },
  { value: "ru", label: "Russian" },
  { value: "pt", label: "Portuguese" },
  { value: "ar", label: "Arabic" },
];

function clampMenuAnchor(x: number, y: number, menuWidth: number, menuHeight: number): { x: number; y: number } {
  const maxX = Math.max(MENU_VIEWPORT_MARGIN, window.innerWidth - menuWidth - MENU_VIEWPORT_MARGIN);
  const maxY = Math.max(MENU_VIEWPORT_MARGIN, window.innerHeight - menuHeight - MENU_VIEWPORT_MARGIN);
  return {
    x: Math.min(Math.max(x, MENU_VIEWPORT_MARGIN), maxX),
    y: Math.min(Math.max(y, MENU_VIEWPORT_MARGIN), maxY),
  };
}

function defaultTranslationSettings(): TranslationSettings {
  return {
    provider: "google",
    sourceLang: "en",
    targetLang: "zh-CN",
  };
}

function loadTranslationSettings(): TranslationSettings {
  if (typeof window === "undefined") {
    return defaultTranslationSettings();
  }
  try {
    const raw = window.localStorage.getItem(TRANSLATION_SETTINGS_KEY);
    if (!raw) {
      return defaultTranslationSettings();
    }
    const parsed = JSON.parse(raw) as Partial<TranslationSettings>;
    const provider = TRANSLATION_PROVIDERS.some((item) => item.value === parsed.provider)
      ? (parsed.provider as TranslateProvider)
      : "google";
    const sourceLang =
      TRANSLATION_LANGUAGES.some((item) => item.value === parsed.sourceLang) && parsed.sourceLang
        ? parsed.sourceLang
        : "auto";
    const targetLang =
      TRANSLATION_LANGUAGES.some((item) => item.value === parsed.targetLang) && parsed.targetLang
        ? parsed.targetLang
        : "en";
    return {
      provider,
      sourceLang,
      targetLang,
    };
  } catch {
    return defaultTranslationSettings();
  }
}

function uriListToPath(uriList: string): string | null {
  const first = uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  if (!first || !first.startsWith("file://")) {
    return null;
  }
  try {
    const url = new URL(first);
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

function extractDroppedPdfPath(
  dataTransfer: DataTransfer | null,
  resolveFilePath?: (file: File) => string | null,
): string | null {
  if (!dataTransfer) {
    return null;
  }

  const files = Array.from(dataTransfer.files ?? []);
  for (const file of files) {
    const extName = file.name || "";
    const directPath = (file as File & { path?: string }).path ?? "";
    const resolvedPath = resolveFilePath?.(file) ?? "";
    const maybePath = directPath || resolvedPath;
    const candidate = maybePath || extName;
    if (/\.pdf$/i.test(candidate)) {
      return maybePath || null;
    }
  }

  const uriList = dataTransfer.getData("text/uri-list");
  const fromUri = uriListToPath(uriList);
  if (fromUri && /\.pdf$/i.test(fromUri)) {
    return fromUri;
  }

  return null;
}

function hasDroppedPdfPayload(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) {
    return false;
  }
  const files = Array.from(dataTransfer.files ?? []);
  if (files.some((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf")) {
    return true;
  }
  const uriList = dataTransfer.getData("text/uri-list");
  return /\.pdf(?:$|[?#])/i.test(uriList);
}

function hasFileDragPayload(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) {
    return false;
  }
  const types = Array.from(dataTransfer.types ?? []);
  return types.includes("Files");
}

function ToolButton({
  title,
  active = false,
  primary = false,
  onMouseDown,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  primary?: boolean;
  onMouseDown?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onClick: () => void;
  children: JSX.Element;
}): JSX.Element {
  const className = `tool-btn${active ? " active" : ""}${primary ? " primary" : ""}`;
  return (
    <button type="button" className={className} onMouseDown={onMouseDown} onClick={onClick} title={title} aria-label={title}>
      {children}
    </button>
  );
}

function IconGlyph({ d, fill = "none" }: { d: string; fill?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} fill={fill} />
    </svg>
  );
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function normalizeSnippetText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length > 260 ? normalized.slice(0, 260).trim() : normalized;
}

function isEditableElement(element: EventTarget | null): boolean {
  const target = element instanceof HTMLElement ? element : null;
  if (!target) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  return Boolean(target.closest("input, textarea, select, option, [contenteditable='true']"));
}

function isRenderCancelled(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "RenderingCancelledException" || error.message.includes("Rendering cancelled");
}

function normalizeRect(a: number[], b: number[]): Rect {
  const ax = a[0] ?? 0;
  const ay = a[1] ?? 0;
  const bx = b[0] ?? 0;
  const by = b[1] ?? 0;
  const x = Math.min(ax, bx);
  const y = Math.min(ay, by);
  const w = Math.max(1, Math.abs(ax - bx));
  const h = Math.max(1, Math.abs(ay - by));
  return { x, y, w, h };
}

function parseIndexList(text: string): number[] | null {
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  const out: number[] = [];
  const seen = new Set<number>();
  for (const part of parts) {
    const range = part.match(/^(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?$/);
    if (!range) {
      return null;
    }
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0) {
      return null;
    }
    if (Math.abs(end - start) > 40) {
      return null;
    }
    const step = start <= end ? 1 : -1;
    for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
      if (!seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
    }
  }

  return out.length > 0 ? out : null;
}

function extractReferenceIndices(text: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();

  const bracketPattern = /\[(\s*\d{1,4}(?:\s*[-–]\s*\d{1,4})?(?:\s*,\s*\d{1,4}(?:\s*[-–]\s*\d{1,4})?)*)\]/g;
  for (const match of text.matchAll(bracketPattern)) {
    const body = match[1] ?? "";
    const parsed = parseIndexList(body);
    if (!parsed) {
      continue;
    }
    for (const value of parsed) {
      if (!seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
    }
  }

  if (out.length > 0) {
    return out;
  }

  const stripped = text
    .trim()
    .replace(/^[([{\u207D]+/, "")
    .replace(/[)\].,;:\u207E]+$/, "")
    .trim();
  const parsed = parseIndexList(stripped);
  if (!parsed) {
    return [];
  }

  const single = parsed.length === 1 && !stripped.includes(",") && !stripped.includes("-") && !stripped.includes("–");
  if (single && stripped.length > 8) {
    return [];
  }
  return parsed;
}

function parseCitationSelection(text: string): { kind: TargetKind; label: string } | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match = normalized.match(
    /(Supplementary\s+(?:Figure|Fig\.?|Table)|Extended\s+Data\s+(?:Figure|Fig\.?|Table)|Figure|Fig\.?|Table)\.?\s*(S?\d+)\s*([A-Za-z]?)/i,
  );
  if (!match) {
    return null;
  }
  const prefix = (match[1] ?? "").toLowerCase();
  const base = (match[2] ?? "").trim().toUpperCase();
  const suffix = (match[3] ?? "").trim().toUpperCase();
  const label = `${base}${suffix}`;
  const kind: TargetKind = prefix.includes("table")
    ? prefix.includes("supplementary") || prefix.includes("extended data") || label.startsWith("S")
      ? "supplementary"
      : "table"
    : prefix.includes("supplementary") || prefix.includes("extended data") || label.startsWith("S")
      ? "supplementary"
      : "figure";
  return { kind, label };
}

function extractAnyFigureLikeLabel(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  const hasKeyword = /\b(fig(?:ure)?|table|supplementary|extended\s+data)\b/i.test(normalized);

  const alphaLabel = normalized.match(/\b(S?\d{1,3})\s*([A-Za-z])\b/);
  if (alphaLabel) {
    return `${(alphaLabel[1] ?? "").toUpperCase()}${(alphaLabel[2] ?? "").toUpperCase()}`;
  }

  if (!hasKeyword) {
    return null;
  }

  const match = normalized.match(/\b(S?\d{1,3})\b/);
  if (!match) {
    return null;
  }
  return (match[1] ?? "").trim().toUpperCase();
}

function selectionToPage(selection: Selection | null): number | null {
  if (!selection) {
    return null;
  }
  const node = selection.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  const wrap = element?.closest?.(".page-wrap[data-page]");
  if (!wrap) {
    return null;
  }
  const raw = wrap.getAttribute("data-page");
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function copyTextToClipboard(text: string): Promise<void> {
  const value = text.trim();
  if (!value) {
    return;
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function normalizedNoteStyle(annotation: AnnotationItem): Required<NoteTextStyle> {
  const style = annotation.style ?? {};
  return {
    fontSize:
      typeof style.fontSize === "number" && Number.isFinite(style.fontSize)
        ? Math.max(10, Math.min(72, style.fontSize))
        : annotation.kind === "text-note"
          ? 28
          : 13,
    fontFamily: style.fontFamily || NOTE_FONTS[0].value,
    textColor: style.textColor || (annotation.kind === "text-note" ? "#db4638" : "#29384b"),
  };
}

function toViewportRect(page: PDFPageProxy, pdfRect: Rect, scale: number): Rect {
  const viewport = page.getViewport({ scale });
  const [x1, y1] = viewport.convertToViewportPoint(pdfRect.x, pdfRect.y);
  const [x2, y2] = viewport.convertToViewportPoint(pdfRect.x + pdfRect.w, pdfRect.y + pdfRect.h);
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function clearMaskRect(mask: Uint8Array, width: number, height: number, rect: PixelRegion): void {
  const x0 = clampInt(rect.x0, 0, width - 1);
  const y0 = clampInt(rect.y0, 0, height - 1);
  const x1 = clampInt(rect.x1, 0, width - 1);
  const y1 = clampInt(rect.y1, 0, height - 1);
  for (let y = y0; y <= y1; y += 1) {
    const rowOffset = y * width;
    for (let x = x0; x <= x1; x += 1) {
      mask[rowOffset + x] = 0;
    }
  }
}

async function buildPageVisualMask(pdfDoc: PDFDocumentProxy, pageNumber: number, scale = 2): Promise<PageVisualMask | null> {
  const page = await pdfDoc.getPage(pageNumber);
  const pageRect = toPdfPageRect(page);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }

  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  await page.render({ canvasContext: ctx, viewport }).promise;

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const mask = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, p = 0; i < image.data.length; i += 4, p += 1) {
    const r = image.data[i] ?? 255;
    const g = image.data[i + 1] ?? 255;
    const b = image.data[i + 2] ?? 255;
    const a = image.data[i + 3] ?? 255;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    mask[p] = a > 16 && luminance < 245 ? 1 : 0;
  }

  // Clear text-layer glyph boxes so layout detection focuses on non-text visual blocks.
  const textContent = await page.getTextContent();
  for (const item of textContent.items) {
    if (!("str" in item && "transform" in item)) {
      continue;
    }
    const tx = Util.transform(viewport.transform, item.transform);
    const width = ("width" in item ? item.width : 8) * scale;
    const height = ("height" in item ? item.height : 12) * scale;
    clearMaskRect(mask, canvas.width, canvas.height, {
      x0: tx[4] - 2,
      y0: tx[5] - height - 2,
      x1: tx[4] + width + 2,
      y1: tx[5] + 2,
    });
  }

  return {
    page,
    pageRect,
    viewport,
    mask,
    width: canvas.width,
    height: canvas.height,
  };
}

function findBestComponent(
  mask: Uint8Array,
  width: number,
  height: number,
  region: PixelRegion,
  anchor: Rect,
  preferredSide: "above" | "below",
): PixelBox | null {
  const x0 = clampInt(region.x0, 0, width - 1);
  const y0 = clampInt(region.y0, 0, height - 1);
  const x1 = clampInt(region.x1, 0, width - 1);
  const y1 = clampInt(region.y1, 0, height - 1);
  if (x0 >= x1 || y0 >= y1) {
    return null;
  }

  const visited = new Uint8Array(width * height);
  const queueX = new Int32Array(width * height);
  const queueY = new Int32Array(width * height);
  const minArea = 120;
  const components: PixelBox[] = [];
  const anchorCx = anchor.x + anchor.w / 2;
  const anchorTop = anchor.y;
  const anchorBottom = anchor.y + anchor.h;

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const idx = y * width + x;
      if (!mask[idx] || visited[idx]) {
        continue;
      }

      let head = 0;
      let tail = 0;
      queueX[tail] = x;
      queueY[tail] = y;
      tail += 1;
      visited[idx] = 1;

      let area = 0;
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;
      let sumX = 0;

      while (head < tail) {
        const cx = queueX[head];
        const cy = queueY[head];
        head += 1;
        area += 1;
        sumX += cx;
        minX = Math.min(minX, cx);
        minY = Math.min(minY, cy);
        maxX = Math.max(maxX, cx);
        maxY = Math.max(maxY, cy);

        const neighbors = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < x0 || nx > x1 || ny < y0 || ny > y1) {
            continue;
          }
          const nIdx = ny * width + nx;
          if (visited[nIdx] || !mask[nIdx]) {
            continue;
          }
          visited[nIdx] = 1;
          queueX[tail] = nx;
          queueY[tail] = ny;
          tail += 1;
        }
      }

      if (area < minArea) {
        continue;
      }
      const compW = maxX - minX + 1;
      const compH = maxY - minY + 1;
      if ((compH <= 4 && compW > 80) || (compW <= 4 && compH > 80)) {
        continue;
      }

      const compCx = sumX / area;
      const horizontalPenalty = Math.abs(compCx - anchorCx) * 0.35;
      const verticalDistance =
        preferredSide === "above" ? Math.abs(anchorTop - maxY) : Math.abs(minY - anchorBottom);
      const sidePenalty =
        preferredSide === "above"
          ? maxY > anchorTop
            ? 250
            : 0
          : minY < anchorBottom
            ? 250
            : 0;
      const score = area - verticalDistance * 1.6 - horizontalPenalty - sidePenalty;
      components.push({ minX, minY, maxX, maxY, area, score });
    }
  }

  if (components.length === 0) {
    return null;
  }
  const sorted = [...components].sort((a, b) => b.score - a.score);
  const best = sorted[0];
  if (!best) {
    return null;
  }

  const areaGate = Math.max(80, best.area * 0.02);
  const selected = sorted.filter((item) => item.area >= areaGate && item.score > -400).slice(0, 80);
  const unionSet = selected.length > 0 ? selected : [best];

  let minX = unionSet[0]?.minX ?? best.minX;
  let minY = unionSet[0]?.minY ?? best.minY;
  let maxX = unionSet[0]?.maxX ?? best.maxX;
  let maxY = unionSet[0]?.maxY ?? best.maxY;
  let area = 0;
  for (const item of unionSet) {
    minX = Math.min(minX, item.minX);
    minY = Math.min(minY, item.minY);
    maxX = Math.max(maxX, item.maxX);
    maxY = Math.max(maxY, item.maxY);
    area += item.area;
  }

  return { minX, minY, maxX, maxY, area, score: best.score };
}

function findDominantComponent(mask: Uint8Array, width: number, height: number): PixelBox | null {
  if (width < 8 || height < 8) {
    return null;
  }

  const visited = new Uint8Array(width * height);
  const queueX = new Int32Array(width * height);
  const queueY = new Int32Array(width * height);
  const pageArea = Math.max(1, width * height);
  const minArea = Math.max(180, Math.floor(pageArea * 0.0014));
  const marginX = Math.max(2, Math.floor(width * 0.01));
  const marginY = Math.max(2, Math.floor(height * 0.01));
  const x0 = marginX;
  const y0 = marginY;
  const x1 = width - marginX - 1;
  const y1 = height - marginY - 1;
  const components: PixelBox[] = [];

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const idx = y * width + x;
      if (!mask[idx] || visited[idx]) {
        continue;
      }

      let head = 0;
      let tail = 0;
      queueX[tail] = x;
      queueY[tail] = y;
      tail += 1;
      visited[idx] = 1;

      let area = 0;
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;

      while (head < tail) {
        const cx = queueX[head];
        const cy = queueY[head];
        head += 1;
        area += 1;
        minX = Math.min(minX, cx);
        minY = Math.min(minY, cy);
        maxX = Math.max(maxX, cx);
        maxY = Math.max(maxY, cy);

        const neighbors = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < x0 || nx > x1 || ny < y0 || ny > y1) {
            continue;
          }
          const nIdx = ny * width + nx;
          if (visited[nIdx] || !mask[nIdx]) {
            continue;
          }
          visited[nIdx] = 1;
          queueX[tail] = nx;
          queueY[tail] = ny;
          tail += 1;
        }
      }

      if (area < minArea) {
        continue;
      }

      const compW = maxX - minX + 1;
      const compH = maxY - minY + 1;
      const areaRatio = area / pageArea;
      if (compW < 12 || compH < 12 || areaRatio > 0.94) {
        continue;
      }

      const aspect = Math.max(compW / Math.max(1, compH), compH / Math.max(1, compW));
      if (aspect > 12 && areaRatio < 0.2) {
        continue;
      }

      const fillRatio = area / Math.max(1, compW * compH);
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const normCenterDistance =
        Math.hypot(centerX - width / 2, centerY - height / 2) / Math.max(1, Math.hypot(width / 2, height / 2));
      const edgeMargin = Math.min(minX - x0, minY - y0, x1 - maxX, y1 - maxY);
      const edgePenalty = edgeMargin < 8 ? 420 : edgeMargin < 14 ? 190 : 0;
      const score = area * (0.95 + fillRatio * 0.35) - normCenterDistance * area * 0.28 - edgePenalty;
      components.push({ minX, minY, maxX, maxY, area, score });
    }
  }

  if (components.length === 0) {
    return null;
  }

  const sorted = [...components].sort((a, b) => b.score - a.score);
  const best = sorted[0];
  if (!best) {
    return null;
  }

  const bestW = best.maxX - best.minX + 1;
  const bestH = best.maxY - best.minY + 1;
  const joinPadX = Math.max(44, Math.floor(bestW * 0.9));
  const joinPadY = Math.max(36, Math.floor(bestH * 0.9));
  const areaGate = Math.max(minArea, best.area * 0.05);
  const selected = sorted
    .filter((item) => {
      if (item.area < areaGate) {
        return false;
      }
      const cx = (item.minX + item.maxX) / 2;
      const cy = (item.minY + item.maxY) / 2;
      return (
        cx >= best.minX - joinPadX &&
        cx <= best.maxX + joinPadX &&
        cy >= best.minY - joinPadY &&
        cy <= best.maxY + joinPadY
      );
    })
    .slice(0, 140);

  const unionSet = selected.length > 0 ? selected : [best];
  let minX = unionSet[0]?.minX ?? best.minX;
  let minY = unionSet[0]?.minY ?? best.minY;
  let maxX = unionSet[0]?.maxX ?? best.maxX;
  let maxY = unionSet[0]?.maxY ?? best.maxY;
  let area = 0;
  for (const item of unionSet) {
    minX = Math.min(minX, item.minX);
    minY = Math.min(minY, item.minY);
    maxX = Math.max(maxX, item.maxX);
    maxY = Math.max(maxY, item.maxY);
    area += item.area;
  }
  return { minX, minY, maxX, maxY, area, score: best.score };
}

function toPdfPageRect(page: PDFPageProxy): Rect {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = page.view ?? [0, 0, 0, 0];
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

function expandRectWithinPage(rect: Rect, pageRect: Rect, pad: number): Rect {
  const left = Math.max(pageRect.x, rect.x - pad);
  const top = Math.max(pageRect.y, rect.y - pad);
  const right = Math.min(pageRect.x + pageRect.w, rect.x + rect.w + pad);
  const bottom = Math.min(pageRect.y + pageRect.h, rect.y + rect.h + pad);
  return {
    x: left,
    y: top,
    w: Math.max(1, right - left),
    h: Math.max(1, bottom - top),
  };
}

function buildDirectionalFallbackRect(pageRect: Rect, captionRect: Rect, kind: string): Rect {
  const marginX = Math.max(10, pageRect.w * (kind === "table" ? 0.06 : 0.04));
  const pageBottom = pageRect.y + 8;
  const pageTop = pageRect.y + pageRect.h - 8;
  const captionBottom = Math.max(pageBottom, captionRect.y);
  const captionTop = Math.min(pageTop, captionRect.y + captionRect.h);
  const gap = Math.max(8, captionRect.h * 0.35);

  // PDF coordinates increase upward, so the "above caption" area starts at captionTop.
  const aboveY = Math.min(pageTop - 1, captionTop + gap);
  const aboveH = Math.max(1, pageTop - aboveY);
  const belowY = pageBottom;
  const belowH = Math.max(1, (captionBottom - gap) - pageBottom);

  let y = aboveY;
  let h = aboveH;
  if (kind === "table") {
    y = belowY;
    h = belowH;
    if (h < pageRect.h * 0.16 && aboveH > h * 1.2) {
      y = aboveY;
      h = aboveH;
    }
  } else if (h < pageRect.h * 0.16 && belowH > h * 1.2) {
    y = belowY;
    h = belowH;
  }

  return expandRectWithinPage(
    {
      x: pageRect.x + marginX,
      y,
      w: Math.max(60, pageRect.w - marginX * 2),
      h: Math.max(40, h),
    },
    pageRect,
    24,
  );
}

async function detectVisualRegionNearCaption(
  pdfDoc: PDFDocumentProxy,
  pageNumber: number,
  captionRect: Rect,
  kind: string,
  options?: { allowFallback?: boolean },
): Promise<{ rect: Rect; mode: "component" | "fallback"; area: number; score: number } | null> {
  const visual = await buildPageVisualMask(pdfDoc, pageNumber, 2);
  if (!visual) {
    return null;
  }
  const { page, pageRect, viewport } = visual;
  const width = visual.width;
  const height = visual.height;
  const mask = visual.mask.slice();
  const allowFallback = options?.allowFallback ?? true;

  const captionView = toViewportRect(page, captionRect, 2);
  clearMaskRect(mask, width, height, {
    x0: captionView.x - 4,
    y0: captionView.y - 4,
    x1: captionView.x + captionView.w + 4,
    y1: captionView.y + captionView.h + 4,
  });

  const minProbeWidth = width * (kind === "table" ? 0.66 : 0.86);
  const dynamicProbeWidth = Math.max(captionView.w + Math.max(120, width * 0.06), minProbeWidth);
  const centerX = captionView.x + captionView.w / 2;
  const column: PixelRegion = {
    x0: centerX - dynamicProbeWidth / 2,
    x1: centerX + dynamicProbeWidth / 2,
    y0: 0,
    y1: height - 1,
  };

  const belowRegion: PixelRegion = {
    x0: column.x0,
    x1: column.x1,
    y0: Math.min(height - 1, captionView.y + captionView.h + 10),
    y1: Math.min(height - 1, captionView.y + height * 0.45),
  };

  const aboveRegion: PixelRegion = {
    x0: column.x0,
    x1: column.x1,
    y0: Math.max(0, captionView.y - height * 0.72),
    y1: Math.max(0, captionView.y - 10),
  };

  const preferBelow = kind === "table";
  const preferredRegion = preferBelow ? belowRegion : aboveRegion;
  const preferredSide: "above" | "below" = preferBelow ? "below" : "above";
  const fallbackRegion = preferBelow ? aboveRegion : belowRegion;
  const fallbackSide: "above" | "below" = preferBelow ? "above" : "below";

  let best = findBestComponent(mask, width, height, preferredRegion, captionView, preferredSide);
  if (!best) {
    best = findBestComponent(mask, width, height, fallbackRegion, captionView, fallbackSide);
  }
  if (!best && !allowFallback) {
    return null;
  }
  if (!best) {
    const rect = buildDirectionalFallbackRect(pageRect, captionRect, kind);
    return { rect, mode: "fallback", area: rect.w * rect.h, score: -1 };
  }

  const padding = 12;
  const x0 = Math.max(0, best.minX - padding);
  const y0 = Math.max(0, best.minY - padding);
  const x1 = Math.min(width - 1, best.maxX + padding);
  const y1 = Math.min(height - 1, best.maxY + padding);

  const a = viewport.convertToPdfPoint(x0, y0);
  const b = viewport.convertToPdfPoint(x1, y1);
  const baseRect = normalizeRect(a, b);
  const flankPad = Math.max(22, Math.min(72, Math.max(baseRect.w, baseRect.h) * 0.06));
  const rect = expandRectWithinPage(baseRect, pageRect, flankPad);
  const isThinStrip = rect.h < pageRect.h * 0.15 || rect.w / Math.max(1, rect.h) > 8.5;
  if (isThinStrip && !allowFallback) {
    return null;
  }
  if (isThinStrip && allowFallback) {
    const fallbackRect = buildDirectionalFallbackRect(pageRect, captionRect, kind);
    return { rect: fallbackRect, mode: "fallback", area: fallbackRect.w * fallbackRect.h, score: best.score };
  }
  return { rect, mode: "component", area: rect.w * rect.h, score: best.score };
}

async function detectVisualRegionByPageLayout(
  pdfDoc: PDFDocumentProxy,
  pageNumber: number,
  kind: TargetKind,
): Promise<{ rect: Rect; mode: "component"; area: number; score: number } | null> {
  const visual = await buildPageVisualMask(pdfDoc, pageNumber, 2);
  if (!visual) {
    return null;
  }
  const best = findDominantComponent(visual.mask, visual.width, visual.height);
  if (!best) {
    return null;
  }

  const padding = 14;
  const x0 = Math.max(0, best.minX - padding);
  const y0 = Math.max(0, best.minY - padding);
  const x1 = Math.min(visual.width - 1, best.maxX + padding);
  const y1 = Math.min(visual.height - 1, best.maxY + padding);
  const a = visual.viewport.convertToPdfPoint(x0, y0);
  const b = visual.viewport.convertToPdfPoint(x1, y1);
  const baseRect = normalizeRect(a, b);
  const flankPad =
    kind === "table"
      ? Math.max(26, Math.min(80, Math.max(baseRect.w, baseRect.h) * 0.08))
      : Math.max(30, Math.min(108, Math.max(baseRect.w, baseRect.h) * 0.11));
  const rect = expandRectWithinPage(baseRect, visual.pageRect, flankPad);
  const pageArea = Math.max(1, visual.pageRect.w * visual.pageRect.h);
  const areaRatio = (rect.w * rect.h) / pageArea;
  const minRatio = kind === "table" ? 0.018 : 0.04;
  if (areaRatio < minRatio) {
    return null;
  }
  return { rect, mode: "component", area: rect.w * rect.h, score: best.score };
}

async function renderPageImage(
  pdfDoc: PDFDocumentProxy,
  pageNumber: number,
): Promise<{ imageDataUrl: string; pageRect: Rect } | null> {
  const page = await pdfDoc.getPage(pageNumber);
  const pageRect = toPdfPageRect(page);
  const viewport = page.getViewport({ scale: 2.2 });
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  await page.render({ canvasContext: ctx, viewport }).promise;
  return {
    imageDataUrl: canvas.toDataURL("image/png"),
    pageRect,
  };
}

async function renderTargetCropImage(
  pdfDoc: PDFDocumentProxy,
  pageNumber: number,
  rect: Rect,
  options?: { trim?: boolean },
): Promise<string | null> {
  const page = await pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 3 });
  const fullCanvas = document.createElement("canvas");
  const fullCtx = fullCanvas.getContext("2d");
  if (!fullCtx) {
    return null;
  }

  fullCanvas.width = Math.max(1, Math.floor(viewport.width));
  fullCanvas.height = Math.max(1, Math.floor(viewport.height));
  await page.render({ canvasContext: fullCtx, viewport }).promise;

  const [vx1, vy1] = viewport.convertToViewportPoint(rect.x, rect.y);
  const [vx2, vy2] = viewport.convertToViewportPoint(rect.x + rect.w, rect.y + rect.h);
  const sx = Math.max(0, Math.floor(Math.min(vx1, vx2)));
  const sy = Math.max(0, Math.floor(Math.min(vy1, vy2)));
  const sw = Math.max(1, Math.floor(Math.abs(vx2 - vx1)));
  const sh = Math.max(1, Math.floor(Math.abs(vy2 - vy1)));

  const cropCanvas = document.createElement("canvas");
  const cropCtx = cropCanvas.getContext("2d");
  if (!cropCtx) {
    return null;
  }

  cropCanvas.width = sw;
  cropCanvas.height = sh;
  cropCtx.drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  if (options?.trim === false) {
    return cropCanvas.toDataURL("image/png");
  }
  const image = cropCtx.getImageData(0, 0, sw, sh);
  let minX = sw;
  let minY = sh;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) {
      const idx = (y * sw + x) * 4;
      const r = image.data[idx] ?? 255;
      const g = image.data[idx + 1] ?? 255;
      const b = image.data[idx + 2] ?? 255;
      const a = image.data[idx + 3] ?? 255;
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (!(a > 12 && luminance < 248)) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX <= minX || maxY <= minY) {
    return cropCanvas.toDataURL("image/png");
  }

  const contentW = maxX - minX + 1;
  const contentH = maxY - minY + 1;
  const areaRatio = (contentW * contentH) / Math.max(1, sw * sh);
  const tooThinContent = contentW < sw * 0.16 || contentH < sh * 0.16;
  if (areaRatio < 0.04 || tooThinContent) {
    return cropCanvas.toDataURL("image/png");
  }

  const pad = Math.max(12, Math.floor(Math.max(sw, sh) * 0.02));
  const tx = Math.max(0, minX - pad);
  const ty = Math.max(0, minY - pad);
  const tw = Math.min(sw - tx, maxX - minX + 1 + pad * 2);
  const th = Math.min(sh - ty, maxY - minY + 1 + pad * 2);

  const trimmedCanvas = document.createElement("canvas");
  const trimmedCtx = trimmedCanvas.getContext("2d");
  if (!trimmedCtx) {
    return cropCanvas.toDataURL("image/png");
  }
  trimmedCanvas.width = Math.max(1, tw);
  trimmedCanvas.height = Math.max(1, th);
  trimmedCtx.drawImage(cropCanvas, tx, ty, tw, th, 0, 0, tw, th);
  return trimmedCanvas.toDataURL("image/png");
}

export function ReaderApp({ api }: { api: JournalApi }): JSX.Element {
  const readerRef = useRef<HTMLDivElement | null>(null);
  const selectionMenuRef = useRef<HTMLDivElement | null>(null);
  const highlightMenuRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef(1.3);
  const pendingScrollRef = useRef<{ left: number; top: number } | null>(null);
  const scrollApplyRafRef = useRef<number | null>(null);
  const pinchZoomRafRef = useRef<number | null>(null);
  const pinchAccumulatedDeltaRef = useRef(0);
  const pinchSmoothedDeltaRef = useRef(0);
  const pinchPointerRef = useRef({ x: 0, y: 0 });
  const selectionActionSeqRef = useRef(0);
  const [docId, setDocId] = useState<string | null>(null);
  const [docTitle, setDocTitle] = useState("No document loaded");
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [activePage, setActivePage] = useState(1);
  const [scale, setScale] = useState(1.3);
  const [toolMode, setToolMode] = useState<ToolMode>("none");
  const [annotations, setAnnotations] = useState<AnnotationItem[]>([]);
  const [stats, setStats] = useState<ParseStats | null>(null);
  const [statusText, setStatusText] = useState("Use File > Open to begin");
  const [errorText, setErrorText] = useState("");
  const [pendingCitation, setPendingCitation] = useState<CitationHit | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(null);
  const [selectionAction, setSelectionAction] = useState<SelectionAction | null>(null);
  const [highlightMenu, setHighlightMenu] = useState<HighlightMenuState | null>(null);
  const [highlightColor, setHighlightColor] = useState<string>(HIGHLIGHT_COLORS[0]?.value ?? "#fce588");
  const [translationSettings, setTranslationSettings] = useState<TranslationSettings>(() => loadTranslationSettings());
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [focusedNoteId, setFocusedNoteId] = useState<string | null>(null);
  const [selectedAnnotationIds, setSelectedAnnotationIds] = useState<string[]>([]);

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  useEffect(() => {
    return () => {
      if (scrollApplyRafRef.current !== null) {
        window.cancelAnimationFrame(scrollApplyRafRef.current);
        scrollApplyRafRef.current = null;
      }
      if (pinchZoomRafRef.current !== null) {
        window.cancelAnimationFrame(pinchZoomRafRef.current);
        pinchZoomRafRef.current = null;
      }
    };
  }, []);

  const pageNumbers = useMemo(() => {
    if (!pdfDoc) {
      return [];
    }
    return Array.from({ length: pdfDoc.numPages }, (_unused, idx) => idx + 1);
  }, [pdfDoc]);

  const annotationsByPage = useMemo(() => {
    const map = new Map<number, AnnotationItem[]>();
    for (const annotation of annotations) {
      const list = map.get(annotation.page) ?? [];
      list.push(annotation);
      map.set(annotation.page, list);
    }
    return map;
  }, [annotations]);

  useEffect(() => {
    if (!api) {
      setStatusText("Desktop API unavailable");
      setErrorText("window.journalApi is missing. Restart the app.");
    }
  }, [api]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(TRANSLATION_SETTINGS_KEY, JSON.stringify(translationSettings));
  }, [translationSettings]);

  useEffect(() => {
    if (!selectionMenu) {
      return;
    }
    const close = (): void => setSelectionMenu(null);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setSelectionMenu(null);
      }
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [selectionMenu]);

  useEffect(() => {
    if (!selectionMenu || !selectionMenuRef.current) {
      return;
    }
    const rect = selectionMenuRef.current.getBoundingClientRect();
    const next = clampMenuAnchor(selectionMenu.x, selectionMenu.y, rect.width, rect.height);
    if (Math.abs(next.x - selectionMenu.x) < 1 && Math.abs(next.y - selectionMenu.y) < 1) {
      return;
    }
    setSelectionMenu((prev) => (prev ? { ...prev, x: next.x, y: next.y } : prev));
  }, [selectionMenu?.x, selectionMenu?.y, selectionMenu?.text]);

  useEffect(() => {
    if (!highlightMenu) {
      return;
    }
    const close = (): void => setHighlightMenu(null);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setHighlightMenu(null);
      }
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [highlightMenu]);

  useEffect(() => {
    if (!highlightMenu || !highlightMenuRef.current) {
      return;
    }
    const rect = highlightMenuRef.current.getBoundingClientRect();
    const next = clampMenuAnchor(highlightMenu.x, highlightMenu.y, rect.width, rect.height);
    if (Math.abs(next.x - highlightMenu.x) < 1 && Math.abs(next.y - highlightMenu.y) < 1) {
      return;
    }
    setHighlightMenu((prev) => (prev ? { ...prev, x: next.x, y: next.y } : prev));
  }, [highlightMenu?.x, highlightMenu?.y, highlightMenu?.annotationId]);

  useEffect(() => {
    if (!isSettingsOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setIsSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isSettingsOpen]);

  function clampScale(next: number): number {
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
  }

  const setScaleAroundPointer = useCallback((nextScale: number, clientX: number, clientY: number): void => {
      const currentScale = scaleRef.current;
      const targetScale = clampScale(nextScale);
      if (Math.abs(targetScale - currentScale) < 0.0001) {
        return;
      }

      const reader = readerRef.current;
      if (!reader) {
        scaleRef.current = targetScale;
        setScale(targetScale);
        return;
      }

      const rect = reader.getBoundingClientRect();
      const offsetX = clientX - rect.left;
      const offsetY = clientY - rect.top;
      const ratio = targetScale / currentScale;
      const baseScrollLeft = pendingScrollRef.current?.left ?? reader.scrollLeft;
      const baseScrollTop = pendingScrollRef.current?.top ?? reader.scrollTop;
      const nextScrollLeft = (baseScrollLeft + offsetX) * ratio - offsetX;
      const nextScrollTop = (baseScrollTop + offsetY) * ratio - offsetY;

      scaleRef.current = targetScale;
      pendingScrollRef.current = { left: nextScrollLeft, top: nextScrollTop };
      setScale(targetScale);
      if (scrollApplyRafRef.current !== null) {
        window.cancelAnimationFrame(scrollApplyRafRef.current);
      }
      scrollApplyRafRef.current = window.requestAnimationFrame(() => {
        scrollApplyRafRef.current = null;
        const container = readerRef.current;
        const pendingScroll = pendingScrollRef.current;
        if (!container) {
          return;
        }
        if (!pendingScroll) {
          return;
        }
        container.scrollLeft = pendingScroll.left;
        container.scrollTop = pendingScroll.top;
      });
    }, []);

  function handleReaderWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    if (!event.ctrlKey || !pdfDoc) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    pinchAccumulatedDeltaRef.current += event.deltaY;
    pinchPointerRef.current = { x: event.clientX, y: event.clientY };

    if (pinchZoomRafRef.current !== null) {
      return;
    }

    pinchZoomRafRef.current = window.requestAnimationFrame(() => {
      pinchZoomRafRef.current = null;
      const rawDeltaY = pinchAccumulatedDeltaRef.current;
      pinchAccumulatedDeltaRef.current = 0;
      const prevSmoothed = pinchSmoothedDeltaRef.current;
      const smoothedDeltaY = prevSmoothed + (rawDeltaY - prevSmoothed) * PINCH_SMOOTH_ALPHA;
      pinchSmoothedDeltaRef.current = smoothedDeltaY * 0.92;

      if (Math.abs(smoothedDeltaY) < PINCH_MIN_ABS_DELTA) {
        return;
      }

      const currentScale = scaleRef.current;
      const adaptiveGain = Math.max(0.0012, Math.min(0.00185, PINCH_BASE_GAIN - (currentScale - 1.3) * 0.0001));
      const zoomFactor = Math.exp(-smoothedDeltaY * adaptiveGain);
      const idealScale = currentScale * zoomFactor;
      const maxStep = Math.max(0.01, currentScale * PINCH_MAX_REL_STEP);
      const clampedStep = Math.max(-maxStep, Math.min(maxStep, idealScale - currentScale));
      const nextScale = clampScale(currentScale + clampedStep);
      setScaleAroundPointer(nextScale, pinchPointerRef.current.x, pinchPointerRef.current.y);
    });
  }

  const openPdfFromPath = useCallback(
    async (path: string): Promise<void> => {
      if (!api) {
        setStatusText("Desktop API unavailable");
        setErrorText("window.journalApi is missing. Restart the app.");
        return;
      }

      setErrorText("");
      setStatusText("Opening PDF...");
      try {
        const opened = await api.docOpen(path);
        const bytes = await api.docReadBinary(path);
        const loadingTask = getDocument({ data: new Uint8Array(bytes) });
        const loadedPdf = await loadingTask.promise;

        setDocId(opened.docId);
        setDocTitle(opened.title);
        setPdfDoc(loadedPdf);
        setActivePage(1);
        setPendingCitation(null);
        setAnnotations(await api.annotationList(opened.docId));

        const parsed = await api.docParse(opened.docId);
        setStats(parsed);
        setStatusText(`Loaded ${opened.title}`);
      } catch (error) {
        setErrorText(formatError(error));
        setStatusText("Failed to open PDF");
      }
    },
    [api],
  );

  useEffect(() => {
    const swallowFileDrag = (event: DragEvent): void => {
      if (!hasFileDragPayload(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    };

    const handleDragOver = (event: DragEvent): void => {
      swallowFileDrag(event);
    };

    const handleDrop = (event: DragEvent): void => {
      if (!hasFileDragPayload(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const path = extractDroppedPdfPath(event.dataTransfer, (file) => {
        if (!api || typeof api.resolveDroppedFilePath !== "function") {
          return null;
        }
        return api.resolveDroppedFilePath(file);
      });
      if (!path) {
        setStatusText("Dropped file is not a readable PDF path. Use File > Open.");
        return;
      }
      setStatusText(`Opening ${path.split("/").pop() || "PDF"}...`);
      void openPdfFromPath(path);
    };

    window.addEventListener("dragenter", swallowFileDrag);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("drop", handleDrop);
    return () => {
      window.removeEventListener("dragenter", swallowFileDrag);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("drop", handleDrop);
    };
  }, [openPdfFromPath]);

  useEffect(() => {
    if (!api || typeof api.onMenuFileOpen !== "function") {
      return;
    }
    return api.onMenuFileOpen((path: string) => {
      void openPdfFromPath(path);
    });
  }, [api, openPdfFromPath]);

  useEffect(() => {
    if (!api || typeof api.onAnnotationChanged !== "function" || !docId) {
      return;
    }
    return api.onAnnotationChanged((event) => {
      if (event.docId && event.docId !== docId) {
        return;
      }
      void api.annotationList(docId).then(setAnnotations).catch(() => {
        // keep current UI state if background sync fetch fails
      });
    });
  }, [api, docId]);

  useEffect(() => {
    setSelectedAnnotationIds([]);
    setFocusedNoteId(null);
  }, [docId]);

  async function openFigureFromResolved(resolved: { targetId: string | null; kind: string; label: string }): Promise<void> {
    if (!docId || !resolved.targetId) {
      return;
    }
    const normalizedKind = (resolved.kind === "table" || resolved.kind === "supplementary" ? resolved.kind : "figure") as TargetKind;
    const candidatesFromDb = await api.figureListTargets(docId, normalizedKind, resolved.label).catch(() => []);
    const fallbackTarget = await api.figureGetTarget(docId, resolved.targetId);
    const fallbackCandidate: FigureTargetCandidate = {
      id: resolved.targetId,
      docId,
      kind: normalizedKind,
      label: resolved.label,
      page: fallbackTarget.page,
      cropRect: fallbackTarget.cropRect,
      captionRect: fallbackTarget.captionRect,
      caption: fallbackTarget.caption,
      confidence: 0,
      source: "auto",
    };

    const candidates = candidatesFromDb.length > 0 ? candidatesFromDb : [fallbackCandidate];
    let chosen: FigureTargetCandidate = candidates[0] ?? fallbackCandidate;
    let chosenImagePage = chosen.page;
    let chosenCaptionPage = chosen.page;
    let chosenCaptionRect = chosen.captionRect;
    let chosenCropRect = chosen.cropRect;
    let chosenDetectionMode: "component" | "fallback" | null = null;

    if (pdfDoc) {
      const pageAreaCache = new Map<number, number>();
      const layoutDetectionCache = new Map<
        number,
        Promise<{ rect: Rect; mode: "component"; area: number; score: number } | null>
      >();
      const nearDetectionCache = new Map<
        string,
        Promise<{ rect: Rect; mode: "component" | "fallback"; area: number; score: number } | null>
      >();
      let bestScore = Number.NEGATIVE_INFINITY;

      const getPageArea = async (pageNumber: number): Promise<number> => {
        let pageArea = pageAreaCache.get(pageNumber);
        if (pageArea) {
          return pageArea;
        }
        const page = await pdfDoc.getPage(pageNumber);
        const pageRect = toPdfPageRect(page);
        pageArea = Math.max(1, pageRect.w * pageRect.h);
        pageAreaCache.set(pageNumber, pageArea);
        return pageArea;
      };

      const detectLayout = (pageNumber: number): Promise<{ rect: Rect; mode: "component"; area: number; score: number } | null> => {
        const cached = layoutDetectionCache.get(pageNumber);
        if (cached) {
          return cached;
        }
        const pending = detectVisualRegionByPageLayout(pdfDoc, pageNumber, normalizedKind).catch(() => null);
        layoutDetectionCache.set(pageNumber, pending);
        return pending;
      };

      const detectNearCaption = (
        candidate: FigureTargetCandidate,
        allowFallback: boolean,
      ): Promise<{ rect: Rect; mode: "component" | "fallback"; area: number; score: number } | null> => {
        if (!candidate.captionRect) {
          return Promise.resolve(null);
        }
        const key = `${candidate.id}:${candidate.page}:${allowFallback ? "1" : "0"}`;
        const cached = nearDetectionCache.get(key);
        if (cached) {
          return cached;
        }
        const pending = detectVisualRegionNearCaption(pdfDoc, candidate.page, candidate.captionRect, normalizedKind, {
          allowFallback,
        }).catch(() => null);
        nearDetectionCache.set(key, pending);
        return pending;
      };

      const considerCandidate = async (
        candidate: FigureTargetCandidate,
        imagePage: number,
        detection: { rect: Rect; mode: "component" | "fallback"; area: number; score: number },
        scoreBias = 0,
      ): Promise<void> => {
        const pageArea = await getPageArea(imagePage);
        const areaRatio = detection.area / pageArea;
        if (areaRatio < 0.01 || areaRatio > 0.94) {
          return;
        }
        const exactBonus = candidate.label.toUpperCase() === resolved.label.toUpperCase() ? 0.08 : 0;
        const manualBonus = candidate.source === "manual" ? 1 : 0;
        const score =
          areaRatio * 130 + detection.score * 0.008 + candidate.confidence + exactBonus + manualBonus + scoreBias;
        if (score > bestScore) {
          bestScore = score;
          chosen = candidate;
          chosenImagePage = imagePage;
          chosenCaptionPage = candidate.page;
          chosenCaptionRect = candidate.captionRect;
          chosenCropRect = detection.rect;
          chosenDetectionMode = detection.mode;
        }
      };

      for (const candidate of candidates) {
        const captionPage = Math.max(1, Math.min(pdfDoc.numPages, candidate.page));
        const looksLikePlaceholder = /\bsee\s+next\s+page\s+for\s+caption\b/i.test(candidate.caption);

        if (candidate.captionRect) {
          const near = await detectNearCaption(candidate, false);
          if (near?.mode === "component") {
            const placeholderPenalty = looksLikePlaceholder ? -6 : 5;
            await considerCandidate(candidate, captionPage, near, placeholderPenalty);
          }
        }

        const probeRadius = looksLikePlaceholder ? 3 : 2;
        const probePages = new Set<number>([captionPage]);
        for (let step = 1; step <= probeRadius; step += 1) {
          if (captionPage - step >= 1) {
            probePages.add(captionPage - step);
          }
          if (captionPage + step <= pdfDoc.numPages) {
            probePages.add(captionPage + step);
          }
        }

        for (const probePage of probePages) {
          const detected = await detectLayout(probePage);
          if (!detected) {
            continue;
          }
          const distancePenalty = Math.abs(probePage - captionPage) * (normalizedKind === "table" ? 4.5 : 5.8);
          const forwardBonus = looksLikePlaceholder && probePage > captionPage ? 8 : 0;
          const samePagePlaceholderPenalty = looksLikePlaceholder && probePage === captionPage ? -9 : 0;
          await considerCandidate(candidate, probePage, detected, forwardBonus + samePagePlaceholderPenalty - distancePenalty);
        }
      }

      if (chosenDetectionMode !== "component" && chosen.captionRect) {
        const fallbackDetected = await detectNearCaption(chosen, true);
        if (fallbackDetected) {
          chosenImagePage = chosen.page;
          chosenCaptionPage = chosen.page;
          chosenCaptionRect = chosen.captionRect;
          chosenCropRect = fallbackDetected.rect;
          chosenDetectionMode = fallbackDetected.mode;
        }
      }
    }

    const target = chosen.id === resolved.targetId ? fallbackTarget : await api.figureGetTarget(docId, chosen.id);
    let imageDataUrl = target.imageDataUrl;
    let pageImageDataUrl: string | undefined;
    let popupPageRect: Rect | undefined;
    if (pdfDoc) {
      const pageImage = await renderPageImage(pdfDoc, chosenImagePage).catch(() => null);
      if (pageImage) {
        pageImageDataUrl = pageImage.imageDataUrl;
        popupPageRect = pageImage.pageRect;
      }
      const rendered = await renderTargetCropImage(pdfDoc, chosenImagePage, chosenCropRect, {
        trim: chosenDetectionMode === "component",
      }).catch(() => null);
      if (rendered) {
        imageDataUrl = rendered;
      }
    }

    await api.figureOpenPopup({
      docId,
      targetId: chosen.id,
      caption: chosen.caption,
      imageDataUrl,
      pageImageDataUrl,
      page: chosenImagePage,
      pageRect: popupPageRect,
      focusRect: chosenCropRect,
      captionPage: chosenCaptionPage,
      captionRect: chosenCaptionRect,
    });
    setPendingCitation(null);
    const modeNote =
      chosenDetectionMode === "component"
        ? "layout match"
        : chosenDetectionMode === "fallback"
          ? "fallback crop"
          : "stored crop";
    setStatusText(`Opened ${resolved.kind} ${resolved.label} (${modeNote})`);
  }

  function handleSelectionMenuRequest(payload: SelectionMenuState): void {
    setActivePage(payload.page);
    setHighlightMenu(null);
    const clamped = clampMenuAnchor(payload.x, payload.y, 290, 320);
    setSelectionMenu({
      ...payload,
      x: clamped.x,
      y: clamped.y,
    });
  }

  function triggerSelectionAction(kind: SelectionAction["kind"], page: number): void {
    const nextId = selectionActionSeqRef.current + 1;
    selectionActionSeqRef.current = nextId;
    setSelectionAction({ id: nextId, kind, page });
  }

  function handleHighlightToolPress(): void {
    setToolMode("highlight");
    const selection = window.getSelection();
    const selected = normalizeSnippetText(selection?.toString() ?? "");
    if (!selection || selection.isCollapsed || !selected) {
      return;
    }
    const page = selectionToPage(selection) ?? activePage;
    triggerSelectionAction("highlight", page);
    setStatusText("Applied highlight to current selection");
  }

  function handleHighlightToolMouseDown(event: ReactMouseEvent<HTMLButtonElement>): void {
    const selection = window.getSelection();
    const selected = normalizeSnippetText(selection?.toString() ?? "");
    if (!selection || selection.isCollapsed || !selected) {
      return;
    }
    event.preventDefault();
    setToolMode("highlight");
    const page = selectionToPage(selection) ?? activePage;
    triggerSelectionAction("highlight", page);
    setStatusText("Applied highlight to current selection");
  }

  function highlightFromSelectionMenu(): void {
    if (!selectionMenu) {
      return;
    }
    setToolMode("highlight");
    triggerSelectionAction("highlight", selectionMenu.page);
    setSelectionMenu(null);
    setStatusText("Highlight created");
  }

  async function copyFromSelectionMenu(): Promise<void> {
    if (!selectionMenu) {
      return;
    }
    try {
      await copyTextToClipboard(selectionMenu.text);
      setStatusText("Copied selection");
    } catch (error) {
      setErrorText(formatError(error));
      setStatusText("Copy failed");
    } finally {
      setSelectionMenu(null);
    }
  }

  async function searchFromSelectionMenu(): Promise<void> {
    if (!selectionMenu) {
      return;
    }
    const query = selectionMenu.text.trim();
    if (!query) {
      setSelectionMenu(null);
      return;
    }
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    try {
      await api.openExternal(url);
      setStatusText("Opened web search");
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
      setStatusText("Opened web search");
    } finally {
      setSelectionMenu(null);
    }
  }

  async function translateFromSelectionMenu(): Promise<void> {
    if (!selectionMenu) {
      return;
    }
    const text = selectionMenu.text.trim();
    if (!text) {
      setSelectionMenu(null);
      return;
    }
    try {
      setErrorText("");
      setStatusText("Translating selection...");
      const translated = await api.translateText({
        text,
        sourceLang: translationSettings.sourceLang,
        targetLang: translationSettings.targetLang,
        provider: translationSettings.provider,
      });
      await api.translateOpenPopup({
        sourceText: text,
        translatedText: translated.translatedText,
        provider: translated.provider,
        sourceLang: translated.sourceLang,
        targetLang: translated.targetLang,
        detectedSourceLang: translated.detectedSourceLang,
      });
      setStatusText(`Translation opened (${translated.provider})`);
    } catch (error) {
      const reason = formatError(error);
      const browserUrl = `https://translate.google.com/?sl=${encodeURIComponent(
        translationSettings.sourceLang || "auto",
      )}&tl=${encodeURIComponent(translationSettings.targetLang || "en")}&text=${encodeURIComponent(text)}&op=translate`;
      try {
        await api.openExternal(browserUrl);
        setStatusText("Opened translation in browser");
        setErrorText("");
      } catch {
        setStatusText("Translation failed");
        setErrorText(reason);
      }
    } finally {
      setSelectionMenu(null);
    }
  }

  async function openReferenceFromSelection(): Promise<void> {
    if (!docId || !selectionMenu) {
      return;
    }
    try {
      setErrorText("");
      const indices = extractReferenceIndices(selectionMenu.text);
      let entries = indices.length > 0 ? await api.referenceGetEntries(docId, indices) : [];
      if (entries.length === 0) {
        entries = await api.referenceSearchByText(docId, selectionMenu.text, 12);
      }
      const resolvedIndices = entries.map((entry) => entry.index);
      if (entries.length === 0) {
        const hasAny = await api.referenceHasEntries(docId);
        if (!hasAny) {
          setStatusText("No reference list detected in this PDF");
          setErrorText("No parsable reference list was detected in this PDF.");
        } else {
          setStatusText("No matched references found for selected text");
          setErrorText("Try selecting a full citation marker like '16,17' or '(Tan et al., 2018)'.");
        }
      } else {
        if (indices.length > 0) {
          setStatusText(`Opened references ${resolvedIndices.join(", ")}`);
        } else {
          setStatusText(`Opened ${entries.length} matched references`);
        }
      }
      await api.referenceOpenPopup({ indices: resolvedIndices, entries });
      setSelectionMenu(null);
    } catch (error) {
      setStatusText("Failed to open references from selection");
      setErrorText(formatError(error));
      setSelectionMenu(null);
    }
  }

  async function openFigureFromSelection(): Promise<void> {
    if (!docId || !selectionMenu) {
      return;
    }
    try {
      setErrorText("");
      const parsed = parseCitationSelection(selectionMenu.text);
      const fallbackLabel = extractAnyFigureLikeLabel(selectionMenu.text);

      const attempts: Array<{ kind: TargetKind; label: string }> = [];
      if (parsed) {
        attempts.push(parsed);
      }
      if (fallbackLabel) {
        const already = attempts.some((item) => item.label === fallbackLabel);
        if (!already) {
          attempts.push({ kind: "figure", label: fallbackLabel });
          attempts.push({ kind: "table", label: fallbackLabel });
          attempts.push({ kind: "supplementary", label: fallbackLabel });
        }
      }

      if (attempts.length === 0) {
        setStatusText("No figure/table citation recognized in selected text");
        setErrorText("Select text like Fig. 1b / Table 2 / Extended Data Fig. 3.");
        setSelectionMenu(null);
        return;
      }

      let opened = false;
      for (const attempt of attempts) {
        const resolved = await api.citationResolveByLabel(docId, attempt.kind, attempt.label);
        if (resolved?.targetId) {
          await openFigureFromResolved(resolved);
          opened = true;
          break;
        }
      }

      if (!opened) {
        const first = attempts[0];
        setStatusText(`No mapped target found for ${first?.kind ?? "citation"} ${first?.label ?? ""}`);
        setErrorText("Try selecting the full token (e.g. 'Fig. 1b') and run Re-parse once.");
      }
      setSelectionMenu(null);
    } catch (error) {
      setStatusText("Failed to open figure/table from selection");
      setErrorText(formatError(error));
      setSelectionMenu(null);
    }
  }

  async function openRecognizedPopup(kind: RecognizedPopupKind): Promise<void> {
    if (!docId) {
      return;
    }
    try {
      setErrorText("");
      const opened = await api.recognizedOpenPopup(docId, kind);
      if (!opened) {
        setStatusText("Recognized list is currently unavailable");
        setErrorText("Could not open recognized popup window. Please restart the app and try again.");
        return;
      }
      const label = kind === "ref" ? "references" : kind;
      setStatusText(`Opened recognized ${label}`);
    } catch (error) {
      setStatusText("Failed to open recognized list");
      setErrorText(formatError(error));
    }
  }

  async function createHighlight(pageNumber: number, rects: Rect[], selectedText?: string): Promise<void> {
    if (!docId || rects.length === 0) {
      return;
    }
    const snippet = normalizeSnippetText(selectedText ?? "");
    const created = await api.annotationCreate({
      docId,
      page: pageNumber,
      kind: "highlight",
      rects,
      color: highlightColor,
      text: snippet || undefined,
    });
    setAnnotations((prev) => [...prev, created]);
    setStatusText("Highlight created");
  }

  async function createTextNote(pageNumber: number, point: { x: number; y: number }): Promise<void> {
    if (!docId) {
      return;
    }
    const created = await api.annotationCreate({
      docId,
      page: pageNumber,
      kind: "text-note",
      rects: [{ x: point.x, y: point.y, w: 180, h: 46 }],
      text: "",
      style: {
        fontSize: 28,
        fontFamily: NOTE_FONTS[0].value,
        textColor: "#db4638",
      },
    });
    setAnnotations((prev) => [...prev, created]);
    setFocusedNoteId(created.id);
    setSelectedAnnotationIds([created.id]);
    setToolMode("none");
    setStatusText("Text note created");
  }

  async function createSticky(pageNumber: number, point: { x: number; y: number }): Promise<void> {
    if (!docId) {
      return;
    }
    const created = await api.annotationCreate({
      docId,
      page: pageNumber,
      kind: "sticky-note",
      rects: [{ x: point.x, y: point.y, w: 22, h: 22 }],
      text: "",
      style: {
        fontSize: 13,
        fontFamily: NOTE_FONTS[0].value,
        textColor: "#29384b",
      },
    });
    setAnnotations((prev) => [...prev, created]);
    setFocusedNoteId(created.id);
    setSelectedAnnotationIds([created.id]);
    setToolMode("none");
    setStatusText("Sticky note created");
  }

  async function handleHighlightClick(annotation: AnnotationItem): Promise<void> {
    if (!docId || annotation.kind !== "highlight") {
      return;
    }

    const ok = window.confirm("Delete this highlight?");
    if (!ok) {
      return;
    }
    const deleted = await api.annotationDelete(annotation.id);
    if (deleted) {
      setAnnotations((prev) => prev.filter((item) => item.id !== annotation.id));
      setStatusText("Highlight deleted");
    }
  }

  async function updateAnnotation(id: string, patch: Partial<AnnotationItem>): Promise<void> {
    if (!docId) {
      return;
    }
    const updated = await api.annotationUpdate({
      id,
      ...patch,
    });
    if (updated) {
      setAnnotations((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    }
  }

  function updateAnnotationSelection(ids: string[], mode: "replace" | "add" | "toggle"): void {
    const uniqueIds = Array.from(new Set(ids));
    if (mode === "replace") {
      setSelectedAnnotationIds(uniqueIds);
      return;
    }
    if (mode === "add") {
      setSelectedAnnotationIds((prev) => Array.from(new Set([...prev, ...uniqueIds])));
      return;
    }
    setSelectedAnnotationIds((prev) => {
      const next = new Set(prev);
      for (const id of uniqueIds) {
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }
      return Array.from(next);
    });
  }

  async function moveSelectedAnnotations(ids: string[], dx: number, dy: number): Promise<void> {
    if (!docId || ids.length === 0 || (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01)) {
      return;
    }
    const idSet = new Set(ids);
    const movable = annotations.filter(
      (annotation) => idSet.has(annotation.id) && (annotation.kind === "text-note" || annotation.kind === "sticky-note"),
    );
    if (movable.length === 0) {
      return;
    }

    const nextRects = new Map<string, Rect[]>();
    for (const annotation of movable) {
      nextRects.set(
        annotation.id,
        annotation.rects.map((rect) => ({
          ...rect,
          x: rect.x + dx,
          y: rect.y + dy,
        })),
      );
    }

    setAnnotations((prev) =>
      prev.map((annotation) => {
        const rects = nextRects.get(annotation.id);
        if (!rects) {
          return annotation;
        }
        return { ...annotation, rects };
      }),
    );

    const updatedList = await Promise.all(
      Array.from(nextRects.entries()).map(async ([id, rects]) => api.annotationUpdate({ id, rects })),
    );
    setAnnotations((prev) =>
      prev.map((annotation) => {
        const updated = updatedList.find((item) => item?.id === annotation.id);
        return updated ?? annotation;
      }),
    );
    setStatusText(`Moved ${movable.length} note${movable.length > 1 ? "s" : ""}`);
  }

  async function deleteSelectedAnnotations(): Promise<void> {
    if (!docId || selectedAnnotationIds.length === 0) {
      return;
    }
    const noteIds = selectedAnnotationIds.filter((id) =>
      annotations.some((annotation) => annotation.id === id && (annotation.kind === "text-note" || annotation.kind === "sticky-note")),
    );
    if (noteIds.length === 0) {
      return;
    }
    const results = await Promise.all(noteIds.map(async (id) => ({ id, ok: await api.annotationDelete(id) })));
    const deletedIds = results.filter((item) => item.ok).map((item) => item.id);
    if (deletedIds.length === 0) {
      return;
    }
    const deletedSet = new Set(deletedIds);
    setAnnotations((prev) => prev.filter((annotation) => !deletedSet.has(annotation.id)));
    setSelectedAnnotationIds((prev) => prev.filter((id) => !deletedSet.has(id)));
    if (focusedNoteId && deletedSet.has(focusedNoteId)) {
      setFocusedNoteId(null);
    }
    setStatusText(`Deleted ${deletedIds.length} note${deletedIds.length > 1 ? "s" : ""}`);
  }

  async function deleteAnnotation(id: string, label: string): Promise<void> {
    if (!docId) {
      return;
    }
    const deleted = await api.annotationDelete(id);
    if (!deleted) {
      return;
    }
    setAnnotations((prev) => prev.filter((item) => item.id !== id));
    if (focusedNoteId === id) {
      setFocusedNoteId(null);
    }
    if (highlightMenu?.annotationId === id) {
      setHighlightMenu(null);
    }
    setSelectedAnnotationIds((prev) => prev.filter((item) => item !== id));
    setStatusText(`${label} deleted`);
  }

  function openHighlightMenuAt(annotation: AnnotationItem, x: number, y: number): void {
    if (annotation.kind !== "highlight") {
      return;
    }
    setSelectionMenu(null);
    const clamped = clampMenuAnchor(x, y, 240, 190);
    setHighlightMenu({
      x: clamped.x,
      y: clamped.y,
      annotationId: annotation.id,
    });
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Delete" && event.key !== "Backspace") {
        return;
      }
      if (isEditableElement(document.activeElement)) {
        return;
      }
      if (selectedAnnotationIds.length === 0) {
        return;
      }
      event.preventDefault();
      void deleteSelectedAnnotations();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedAnnotationIds, annotations, docId, focusedNoteId]);

  async function applyHighlightColor(annotationId: string, color: string): Promise<void> {
    await updateAnnotation(annotationId, { color });
    setHighlightMenu(null);
    setStatusText("Highlight color updated");
  }

  async function bindManualRect(pageNumber: number, pdfRect: Rect): Promise<void> {
    if (!docId || !pendingCitation) {
      return;
    }
    if (!pendingCitation.citationId) {
      setErrorText("Cannot bind manually because citation id was not returned by resolver.");
      return;
    }

    const captionText = window.prompt(
      `Manual caption for ${pendingCitation.kind} ${pendingCitation.label}`,
      `${pendingCitation.kind} ${pendingCitation.label}`,
    );
    if (!captionText || !captionText.trim()) {
      return;
    }

    await api.mappingBindManually(docId, pendingCitation.citationId, pdfRect, captionText.trim(), pageNumber);
    const parsed = await api.docParse(docId);
    setStats(parsed);
    setStatusText(`Bound ${pendingCitation.kind} ${pendingCitation.label} manually`);
    setPendingCitation(null);
    setToolMode("none");
  }

  async function savePdf(): Promise<void> {
    if (!docId) {
      return;
    }
    const result = await api.annotationSaveToPdf(docId);
    setStatusText(`Saved to PDF (${result.overwrittenPath}); backup at ${result.backupPath}`);
  }

  async function refreshAnnotations(): Promise<void> {
    if (!docId) {
      return;
    }
    setAnnotations(await api.annotationReloadFromPdf(docId));
    setStatusText("Reloaded annotations from PDF");
  }

  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="title-block">
          <div className="app-name">Journal Reader</div>
          <div className="doc-name">{docTitle}</div>
        </div>

        <div className="tool-strip">
          <div className="tool-group">
            <ToolButton
              title="Re-parse document (refresh figure/reference mapping)"
              onClick={() => void (docId ? api.docParse(docId).then(setStats) : Promise.resolve())}
            >
              <IconGlyph d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" />
            </ToolButton>
            <ToolButton title="Pointer mode (select and right-click for actions)" active={toolMode === "none"} onClick={() => setToolMode("none")}>
              <IconGlyph d="M5 3l6 16 2-6 6-2z" />
            </ToolButton>
            <ToolButton
              title="Highlight mode (if text is selected, apply highlight immediately)"
              active={toolMode === "highlight"}
              onMouseDown={handleHighlightToolMouseDown}
              onClick={handleHighlightToolPress}
            >
              <IconGlyph d="M3 17h10m4-10 4 4-7 7H10V14z" />
            </ToolButton>
            <ToolButton title="Text note mode (click page to insert editable note box)" active={toolMode === "text-note"} onClick={() => setToolMode("text-note")}>
              <IconGlyph d="M5 5h14v10H9l-4 4zM8 9h8M8 12h6" />
            </ToolButton>
            <ToolButton title="Sticky note mode (click page to place note)" active={toolMode === "sticky"} onClick={() => setToolMode("sticky")}>
              <IconGlyph d="M5 4h14v14l-4-3-4 3-4-3-2 2z" />
            </ToolButton>
            <div className="color-palette" title="Highlight color">
              {HIGHLIGHT_COLORS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`color-swatch${highlightColor === option.value ? " active" : ""}`}
                  style={{ backgroundColor: option.value }}
                  title={`Highlight color: ${option.label}`}
                  onClick={() => setHighlightColor(option.value)}
                />
              ))}
            </div>
          </div>

          <div className="tool-group">
            <ToolButton title="Save annotations into the original PDF" primary onClick={() => void savePdf()}>
              <IconGlyph d="M5 4h12l2 2v14H5zM8 4v5h8V4M8 20v-6h8v6" />
            </ToolButton>
            <ToolButton title="Discard unsaved edits and reload annotations from PDF" onClick={() => void refreshAnnotations()}>
              <IconGlyph d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5M8 9h5M8 13h7" />
            </ToolButton>
            <ToolButton title="Translation settings" onClick={() => setIsSettingsOpen(true)}>
              <IconGlyph d="M12 3v2M12 19v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M3 12h2M19 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8" />
            </ToolButton>
          </div>

          {pdfDoc ? (
            <div className="topbar-page-controls">
              <span>
                {activePage} / {pdfDoc.numPages}
              </span>
              <ToolButton title="Zoom Out" onClick={() => setScale((s) => clampScale(s - 0.1))}>
                <IconGlyph d="M5 12h14" />
              </ToolButton>
              <ToolButton title="Zoom In" onClick={() => setScale((s) => clampScale(s + 0.1))}>
                <IconGlyph d="M5 12h14M12 5v14" />
              </ToolButton>
              <span>{Math.round(scale * 100)}%</span>
            </div>
          ) : null}
        </div>

        <div className="status">{statusText}</div>
      </div>

      <div ref={readerRef} className="reader" onWheel={handleReaderWheel}>
        {pdfDoc ? (
          <div className="pages-column">
            {pageNumbers.map((pageNumber) => (
              <PdfPageSurface
                key={pageNumber}
                pdfDoc={pdfDoc}
                scrollRootRef={readerRef}
                pageNumber={pageNumber}
                scale={scale}
                toolMode={toolMode}
                annotations={annotationsByPage.get(pageNumber) ?? []}
                onActivate={setActivePage}
                onCreateHighlight={createHighlight}
                onCreateTextNote={createTextNote}
                onCreateSticky={createSticky}
                onManualBindRect={bindManualRect}
                onSelectionMenu={handleSelectionMenuRequest}
                selectionAction={selectionAction}
                focusedNoteId={focusedNoteId}
                onFocusNote={setFocusedNoteId}
                selectedAnnotationIds={selectedAnnotationIds}
                onSelectionChange={updateAnnotationSelection}
                onMoveAnnotations={moveSelectedAnnotations}
                onHighlightClick={handleHighlightClick}
                onHighlightContextMenu={openHighlightMenuAt}
                onAnnotationUpdate={updateAnnotation}
                onAnnotationDelete={deleteAnnotation}
              />
            ))}
          </div>
        ) : (
          <div>Load a PDF file to start reading.</div>
        )}
      </div>

      <div className="footer">
        {stats ? (
          <div className="recognized-bar">
            <span className="recognized-label">recognized</span>
            <button type="button" className="recognized-chip" onClick={() => void openRecognizedPopup("ref")}>
              refs {stats.refsCount}
            </button>
            <button type="button" className="recognized-chip" onClick={() => void openRecognizedPopup("fig")}>
              fig {stats.figuresCount}
            </button>
            <button type="button" className="recognized-chip" onClick={() => void openRecognizedPopup("table")}>
              table {stats.tablesCount}
            </button>
            <button type="button" className="recognized-chip" onClick={() => void openRecognizedPopup("supp")}>
              supp {stats.suppCount}
            </button>
          </div>
        ) : (
          <div>{"recognized -> (not parsed yet)"}</div>
        )}
      </div>

      {selectionMenu ? (
        <div
          ref={selectionMenuRef}
          className="selection-context-menu"
          style={{ left: `${selectionMenu.x}px`, top: `${selectionMenu.y}px` }}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <div className="selection-menu-label">{selectionMenu.text.slice(0, 88)}</div>
          <button className="selection-menu-item" onClick={highlightFromSelectionMenu}>
            Highlight
          </button>
          <button className="selection-menu-item" onClick={() => void copyFromSelectionMenu()}>
            Copy
          </button>
          <button className="selection-menu-item" onClick={() => void searchFromSelectionMenu()}>
            Search with Google
          </button>
          <button className="selection-menu-item" onClick={() => void translateFromSelectionMenu()}>
            Translate Selection
          </button>
          <div className="selection-menu-sep" />
          <button className="selection-menu-item" onClick={() => void openFigureFromSelection()}>
            Open Figure/Table
          </button>
          <button className="selection-menu-item" onClick={() => void openReferenceFromSelection()}>
            Open Reference
          </button>
        </div>
      ) : null}

      {highlightMenu ? (
        <div
          ref={highlightMenuRef}
          className="selection-context-menu"
          style={{ left: `${highlightMenu.x}px`, top: `${highlightMenu.y}px` }}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <div className="selection-menu-label">Highlight Color</div>
          <div className="highlight-menu-colors">
            {HIGHLIGHT_COLORS.map((option) => (
              <button
                key={option.value}
                type="button"
                className="color-swatch"
                style={{ backgroundColor: option.value }}
                title={option.label}
                onClick={() => void applyHighlightColor(highlightMenu.annotationId, option.value)}
              />
            ))}
          </div>
          <div className="selection-menu-sep" />
          <button
            className="selection-menu-item danger"
            onClick={() => void deleteAnnotation(highlightMenu.annotationId, "Highlight")}
          >
            Delete Highlight
          </button>
        </div>
      ) : null}

      {isSettingsOpen ? (
        <div
          className="settings-overlay"
          onClick={() => setIsSettingsOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
        >
          <div
            className="settings-panel"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <div className="settings-head">
              <div className="settings-title">Settings</div>
              <button type="button" className="settings-close" onClick={() => setIsSettingsOpen(false)}>
                ×
              </button>
            </div>

            <div className="settings-section">
              <div className="settings-subtitle">Translation</div>
              <label className="settings-field">
                <span>Provider</span>
                <select
                  value={translationSettings.provider}
                  onChange={(event) =>
                    setTranslationSettings((prev) => ({
                      ...prev,
                      provider: event.target.value as TranslateProvider,
                    }))
                  }
                >
                  {TRANSLATION_PROVIDERS.map((provider) => (
                    <option key={provider.value} value={provider.value}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="settings-field">
                <span>Source language</span>
                <select
                  value={translationSettings.sourceLang}
                  onChange={(event) =>
                    setTranslationSettings((prev) => ({
                      ...prev,
                      sourceLang: event.target.value,
                    }))
                  }
                >
                  {TRANSLATION_LANGUAGES.map((lang) => (
                    <option key={lang.value} value={lang.value}>
                      {lang.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="settings-field">
                <span>Target language</span>
                <select
                  value={translationSettings.targetLang}
                  onChange={(event) =>
                    setTranslationSettings((prev) => ({
                      ...prev,
                      targetLang: event.target.value,
                    }))
                  }
                >
                  {TRANSLATION_LANGUAGES.filter((lang) => lang.value !== "auto").map((lang) => (
                    <option key={lang.value} value={lang.value}>
                      {lang.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="settings-hint">Used by right-click menu: Translate Selection</div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PdfPageSurface({
  pdfDoc,
  scrollRootRef,
  pageNumber,
  scale,
  toolMode,
  annotations,
  onActivate,
  onCreateHighlight,
  onCreateTextNote,
  onCreateSticky,
  onManualBindRect,
  onSelectionMenu,
  selectionAction,
  focusedNoteId,
  onFocusNote,
  selectedAnnotationIds,
  onSelectionChange,
  onMoveAnnotations,
  onHighlightClick,
  onHighlightContextMenu,
  onAnnotationUpdate,
  onAnnotationDelete,
}: {
  pdfDoc: PDFDocumentProxy;
  scrollRootRef: RefObject<HTMLDivElement>;
  pageNumber: number;
  scale: number;
  toolMode: ToolMode;
  annotations: AnnotationItem[];
  onActivate: (pageNumber: number) => void;
  onCreateHighlight: (pageNumber: number, rects: Rect[], selectedText?: string) => Promise<void>;
  onCreateTextNote: (pageNumber: number, point: { x: number; y: number }) => Promise<void>;
  onCreateSticky: (pageNumber: number, point: { x: number; y: number }) => Promise<void>;
  onManualBindRect: (pageNumber: number, rect: Rect) => Promise<void>;
  onSelectionMenu: (payload: SelectionMenuState) => void;
  selectionAction: SelectionAction | null;
  focusedNoteId: string | null;
  onFocusNote: (annotationId: string | null) => void;
  selectedAnnotationIds: string[];
  onSelectionChange: (ids: string[], mode: "replace" | "add" | "toggle") => void;
  onMoveAnnotations: (ids: string[], dx: number, dy: number) => Promise<void>;
  onHighlightClick: (annotation: AnnotationItem) => Promise<void>;
  onHighlightContextMenu: (annotation: AnnotationItem, x: number, y: number) => void;
  onAnnotationUpdate: (id: string, patch: Partial<AnnotationItem>) => Promise<void>;
  onAnnotationDelete: (id: string, label: string) => Promise<void>;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const pageWrapRef = useRef<HTMLDivElement | null>(null);
  const renderTaskRef = useRef<PdfRenderTask | null>(null);
  const renderSeqRef = useRef(0);
  const [isNearViewport, setIsNearViewport] = useState(pageNumber <= 3);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [manualBindDragState, setManualBindDragState] = useState<DragState>(null);
  const [marqueeState, setMarqueeState] = useState<MarqueeState>(null);
  const [noteMoveState, setNoteMoveState] = useState<NoteMoveState>(null);
  const shouldRender = isNearViewport;

  useEffect(() => {
    const target = pageWrapRef.current;
    if (!target) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) {
          return;
        }
        setIsNearViewport(entry.isIntersecting || entry.intersectionRatio > 0);
      },
      {
        root: scrollRootRef.current,
        rootMargin: "1000px 0px 1000px 0px",
        threshold: 0.01,
      },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [scrollRootRef, pageNumber]);

  useEffect(() => {
    if (pageSize) {
      return;
    }
    if (!isNearViewport && pageNumber > 4) {
      return;
    }
    let alive = true;
    void (async () => {
      const page = await pdfDoc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      if (!alive) {
        return;
      }
      setPageSize({
        width: Math.max(1, Math.floor(viewport.width)),
        height: Math.max(1, Math.floor(viewport.height)),
      });
    })();
    return () => {
      alive = false;
    };
  }, [pdfDoc, pageNumber, pageSize, isNearViewport]);

  useEffect(() => {
    if (!shouldRender) {
      renderSeqRef.current += 1;
      try {
        renderTaskRef.current?.cancel();
      } catch {
        // noop
      }
      return;
    }

    void renderPage().catch(() => {
      // page-level render errors are surfaced via empty page; keep app responsive
    });

    return () => {
      renderSeqRef.current += 1;
      try {
        renderTaskRef.current?.cancel();
      } catch {
        // noop
      }
    };
  }, [pdfDoc, pageNumber, scale, toolMode, shouldRender]);

  async function renderPage(): Promise<void> {
    if (!canvasRef.current || !textLayerRef.current || !shouldRender) {
      return;
    }

    const seq = ++renderSeqRef.current;
    if (renderTaskRef.current) {
      const previousTask = renderTaskRef.current;
      renderTaskRef.current = null;
      try {
        previousTask.cancel();
      } catch {
        // noop
      }
      try {
        await previousTask.promise;
      } catch {
        // noop
      }
    }

    const page = await pdfDoc.getPage(pageNumber);
    if (seq !== renderSeqRef.current) {
      return;
    }

    const viewport = page.getViewport({ scale });
    setPageSize({
      width: Math.max(1, Math.floor(viewport.width / Math.max(0.01, scale))),
      height: Math.max(1, Math.floor(viewport.height / Math.max(0.01, scale))),
    });
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const outputScale = Math.max(1, Math.min(1.6, window.devicePixelRatio || 1));
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    const transform = outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];

    const renderTask = page.render({ canvasContext: context, viewport, transform }) as unknown as PdfRenderTask;
    renderTaskRef.current = renderTask;
    try {
      await renderTask.promise;
    } catch (error) {
      if (isRenderCancelled(error)) {
        return;
      }
      throw error;
    } finally {
      if (renderTaskRef.current === renderTask) {
        renderTaskRef.current = null;
      }
    }
    if (seq !== renderSeqRef.current) {
      return;
    }

    const textLayer = textLayerRef.current;
    textLayer.innerHTML = "";
    textLayer.onclick = null;
    textLayer.style.width = `${Math.floor(viewport.width)}px`;
    textLayer.style.height = `${Math.floor(viewport.height)}px`;

    const content = await page.getTextContent();
    if (seq !== renderSeqRef.current) {
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const item of content.items) {
      if (!("str" in item && "transform" in item)) {
        continue;
      }

      const span = document.createElement("span");
      const tx = Util.transform(viewport.transform, item.transform);
      const width = "width" in item ? item.width * scale : 8;
      const height = "height" in item ? item.height * scale : 12;

      span.textContent = item.str;
      span.className = "text-span";
      span.style.left = `${tx[4]}px`;
      span.style.top = `${tx[5] - height}px`;
      span.style.fontSize = `${height}px`;
      span.style.width = `${Math.max(1, width)}px`;
      span.style.height = `${Math.max(1, height + 2)}px`;
      fragment.appendChild(span);
    }
    textLayer.appendChild(fragment);

  }

  function intersectsWrap(rect: DOMRect, wrapRect: DOMRect): boolean {
    return !(
      rect.right <= wrapRect.left ||
      rect.left >= wrapRect.right ||
      rect.bottom <= wrapRect.top ||
      rect.top >= wrapRect.bottom
    );
  }

  async function captureSelectionAndCreateNote(forceKind?: SelectionAction["kind"]): Promise<boolean> {
    if (!pageWrapRef.current) {
      return false;
    }
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return false;
    }

    const page = await pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const wrapRect = pageWrapRef.current.getBoundingClientRect();

    const rectList = Array.from(selection.getRangeAt(0).getClientRects());
    const pdfRects: Rect[] = rectList
      .filter((rect) => rect.width > 0 && rect.height > 0 && intersectsWrap(rect, wrapRect))
      .map((rect) => {
        const left = rect.left - wrapRect.left;
        const top = rect.top - wrapRect.top;
        const right = left + rect.width;
        const bottom = top + rect.height;
        const a = viewport.convertToPdfPoint(left, top);
        const b = viewport.convertToPdfPoint(right, bottom);
        return normalizeRect(a, b);
      });

    if (pdfRects.length === 0) {
      return false;
    }

    const selectionText = normalizeSnippetText(selection.toString());
    const mode = forceKind ?? (toolMode === "text-note" ? "text-note" : "highlight");
    if (mode === "highlight") {
      await onCreateHighlight(pageNumber, pdfRects, selectionText);
    }
    selection.removeAllRanges();
    return true;
  }

  useEffect(() => {
    if (!selectionAction || selectionAction.page !== pageNumber) {
      return;
    }
    void captureSelectionAndCreateNote(selectionAction.kind);
  }, [selectionAction?.id, selectionAction?.page, pageNumber]);

  function startNoteDrag(annotation: AnnotationItem, event: ReactMouseEvent<HTMLElement>): void {
    if (!pageWrapRef.current) {
      return;
    }

    const target = event.target instanceof HTMLElement ? event.target : null;
    if (
      target?.closest(
        "textarea, input, select, option, button, .annotation-text-toolbar, .annotation-sticky-popover, .annotation-sticky-textarea",
      )
    ) {
      onActivate(pageNumber);
      onFocusNote(annotation.id);
      return;
    }

    onActivate(pageNumber);
    const additive = event.metaKey || event.ctrlKey || event.shiftKey;
    const selectedMovableIds = selectedAnnotationIds.filter((id) =>
      annotations.some((item) => item.id === id && (item.kind === "text-note" || item.kind === "sticky-note")),
    );
    const isSelected = selectedMovableIds.includes(annotation.id);
    onSelectionChange([annotation.id], additive ? "toggle" : isSelected ? "add" : "replace");
    onFocusNote(annotation.id);

    if (toolMode !== "none" || event.button !== 0) {
      return;
    }

    const rect = pageWrapRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (additive) {
      return;
    }

    const dragIds = isSelected && selectedMovableIds.length > 0 ? selectedMovableIds : [annotation.id];
    setNoteMoveState({ ids: dragIds, startX: x, startY: y, currentX: x, currentY: y });
  }

  async function handleMouseDown(event: ReactMouseEvent<HTMLDivElement>): Promise<void> {
    if (!pageWrapRef.current || event.button !== 0) {
      return;
    }

    onActivate(pageNumber);
    const rect = pageWrapRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    if (toolMode === "manual-bind") {
      setManualBindDragState({ startX: x, startY: y, currentX: x, currentY: y });
      return;
    }

    if (toolMode === "none") {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".annotation-interactive")) {
        const additive = event.metaKey || event.ctrlKey || event.shiftKey;
        setMarqueeState({ startX: x, startY: y, currentX: x, currentY: y, additive });
      }
    }
  }

  function handleMouseMove(event: ReactMouseEvent<HTMLDivElement>): void {
    if (!pageWrapRef.current) {
      return;
    }

    const rect = pageWrapRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    setManualBindDragState((prev) => (prev ? { ...prev, currentX: x, currentY: y } : null));
    setMarqueeState((prev) => (prev ? { ...prev, currentX: x, currentY: y } : null));
    setNoteMoveState((prev) => (prev ? { ...prev, currentX: x, currentY: y } : null));
  }

  async function handleMouseUp(): Promise<void> {
    if (toolMode === "highlight") {
      await captureSelectionAndCreateNote();
      return;
    }

    if (noteMoveState) {
      const page = await pdfDoc.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const a = viewport.convertToPdfPoint(noteMoveState.startX, noteMoveState.startY);
      const b = viewport.convertToPdfPoint(noteMoveState.currentX, noteMoveState.currentY);
      setNoteMoveState(null);
      const dx = (b[0] ?? 0) - (a[0] ?? 0);
      const dy = (b[1] ?? 0) - (a[1] ?? 0);
      await onMoveAnnotations(noteMoveState.ids, dx, dy);
      return;
    }

    if (manualBindDragState) {
      const page = await pdfDoc.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const a = viewport.convertToPdfPoint(manualBindDragState.startX, manualBindDragState.startY);
      const b = viewport.convertToPdfPoint(manualBindDragState.currentX, manualBindDragState.currentY);
      const pdfRect = normalizeRect(a, b);
      setManualBindDragState(null);

      if (pdfRect.w < 2 || pdfRect.h < 2) {
        return;
      }

      await onManualBindRect(pageNumber, pdfRect);
      return;
    }

    if (marqueeState) {
      const dragW = Math.abs(marqueeState.currentX - marqueeState.startX);
      const dragH = Math.abs(marqueeState.currentY - marqueeState.startY);
      if (dragW < 4 && dragH < 4) {
        setMarqueeState(null);
        if (!marqueeState.additive) {
          onSelectionChange([], "replace");
        }
        return;
      }

      const page = await pdfDoc.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const x0 = Math.min(marqueeState.startX, marqueeState.currentX);
      const y0 = Math.min(marqueeState.startY, marqueeState.currentY);
      const x1 = Math.max(marqueeState.startX, marqueeState.currentX);
      const y1 = Math.max(marqueeState.startY, marqueeState.currentY);

      const ids = annotations
        .filter((annotation) => annotation.kind === "text-note" || annotation.kind === "sticky-note")
        .filter((annotation) => {
          const rects = annotation.rects;
          if (rects.length === 0) {
            return false;
          }
          let minX = Number.POSITIVE_INFINITY;
          let minY = Number.POSITIVE_INFINITY;
          let maxX = Number.NEGATIVE_INFINITY;
          let maxY = Number.NEGATIVE_INFINITY;
          for (const item of rects) {
            minX = Math.min(minX, item.x);
            minY = Math.min(minY, item.y);
            maxX = Math.max(maxX, item.x + item.w);
            maxY = Math.max(maxY, item.y + item.h);
          }
          const [vx1, vy1] = viewport.convertToViewportPoint(minX, minY);
          const [vx2, vy2] = viewport.convertToViewportPoint(maxX, maxY);
          const ax0 = Math.min(vx1, vx2);
          const ay0 = Math.min(vy1, vy2);
          const ax1 = Math.max(vx1, vx2);
          const ay1 = Math.max(vy1, vy2);
          return !(ax1 < x0 || ax0 > x1 || ay1 < y0 || ay0 > y1);
        })
        .map((annotation) => annotation.id);

      onSelectionChange(ids, marqueeState.additive ? "add" : "replace");
      setMarqueeState(null);
    }
  }

  async function handleClick(event: ReactMouseEvent<HTMLDivElement>): Promise<void> {
    if ((toolMode !== "sticky" && toolMode !== "text-note") || !pageWrapRef.current) {
      return;
    }
    const rect = pageWrapRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const page = await pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const [pdfX, pdfY] = viewport.convertToPdfPoint(x, y);
    if (toolMode === "text-note") {
      await onCreateTextNote(pageNumber, { x: pdfX, y: pdfY });
      return;
    }
    await onCreateSticky(pageNumber, { x: pdfX, y: pdfY });
  }

  function handleContextMenu(event: ReactMouseEvent<HTMLDivElement>): void {
    const selected = window.getSelection()?.toString().trim() ?? "";
    if (!selected) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onActivate(pageNumber);
    onSelectionMenu({
      x: event.clientX,
      y: event.clientY,
      text: selected,
      page: pageNumber,
    });
  }

  const dragPreviewStyle = useMemo(() => {
    if (!manualBindDragState) {
      return undefined;
    }
    const x = Math.min(manualBindDragState.startX, manualBindDragState.currentX);
    const y = Math.min(manualBindDragState.startY, manualBindDragState.currentY);
    const w = Math.abs(manualBindDragState.currentX - manualBindDragState.startX);
    const h = Math.abs(manualBindDragState.currentY - manualBindDragState.startY);
    return { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` };
  }, [manualBindDragState]);

  const selectionPreviewStyle = useMemo(() => {
    if (!marqueeState) {
      return undefined;
    }
    const x = Math.min(marqueeState.startX, marqueeState.currentX);
    const y = Math.min(marqueeState.startY, marqueeState.currentY);
    const w = Math.abs(marqueeState.currentX - marqueeState.startX);
    const h = Math.abs(marqueeState.currentY - marqueeState.startY);
    return { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` };
  }, [marqueeState]);

  const noteMoveOffset = useMemo(() => {
    if (!noteMoveState) {
      return null;
    }
    return {
      x: noteMoveState.currentX - noteMoveState.startX,
      y: noteMoveState.currentY - noteMoveState.startY,
    };
  }, [noteMoveState]);

  const estimatedWidth = Math.max(480, Math.round((pageSize?.width ?? 612) * scale));
  const estimatedHeight = Math.max(620, Math.round((pageSize?.height ?? 792) * scale));
  const movingIds = useMemo(() => new Set(noteMoveState?.ids ?? []), [noteMoveState?.ids]);

  return (
    <div
      ref={pageWrapRef}
      className="page-wrap"
      data-page={pageNumber}
      style={{ width: `${estimatedWidth}px`, height: `${estimatedHeight}px` }}
      onMouseDown={(event) => void handleMouseDown(event)}
      onMouseMove={handleMouseMove}
      onMouseUp={() => void handleMouseUp()}
      onClick={(event) => void handleClick(event)}
      onContextMenu={handleContextMenu}
    >
      {shouldRender ? (
        <>
          <canvas ref={canvasRef} />
          <div ref={textLayerRef} className="text-layer" />

          <div className="annotation-layer">
            {annotations.flatMap((annotation) =>
              annotation.rects.map((rect, idx) => (
                <AnnotationRect
                  key={`${annotation.id}:${idx}`}
                  rect={rect}
                  scale={scale}
                  annotation={annotation}
                  pageNumber={pageNumber}
                  pdfDoc={pdfDoc}
                  toolMode={toolMode}
                  isSelected={selectedAnnotationIds.includes(annotation.id)}
                  dragOffset={noteMoveOffset && movingIds.has(annotation.id) ? noteMoveOffset : null}
                  focusedNoteId={focusedNoteId}
                  onFocusNote={onFocusNote}
                  onNotePointerDown={startNoteDrag}
                  onHighlightClick={onHighlightClick}
                  onHighlightContextMenu={onHighlightContextMenu}
                  onAnnotationUpdate={onAnnotationUpdate}
                  onAnnotationDelete={onAnnotationDelete}
                />
              )),
            )}
          </div>

          {selectionPreviewStyle ? <div className="selection-preview" style={selectionPreviewStyle} /> : null}
          {dragPreviewStyle ? <div className="drag-preview" style={dragPreviewStyle} /> : null}
        </>
      ) : (
        <div className="page-placeholder">Loading page {pageNumber}...</div>
      )}
    </div>
  );
}

function AnnotationRect({
  rect,
  scale,
  annotation,
  pageNumber,
  pdfDoc,
  toolMode,
  isSelected,
  dragOffset,
  focusedNoteId,
  onFocusNote,
  onNotePointerDown,
  onHighlightClick,
  onHighlightContextMenu,
  onAnnotationUpdate,
  onAnnotationDelete,
}: {
  rect: Rect;
  scale: number;
  annotation: AnnotationItem;
  pageNumber: number;
  pdfDoc: PDFDocumentProxy;
  toolMode: ToolMode;
  isSelected: boolean;
  dragOffset: { x: number; y: number } | null;
  focusedNoteId: string | null;
  onFocusNote: (annotationId: string | null) => void;
  onNotePointerDown: (annotation: AnnotationItem, event: ReactMouseEvent<HTMLElement>) => void;
  onHighlightClick: (annotation: AnnotationItem) => Promise<void>;
  onHighlightContextMenu: (annotation: AnnotationItem, x: number, y: number) => void;
  onAnnotationUpdate: (id: string, patch: Partial<AnnotationItem>) => Promise<void>;
  onAnnotationDelete: (id: string, label: string) => Promise<void>;
}): JSX.Element | null {
  const [viewRect, setViewRect] = useState<Rect | null>(null);
  const [draftText, setDraftText] = useState(annotation.text ?? "");
  const [draftStyle, setDraftStyle] = useState<Required<NoteTextStyle>>(normalizedNoteStyle(annotation));
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const noteWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const page = await pdfDoc.getPage(pageNumber);
      const converted = toViewportRect(page, rect, scale);
      if (alive) {
        setViewRect(converted);
      }
    })();

    return () => {
      alive = false;
    };
  }, [rect, scale, annotation.id, pdfDoc, pageNumber]);

  useEffect(() => {
    setDraftText(annotation.text ?? "");
  }, [annotation.id, annotation.text]);

  useEffect(() => {
    setDraftStyle(normalizedNoteStyle(annotation));
  }, [annotation.id, annotation.kind, annotation.style?.fontSize, annotation.style?.fontFamily, annotation.style?.textColor]);

  useEffect(() => {
    if (focusedNoteId !== annotation.id || annotation.kind === "highlight") {
      return;
    }
    textRef.current?.focus();
  }, [focusedNoteId, annotation.id, annotation.kind]);

  if (!viewRect) {
    return null;
  }

  const style: CSSProperties = {
    left: `${viewRect.x}px`,
    top: `${viewRect.y}px`,
    width: `${viewRect.w}px`,
    height: `${viewRect.h}px`,
  };
  const noteOffsetX = dragOffset?.x ?? 0;
  const noteOffsetY = dragOffset?.y ?? 0;

  if (annotation.kind === "highlight") {
    return (
      <button
        type="button"
        className="annotation-highlight annotation-interactive"
        style={{ ...style, background: annotation.color || "var(--hl)" }}
        title="Click to delete highlight"
        onClick={(event) => {
          event.stopPropagation();
          void onHighlightClick(annotation);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onHighlightContextMenu(annotation, event.clientX, event.clientY);
        }}
      />
    );
  }

  const applyStylePatch = (patch: Partial<Required<NoteTextStyle>>): void => {
    const next: Required<NoteTextStyle> = {
      ...draftStyle,
      ...patch,
    };
    setDraftStyle(next);
    void onAnnotationUpdate(annotation.id, { style: next });
  };

  const noteTextStyle: CSSProperties = {
    fontSize: `${draftStyle.fontSize}px`,
    fontFamily: draftStyle.fontFamily,
    color: draftStyle.textColor,
  };

  if (annotation.kind === "text-note") {
    return (
      <div
        ref={noteWrapRef}
        className={`annotation-text-note annotation-interactive${isSelected ? " selected" : ""}`}
        style={{
          left: `${viewRect.x + noteOffsetX}px`,
          top: `${viewRect.y + noteOffsetY}px`,
          width: `${Math.max(72, viewRect.w)}px`,
          minHeight: `${Math.max(26, viewRect.h)}px`,
        }}
        onMouseDown={(event) => {
          event.stopPropagation();
          onNotePointerDown(annotation, event);
        }}
        onClick={(event) => event.stopPropagation()}
      >
        {focusedNoteId === annotation.id ? (
          <div className="annotation-text-toolbar">
            <select
              value={String(draftStyle.fontSize)}
              onChange={(event) => applyStylePatch({ fontSize: Number(event.target.value) })}
              title="Font size"
            >
              {NOTE_FONT_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}px
                </option>
              ))}
            </select>
            <select
              value={draftStyle.fontFamily}
              onChange={(event) => applyStylePatch({ fontFamily: event.target.value })}
              title="Font family"
            >
              {NOTE_FONTS.map((font) => (
                <option key={font.label} value={font.value}>
                  {font.label}
                </option>
              ))}
            </select>
            <input
              type="color"
              value={draftStyle.textColor}
              title="Text color"
              onChange={(event) => applyStylePatch({ textColor: event.target.value })}
            />
            <button
              type="button"
              className="annotation-delete-btn"
              title="Delete text note"
              onClick={(event) => {
                event.stopPropagation();
                void onAnnotationDelete(annotation.id, "Text note");
              }}
            >
              ×
            </button>
          </div>
        ) : null}
        <textarea
          ref={textRef}
          className="annotation-text-inline"
          style={noteTextStyle}
          value={draftText}
          placeholder="Text"
          onMouseDown={(event) => {
            if (toolMode === "none") {
              event.stopPropagation();
            }
          }}
          onFocus={() => onFocusNote(annotation.id)}
          onBlur={() => {
            const active = document.activeElement;
            if (!noteWrapRef.current?.contains(active)) {
              onFocusNote(null);
            }
            if ((annotation.text ?? "") === draftText) {
              return;
            }
            void onAnnotationUpdate(annotation.id, { text: draftText });
          }}
          onChange={(event) => setDraftText(event.target.value)}
        />
      </div>
    );
  }

  return (
    <div
      className={`annotation-sticky-anchor annotation-interactive${isSelected ? " selected" : ""}`}
      style={{
        left: `${viewRect.x + noteOffsetX}px`,
        top: `${viewRect.y + noteOffsetY}px`,
        width: `${Math.max(18, viewRect.w)}px`,
        height: `${Math.max(18, viewRect.h)}px`,
      }}
      onMouseDown={(event) => {
        event.stopPropagation();
        onNotePointerDown(annotation, event);
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <button type="button" className="annotation-sticky-icon" title="Sticky note">
        🗒
      </button>
      <div className="annotation-sticky-popover">
        <div className="annotation-sticky-head">
          <span>Sticky note</span>
          <button
            type="button"
            className="annotation-delete-btn"
            title="Delete sticky note"
            onClick={(event) => {
              event.stopPropagation();
              void onAnnotationDelete(annotation.id, "Sticky note");
            }}
          >
            ×
          </button>
        </div>
        <textarea
          ref={textRef}
          className="annotation-sticky-textarea"
          style={noteTextStyle}
          value={draftText}
          placeholder="Add note..."
          onMouseDown={(event) => {
            if (toolMode === "none") {
              event.stopPropagation();
            }
          }}
          onFocus={() => onFocusNote(annotation.id)}
          onBlur={() => {
            if ((annotation.text ?? "") === draftText) {
              return;
            }
            void onAnnotationUpdate(annotation.id, { text: draftText });
          }}
          onChange={(event) => setDraftText(event.target.value)}
        />
      </div>
    </div>
  );
}
