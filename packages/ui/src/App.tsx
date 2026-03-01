import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import type { MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from "react";
import { getDocument, GlobalWorkerOptions, Util } from "pdfjs-dist";
import type { AnnotationItem, FigureTargetCandidate, NoteTextStyle, Rect, TargetKind } from "@journal-reader/types";
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

const MIN_SCALE = 0.8;
const MAX_SCALE = 2.8;
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

function clampMenuAnchor(x: number, y: number, menuWidth: number, menuHeight: number): { x: number; y: number } {
  const maxX = Math.max(MENU_VIEWPORT_MARGIN, window.innerWidth - menuWidth - MENU_VIEWPORT_MARGIN);
  const maxY = Math.max(MENU_VIEWPORT_MARGIN, window.innerHeight - menuHeight - MENU_VIEWPORT_MARGIN);
  return {
    x: Math.min(Math.max(x, MENU_VIEWPORT_MARGIN), maxX),
    y: Math.min(Math.max(y, MENU_VIEWPORT_MARGIN), maxY),
  };
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

function isCitationToken(text: string): boolean {
  return /\b(Fig(?:s|ures)?\.?\s*S?\d+[A-Za-z]?|Table(?:s)?\s*S?\d+[A-Za-z]?|Supplementary\s+(?:Fig(?:ure)?\.?|Table)\s*S?\d+[A-Za-z]?|Extended\s+Data\s+(?:Fig(?:ure)?\.?|Table)\s*\d+[A-Za-z]?)\b/i.test(
    text,
  );
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
  const topEdge = pageRect.y + 8;
  const bottomEdge = pageRect.y + pageRect.h - 8;
  const aboveTop = topEdge;
  const aboveBottom = Math.max(topEdge + 40, Math.min(bottomEdge, captionRect.y - 8));
  const belowTop = Math.min(bottomEdge - 40, Math.max(topEdge, captionRect.y + captionRect.h + 6));
  const belowBottom = bottomEdge;
  const aboveH = Math.max(1, aboveBottom - aboveTop);
  const belowH = Math.max(1, belowBottom - belowTop);

  let y = aboveTop;
  let h = aboveH;
  if (kind === "table") {
    y = belowTop;
    h = belowH;
    if (h < pageRect.h * 0.2 && aboveH > h * 1.2) {
      y = aboveTop;
      h = aboveH;
    }
  } else {
    y = aboveTop;
    h = aboveH;
    if (h < pageRect.h * 0.2 && belowH > h * 1.2) {
      y = belowTop;
      h = belowH;
    }
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
  const page = await pdfDoc.getPage(pageNumber);
  const pageRect = toPdfPageRect(page);
  const allowFallback = options?.allowFallback ?? true;

  const scale = 2;
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

  const captionView = toViewportRect(page, captionRect, scale);
  clearMaskRect(mask, canvas.width, canvas.height, {
    x0: captionView.x - 4,
    y0: captionView.y - 4,
    x1: captionView.x + captionView.w + 4,
    y1: captionView.y + captionView.h + 4,
  });

  const marginX = Math.max(60, captionView.w * 0.5);
  const column: PixelRegion = {
    x0: captionView.x - marginX,
    x1: captionView.x + captionView.w + marginX,
    y0: 0,
    y1: canvas.height - 1,
  };

  const belowRegion: PixelRegion = {
    x0: column.x0,
    x1: column.x1,
    y0: Math.min(canvas.height - 1, captionView.y + captionView.h + 10),
    y1: Math.min(canvas.height - 1, captionView.y + canvas.height * 0.45),
  };

  const aboveRegion: PixelRegion = {
    x0: column.x0,
    x1: column.x1,
    y0: Math.max(0, captionView.y - canvas.height * 0.72),
    y1: Math.max(0, captionView.y - 10),
  };

  const preferBelow = kind === "table";
  const preferredRegion = preferBelow ? belowRegion : aboveRegion;
  const preferredSide: "above" | "below" = preferBelow ? "below" : "above";
  const fallbackRegion = preferBelow ? aboveRegion : belowRegion;
  const fallbackSide: "above" | "below" = preferBelow ? "above" : "below";

  let best = findBestComponent(mask, canvas.width, canvas.height, preferredRegion, captionView, preferredSide);
  if (!best) {
    best = findBestComponent(mask, canvas.width, canvas.height, fallbackRegion, captionView, fallbackSide);
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
  const x1 = Math.min(canvas.width - 1, best.maxX + padding);
  const y1 = Math.min(canvas.height - 1, best.maxY + padding);

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

async function renderTargetCropImage(pdfDoc: PDFDocumentProxy, pageNumber: number, rect: Rect): Promise<string | null> {
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
  const [focusedNoteId, setFocusedNoteId] = useState<string | null>(null);
  const [selectedAnnotationIds, setSelectedAnnotationIds] = useState<string[]>([]);

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

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
      const nextScrollLeft = (reader.scrollLeft + offsetX) * ratio - offsetX;
      const nextScrollTop = (reader.scrollTop + offsetY) * ratio - offsetY;

      scaleRef.current = targetScale;
      setScale(targetScale);
      window.requestAnimationFrame(() => {
        const container = readerRef.current;
        if (!container) {
          return;
        }
        container.scrollLeft = nextScrollLeft;
        container.scrollTop = nextScrollTop;
      });
    }, []);

  function handleReaderWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    if (!event.ctrlKey || !pdfDoc) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const currentScale = scaleRef.current;
    const zoomFactor = Math.exp(-event.deltaY * 0.0025);
    const nextScale = clampScale(currentScale * zoomFactor);
    setScaleAroundPointer(nextScale, event.clientX, event.clientY);
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

  async function resolveCitationAtPoint(pageNumber: number, pdfX: number, pdfY: number): Promise<void> {
    if (!docId) {
      return;
    }

    setErrorText("");
    setActivePage(pageNumber);

    const resolved = await api.citationResolve(docId, pageNumber, pdfX, pdfY);
    if (resolved?.targetId) {
      await openFigureFromResolved(resolved);
      return;
    }

    if (resolved && !resolved.targetId) {
      setPendingCitation({
        citationId: resolved.citationId ?? "",
        kind: resolved.kind,
        label: resolved.label,
        page: pageNumber,
      });
      setToolMode("manual-bind");
      setStatusText(`No target found for ${resolved.kind} ${resolved.label}. Drag a region to bind manually.`);
      return;
    }

    const resolvedRef = await api.referenceResolve(docId, pageNumber, pdfX, pdfY);
    if (resolvedRef) {
      const entries = await api.referenceGetEntries(docId, resolvedRef.indices);
      await api.referenceOpenPopup({
        indices: resolvedRef.indices,
        entries,
      });
      setStatusText(`Opened references ${resolvedRef.indices.join(", ")}`);
      return;
    }

    setStatusText("Citation/reference not recognized at this point");
  }

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
    let chosenCropRect = chosen.cropRect;
    let chosenDetectionMode: "component" | "fallback" | null = null;

    if (pdfDoc) {
      const pageAreaCache = new Map<number, number>();
      let bestScore = Number.NEGATIVE_INFINITY;

      for (const candidate of candidates) {
        if (!candidate.captionRect) {
          continue;
        }
        const detected = await detectVisualRegionNearCaption(pdfDoc, candidate.page, candidate.captionRect, normalizedKind, {
          allowFallback: false,
        });
        if (!detected || detected.mode !== "component") {
          continue;
        }

        let pageArea = pageAreaCache.get(candidate.page);
        if (!pageArea) {
          const page = await pdfDoc.getPage(candidate.page);
          const pageRect = toPdfPageRect(page);
          pageArea = Math.max(1, pageRect.w * pageRect.h);
          pageAreaCache.set(candidate.page, pageArea);
        }
        const areaRatio = detected.area / pageArea;
        const exactBonus = candidate.label.toUpperCase() === resolved.label.toUpperCase() ? 0.08 : 0;
        const manualBonus = candidate.source === "manual" ? 1 : 0;
        const score = areaRatio * 100 + detected.score * 0.01 + candidate.confidence + exactBonus + manualBonus;
        if (score > bestScore) {
          bestScore = score;
          chosen = candidate;
          chosenCropRect = detected.rect;
          chosenDetectionMode = "component";
        }
      }

      if (chosenDetectionMode !== "component" && chosen.captionRect) {
        const detected = await detectVisualRegionNearCaption(pdfDoc, chosen.page, chosen.captionRect, normalizedKind, {
          allowFallback: true,
        });
        if (detected) {
          chosenCropRect = detected.rect;
          chosenDetectionMode = detected.mode;
        }
      }
    }

    const target = chosen.id === resolved.targetId ? fallbackTarget : await api.figureGetTarget(docId, chosen.id);
    let imageDataUrl = target.imageDataUrl;
    if (pdfDoc) {
      const rendered = await renderTargetCropImage(pdfDoc, chosen.page, chosenCropRect).catch(() => null);
      if (rendered) {
        imageDataUrl = rendered;
      }
    }

    await api.figureOpenPopup({
      docId,
      targetId: chosen.id,
      caption: chosen.caption,
      imageDataUrl,
      page: chosen.page,
      captionRect: chosen.captionRect,
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

  async function openReferenceFromSelection(): Promise<void> {
    if (!docId || !selectionMenu) {
      return;
    }
    try {
      setErrorText("");
      const indices = extractReferenceIndices(selectionMenu.text);
      if (indices.length === 0) {
        setStatusText("No reference index recognized in selected text");
        setErrorText("Select text like 16,17,21,23 or [2,4-5], then choose Open Reference.");
        setSelectionMenu(null);
        return;
      }

      const entries = await api.referenceGetEntries(docId, indices);
      if (entries.length === 0) {
        const hasAny = await api.referenceHasEntries(docId);
        if (!hasAny) {
          setStatusText("No reference list detected in this PDF");
          setErrorText("This PDF appears to contain in-text citation numbers, but no parsable reference list section.");
        } else {
          setStatusText(`No entries found for references ${indices.join(", ")}`);
          setErrorText("Reference list exists, but selected indices were not found. Try selecting a full marker.");
        }
      } else {
        setStatusText(`Opened references ${indices.join(", ")}`);
      }
      await api.referenceOpenPopup({ indices, entries });
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
            <ToolButton title="Pointer mode (click citations/references)" active={toolMode === "none"} onClick={() => setToolMode("none")}>
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
                onCitationClick={resolveCitationAtPoint}
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
        <div>
          {stats
            ? `recognized -> refs ${stats.refsCount} | fig ${stats.figuresCount} | table ${stats.tablesCount} | supp ${stats.suppCount}`
            : "recognized -> (not parsed yet)"}
        </div>
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
  onCitationClick,
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
  onCitationClick: (pageNumber: number, pdfX: number, pdfY: number) => Promise<void>;
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
      const citationSpan = isCitationToken(item.str);
      span.className = `text-span${citationSpan ? " citation" : ""}`;
      span.style.left = `${tx[4]}px`;
      span.style.top = `${tx[5] - height}px`;
      span.style.fontSize = `${height}px`;
      span.style.width = `${Math.max(1, width)}px`;
      span.style.height = `${Math.max(1, height + 2)}px`;
      fragment.appendChild(span);
    }
    textLayer.appendChild(fragment);

    if (toolMode === "none") {
      textLayer.onclick = (event: MouseEvent): void => {
        const target = (event.target as HTMLElement | null)?.closest(".text-span.citation");
        if (!target) {
          return;
        }
        event.stopPropagation();
        const wrap = pageWrapRef.current;
        if (!wrap) {
          return;
        }
        onActivate(pageNumber);
        const wrapRect = wrap.getBoundingClientRect();
        const viewportX = event.clientX - wrapRect.left;
        const viewportY = event.clientY - wrapRect.top;
        const [pdfX, pdfY] = viewport.convertToPdfPoint(viewportX, viewportY);
        void onCitationClick(pageNumber, pdfX, pdfY);
      };
    }
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
