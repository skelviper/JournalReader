import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getDocument, GlobalWorkerOptions, Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import { randomUUID } from "node:crypto";
import type { OutlineNode, ParsedTextSpan, Rect } from "@journal-reader/types";

const require = createRequire(import.meta.url);
const workerModulePath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
const cMapDir = join(pdfjsRoot, "cmaps");
const standardFontsDir = join(pdfjsRoot, "standard_fonts");
const cMapUrl = `${cMapDir.replace(/\/?$/, "/")}`;
const standardFontDataUrl = `${standardFontsDir.replace(/\/?$/, "/")}`;
GlobalWorkerOptions.workerSrc = pathToFileURL(workerModulePath).toString();

type OpenedPdf = {
  pageCount: number;
  title: string;
};

type GetDocumentInput = Parameters<typeof getDocument>[0];

function buildNodeDocumentInput(data: Uint8Array): GetDocumentInput {
  const input: GetDocumentInput & { disableWorker: boolean } = {
    data,
    // Node-side parsing in main process should not spawn a PDF.js worker.
    disableWorker: true,
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
  };
  return input;
}

function normalizeRect(a: [number, number], b: [number, number]): Rect {
  const x0 = Math.min(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  return {
    x: x0,
    y: y0,
    w: Math.max(1, x1 - x0),
    h: Math.max(1, y1 - y0),
  };
}

export async function openPdfMetadata(path: string): Promise<OpenedPdf> {
  const buf = await readFile(path);
  const loadingTask = getDocument(buildNodeDocumentInput(new Uint8Array(buf)));
  const doc = await loadingTask.promise;

  try {
    const metadata = await doc.getMetadata().catch(() => null);
    const info = metadata?.info as Record<string, unknown> | undefined;
    const infoTitle = typeof info?.Title === "string" ? info.Title : undefined;
    const title =
      infoTitle ||
      metadata?.metadata?.get?.("dc:title") ||
      path.split("/").pop() ||
      "Untitled PDF";

    return {
      pageCount: doc.numPages,
      title,
    };
  } finally {
    await doc.destroy();
  }
}

export async function extractTextSpans(path: string): Promise<ParsedTextSpan[]> {
  const buf = await readFile(path);
  const loadingTask = getDocument(buildNodeDocumentInput(new Uint8Array(buf)));
  const doc = await loadingTask.promise;
  const spans: ParsedTextSpan[] = [];

  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      for (const item of content.items) {
        if (!("str" in item && "transform" in item)) {
          continue;
        }
        const text = item.str.trim();
        if (!text) {
          continue;
        }

        const tx = Util.transform(viewport.transform, item.transform);
        const width = Math.max(1, ("width" in item ? item.width : 10) || 10);
        const height = Math.max(1, ("height" in item ? item.height : 12) || 12);
        const topLeft = viewport.convertToPdfPoint(tx[4] ?? 0, (tx[5] ?? 0) - height) as [number, number];
        const bottomRight = viewport.convertToPdfPoint((tx[4] ?? 0) + width, tx[5] ?? 0) as [number, number];
        const rect = normalizeRect(topLeft, bottomRight);

        spans.push({
          text,
          page: pageNum,
          bbox: rect,
        });
      }
    }
  } finally {
    await doc.destroy();
  }

  return spans;
}

function normalizeHeading(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isLikelyHeuristicHeading(text: string): boolean {
  const normalized = normalizeHeading(text);
  if (!normalized) {
    return false;
  }
  if (normalized.length < 3 || normalized.length > 100) {
    return false;
  }
  const strictSet = new Set([
    "abstract",
    "introduction",
    "background",
    "results",
    "discussion",
    "conclusion",
    "methods",
    "materials and methods",
    "references",
    "acknowledgements",
    "supplementary information",
  ]);
  if (strictSet.has(normalized.toLowerCase())) {
    return true;
  }
  if (/^\d+(\.\d+){0,2}\s+[A-Z]/.test(normalized)) {
    return true;
  }
  if (/^(appendix|supplementary)\b/i.test(normalized)) {
    return true;
  }
  return false;
}

type LineEntry = {
  page: number;
  y: number;
  text: string;
  bbox: Rect;
};

function buildHeuristicLines(spans: ParsedTextSpan[]): LineEntry[] {
  const byPage = new Map<number, ParsedTextSpan[]>();
  for (const span of spans) {
    const list = byPage.get(span.page) ?? [];
    list.push(span);
    byPage.set(span.page, list);
  }

  const lines: LineEntry[] = [];
  const yThreshold = 5;
  for (const [page, pageSpans] of byPage.entries()) {
    const sorted = [...pageSpans].sort((a, b) => {
      if (Math.abs(a.bbox.y - b.bbox.y) > yThreshold) {
        return b.bbox.y - a.bbox.y;
      }
      return a.bbox.x - b.bbox.x;
    });
    const buckets: Array<{ y: number; spans: ParsedTextSpan[] }> = [];
    for (const span of sorted) {
      const line = buckets.find((item) => Math.abs(item.y - span.bbox.y) <= yThreshold);
      if (!line) {
        buckets.push({ y: span.bbox.y, spans: [span] });
        continue;
      }
      line.spans.push(span);
      line.y = (line.y + span.bbox.y) / 2;
    }
    for (const bucket of buckets) {
      const sortedSpans = [...bucket.spans].sort((a, b) => a.bbox.x - b.bbox.x);
      const text = normalizeHeading(sortedSpans.map((item) => item.text).join(" "));
      if (!text) {
        continue;
      }
      let minX = sortedSpans[0]?.bbox.x ?? 0;
      let minY = sortedSpans[0]?.bbox.y ?? 0;
      let maxX = (sortedSpans[0]?.bbox.x ?? 0) + (sortedSpans[0]?.bbox.w ?? 0);
      let maxY = (sortedSpans[0]?.bbox.y ?? 0) + (sortedSpans[0]?.bbox.h ?? 0);
      for (const span of sortedSpans.slice(1)) {
        minX = Math.min(minX, span.bbox.x);
        minY = Math.min(minY, span.bbox.y);
        maxX = Math.max(maxX, span.bbox.x + span.bbox.w);
        maxY = Math.max(maxY, span.bbox.y + span.bbox.h);
      }
      lines.push({
        page,
        y: bucket.y,
        text,
        bbox: {
          x: minX,
          y: minY,
          w: Math.max(1, maxX - minX),
          h: Math.max(1, maxY - minY),
        },
      });
    }
  }
  return lines.sort((a, b) => (a.page !== b.page ? a.page - b.page : b.y - a.y));
}

function buildHeuristicOutlineNodes(spans: ParsedTextSpan[]): OutlineNode[] {
  const lines = buildHeuristicLines(spans);
  const out: OutlineNode[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const text = normalizeHeading(line.text);
    if (!isLikelyHeuristicHeading(text)) {
      continue;
    }
    const key = `${line.page}:${text.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      id: randomUUID(),
      title: text,
      page: line.page,
      depth: /^\d+(\.\d+){1,2}\s+/.test(text) ? Math.min(2, (text.match(/\./g) ?? []).length) : 0,
      source: "heuristic",
      y: line.y,
    });
  }
  return out;
}

type PdfOutlineItem = {
  title?: string;
  dest?: unknown;
  items?: PdfOutlineItem[];
};

async function resolveOutlineDest(
  doc: Awaited<ReturnType<typeof getDocument>["promise"]>,
  dest: unknown,
): Promise<{ page: number; y?: number } | null> {
  let explicitDest: unknown = dest;
  if (typeof dest === "string") {
    explicitDest = await doc.getDestination(dest).catch(() => null);
  }
  if (!Array.isArray(explicitDest) || explicitDest.length === 0) {
    return null;
  }
  const first = explicitDest[0];
  let pageIndex: number | null = null;
  if (typeof first === "number") {
    pageIndex = first;
  } else {
    pageIndex = await doc.getPageIndex(first as Parameters<typeof doc.getPageIndex>[0]).catch(() => null);
  }
  if (pageIndex === null || pageIndex < 0) {
    return null;
  }
  const y = typeof explicitDest[3] === "number" ? explicitDest[3] : undefined;
  return {
    page: pageIndex + 1,
    y,
  };
}

async function flattenNativeOutline(
  doc: Awaited<ReturnType<typeof getDocument>["promise"]>,
  items: PdfOutlineItem[],
  depth: number,
  out: OutlineNode[],
): Promise<void> {
  for (const item of items) {
    const title = normalizeHeading(item.title ?? "");
    if (title) {
      const resolved = await resolveOutlineDest(doc, item.dest);
      if (resolved) {
        out.push({
          id: randomUUID(),
          title,
          page: resolved.page,
          depth,
          source: "native",
          y: resolved.y,
        });
      }
    }
    if (Array.isArray(item.items) && item.items.length > 0) {
      await flattenNativeOutline(doc, item.items, depth + 1, out);
    }
  }
}

export async function extractPdfOutline(path: string, spans?: ParsedTextSpan[]): Promise<OutlineNode[]> {
  const buf = await readFile(path);
  const loadingTask = getDocument(buildNodeDocumentInput(new Uint8Array(buf)));
  const doc = await loadingTask.promise;
  try {
    const outline = (await doc.getOutline().catch(() => null)) as PdfOutlineItem[] | null;
    if (outline && outline.length > 0) {
      const nativeNodes: OutlineNode[] = [];
      await flattenNativeOutline(doc, outline, 0, nativeNodes);
      if (nativeNodes.length > 0) {
        return nativeNodes;
      }
    }
  } finally {
    await doc.destroy();
  }
  const lines = spans ?? (await extractTextSpans(path));
  return buildHeuristicOutlineNodes(lines);
}
