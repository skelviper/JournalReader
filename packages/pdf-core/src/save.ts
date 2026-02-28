import { randomUUID } from "node:crypto";
import { access, constants, copyFile, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFString,
} from "pdf-lib";
import type { AnnotationItem, Rect, SavePdfResponse } from "@journal-reader/types";

const JR_PREFIX = "JR:";
const JR_META_VERSION = 1;

const KEY_ANNOTS = PDFName.of("Annots");
const KEY_TYPE = PDFName.of("Type");
const KEY_SUBTYPE = PDFName.of("Subtype");
const KEY_RECT = PDFName.of("Rect");
const KEY_QUAD_POINTS = PDFName.of("QuadPoints");
const KEY_COLOR = PDFName.of("C");
const KEY_CONTENTS = PDFName.of("Contents");
const KEY_NAME = PDFName.of("Name");
const KEY_OPEN = PDFName.of("Open");
const KEY_FLAGS = PDFName.of("F");
const KEY_NM = PDFName.of("NM");
const KEY_MOD_DATE = PDFName.of("M");
const KEY_ALPHA = PDFName.of("CA");
const KEY_JR_META = PDFName.of("JRMeta");

type PersistedAnnotationMeta = {
  v: number;
  id: string;
  kind: AnnotationItem["kind"];
  rects: Rect[];
  text?: string;
  color?: string;
  createdAt?: string;
  updatedAt?: string;
};

function toIsoNow(): string {
  return new Date().toISOString();
}

function cloneRect(rect: Rect): Rect {
  return {
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
  };
}

function normalizeRect(rect: Rect): Rect {
  const x = Number.isFinite(rect.x) ? rect.x : 0;
  const y = Number.isFinite(rect.y) ? rect.y : 0;
  const w = Number.isFinite(rect.w) ? rect.w : 0;
  const h = Number.isFinite(rect.h) ? rect.h : 0;
  return {
    x,
    y,
    w: Math.max(1, Math.abs(w)),
    h: Math.max(1, Math.abs(h)),
  };
}

function unionRects(rects: Rect[]): Rect {
  const first = rects[0];
  if (!first) {
    return { x: 0, y: 0, w: 1, h: 1 };
  }

  let minX = first.x;
  let minY = first.y;
  let maxX = first.x + first.w;
  let maxY = first.y + first.h;
  for (const rect of rects.slice(1)) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }

  return {
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
  };
}

function parseHexColor(color: string | undefined): { r: number; g: number; b: number } {
  const raw = (color ?? "#fce588").trim();
  const hex = raw.startsWith("#") ? raw.slice(1) : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return { r: 252 / 255, g: 229 / 255, b: 136 / 255 };
  }
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  const toHex = (v: number) => clamp(v).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function makeNumberArray(pdf: PDFDocument, values: number[]): PDFArray {
  const out = PDFArray.withContext(pdf.context);
  for (const value of values) {
    out.push(PDFNumber.of(value));
  }
  return out;
}

function decodeText(value: PDFString | PDFHexString | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.decodeText();
}

function isJournalAnnotation(dict: PDFDict): boolean {
  if (dict.lookupMaybe(KEY_JR_META, PDFString, PDFHexString)) {
    return true;
  }
  const nm = decodeText(dict.lookupMaybe(KEY_NM, PDFString, PDFHexString));
  return !!nm && nm.startsWith(JR_PREFIX);
}

function parseMetaFromDict(dict: PDFDict): PersistedAnnotationMeta | null {
  const raw = decodeText(dict.lookupMaybe(KEY_JR_META, PDFString, PDFHexString));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedAnnotationMeta>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (typeof parsed.id !== "string" || !parsed.id) {
      return null;
    }
    if (parsed.kind !== "highlight" && parsed.kind !== "text-note" && parsed.kind !== "sticky-note") {
      return null;
    }
    const rects = Array.isArray(parsed.rects)
      ? parsed.rects
          .map((item) => item as Rect)
          .filter(
            (item) =>
              item &&
              Number.isFinite(item.x) &&
              Number.isFinite(item.y) &&
              Number.isFinite(item.w) &&
              Number.isFinite(item.h),
          )
          .map(normalizeRect)
      : [];
    if (rects.length === 0) {
      return null;
    }
    return {
      v: typeof parsed.v === "number" ? parsed.v : 0,
      id: parsed.id,
      kind: parsed.kind,
      rects,
      text: typeof parsed.text === "string" ? parsed.text : undefined,
      color: typeof parsed.color === "string" ? parsed.color : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : undefined,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    };
  } catch {
    return null;
  }
}

function parseQuadPoints(dict: PDFDict): Rect[] {
  const quads = dict.lookupMaybe(KEY_QUAD_POINTS, PDFArray);
  if (!quads) {
    return [];
  }
  const out: Rect[] = [];
  for (let i = 0; i + 7 < quads.size(); i += 8) {
    const x1 = quads.lookupMaybe(i + 0, PDFNumber)?.asNumber() ?? 0;
    const y1 = quads.lookupMaybe(i + 1, PDFNumber)?.asNumber() ?? 0;
    const x2 = quads.lookupMaybe(i + 2, PDFNumber)?.asNumber() ?? 0;
    const y2 = quads.lookupMaybe(i + 3, PDFNumber)?.asNumber() ?? 0;
    const x3 = quads.lookupMaybe(i + 4, PDFNumber)?.asNumber() ?? 0;
    const y3 = quads.lookupMaybe(i + 5, PDFNumber)?.asNumber() ?? 0;
    const x4 = quads.lookupMaybe(i + 6, PDFNumber)?.asNumber() ?? 0;
    const y4 = quads.lookupMaybe(i + 7, PDFNumber)?.asNumber() ?? 0;
    const rect: Rect = {
      x: Math.min(x1, x2, x3, x4),
      y: Math.min(y1, y2, y3, y4),
      w: Math.max(x1, x2, x3, x4) - Math.min(x1, x2, x3, x4),
      h: Math.max(y1, y2, y3, y4) - Math.min(y1, y2, y3, y4),
    };
    out.push(normalizeRect(rect));
  }
  return out;
}

function parseRectFromDict(dict: PDFDict): Rect | null {
  const rectArray = dict.lookupMaybe(KEY_RECT, PDFArray);
  if (!rectArray) {
    return null;
  }
  const rect = rectArray.asRectangle();
  return normalizeRect({
    x: rect.x,
    y: rect.y,
    w: rect.width,
    h: rect.height,
  });
}

function parseColorFromDict(dict: PDFDict): string | undefined {
  const arr = dict.lookupMaybe(KEY_COLOR, PDFArray);
  if (!arr || arr.size() < 3) {
    return undefined;
  }
  const r = arr.lookupMaybe(0, PDFNumber)?.asNumber();
  const g = arr.lookupMaybe(1, PDFNumber)?.asNumber();
  const b = arr.lookupMaybe(2, PDFNumber)?.asNumber();
  if (r === undefined || g === undefined || b === undefined) {
    return undefined;
  }
  return rgbToHex(r, g, b);
}

function parseFallbackAnnotation(dict: PDFDict, page: number): AnnotationItem | null {
  const subtype = dict.lookupMaybe(KEY_SUBTYPE, PDFName)?.decodeText().toLowerCase() ?? "";
  const isHighlight = subtype === "highlight";
  const rect = parseRectFromDict(dict);
  const quadRects = parseQuadPoints(dict);
  const rects = isHighlight ? (quadRects.length > 0 ? quadRects : rect ? [rect] : []) : rect ? [rect] : [];
  if (rects.length === 0) {
    return null;
  }

  const nm = decodeText(dict.lookupMaybe(KEY_NM, PDFString, PDFHexString));
  const annotationName = dict.lookupMaybe(KEY_NAME, PDFName)?.decodeText().toLowerCase() ?? "";
  const kind: AnnotationItem["kind"] = isHighlight
    ? "highlight"
    : annotationName.includes("note")
      ? "sticky-note"
      : "text-note";

  const text = decodeText(dict.lookupMaybe(KEY_CONTENTS, PDFString, PDFHexString));
  const color = parseColorFromDict(dict);
  const now = toIsoNow();
  const id = nm?.startsWith(JR_PREFIX) ? nm.slice(JR_PREFIX.length) : randomUUID();
  return {
    id,
    docId: "",
    page,
    kind,
    rects: rects.map(cloneRect),
    text: text && text.length > 0 ? text : undefined,
    color,
    createdAt: now,
    updatedAt: now,
  };
}

function annotationFromDict(dict: PDFDict, page: number): AnnotationItem | null {
  const meta = parseMetaFromDict(dict);
  if (meta) {
    const now = toIsoNow();
    const createdAt = meta.createdAt ?? now;
    const updatedAt = meta.updatedAt ?? createdAt;
    return {
      id: meta.id,
      docId: "",
      page,
      kind: meta.kind,
      rects: meta.rects.map(cloneRect),
      text: meta.text,
      color: meta.color,
      createdAt,
      updatedAt,
    };
  }
  return parseFallbackAnnotation(dict, page);
}

function buildMeta(annotation: AnnotationItem): PersistedAnnotationMeta {
  return {
    v: JR_META_VERSION,
    id: annotation.id,
    kind: annotation.kind,
    rects: annotation.rects.map(normalizeRect),
    text: annotation.text,
    color: annotation.color,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
  };
}

function setCommonJournalFields(pdf: PDFDocument, dict: PDFDict, annotation: AnnotationItem): void {
  const bounds = unionRects(annotation.rects.map(normalizeRect));
  const { r, g, b } = parseHexColor(annotation.color);
  const meta = buildMeta(annotation);

  dict.set(KEY_TYPE, PDFName.of("Annot"));
  dict.set(KEY_RECT, makeNumberArray(pdf, [bounds.x, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h]));
  dict.set(KEY_COLOR, makeNumberArray(pdf, [r, g, b]));
  dict.set(KEY_FLAGS, PDFNumber.of(4));
  dict.set(KEY_NM, PDFString.of(`${JR_PREFIX}${annotation.id}`));
  dict.set(KEY_MOD_DATE, PDFString.fromDate(new Date(annotation.updatedAt)));
  dict.set(KEY_JR_META, PDFString.of(JSON.stringify(meta)));
}

function createHighlightDict(pdf: PDFDocument, annotation: AnnotationItem): PDFDict {
  const dict = PDFDict.withContext(pdf.context);
  setCommonJournalFields(pdf, dict, annotation);
  dict.set(KEY_SUBTYPE, PDFName.of("Highlight"));
  dict.set(KEY_ALPHA, PDFNumber.of(0.35));

  const quadPoints: number[] = [];
  for (const rect of annotation.rects.map(normalizeRect)) {
    const x1 = rect.x;
    const x2 = rect.x + rect.w;
    const y1 = rect.y + rect.h;
    const y2 = rect.y;
    quadPoints.push(x1, y1, x2, y1, x1, y2, x2, y2);
  }
  dict.set(KEY_QUAD_POINTS, makeNumberArray(pdf, quadPoints));
  return dict;
}

function createTextLikeDict(pdf: PDFDocument, annotation: AnnotationItem): PDFDict {
  const dict = PDFDict.withContext(pdf.context);
  setCommonJournalFields(pdf, dict, annotation);
  dict.set(KEY_SUBTYPE, PDFName.of("Text"));
  dict.set(KEY_NAME, PDFName.of(annotation.kind === "sticky-note" ? "Note" : "Comment"));
  dict.set(KEY_OPEN, PDFBool.False);

  if (annotation.text && annotation.text.trim()) {
    dict.set(KEY_CONTENTS, PDFString.of(annotation.text.trim()));
  }

  return dict;
}

function createJournalAnnotationDict(pdf: PDFDocument, annotation: AnnotationItem): PDFDict {
  if (annotation.kind === "highlight") {
    return createHighlightDict(pdf, annotation);
  }
  return createTextLikeDict(pdf, annotation);
}

function replacePageJournalAnnotations(pdf: PDFDocument, page: PDFPage, journalAnnotations: AnnotationItem[]): void {
  const oldAnnots = page.node.lookupMaybe(KEY_ANNOTS, PDFArray);
  const nextAnnots = PDFArray.withContext(pdf.context);

  if (oldAnnots) {
    for (let i = 0; i < oldAnnots.size(); i += 1) {
      const raw = oldAnnots.get(i);
      const dict = oldAnnots.lookupMaybe(i, PDFDict);
      if (dict && isJournalAnnotation(dict)) {
        continue;
      }
      if (raw) {
        nextAnnots.push(raw);
      }
    }
  }

  for (const annotation of journalAnnotations) {
    const dict = createJournalAnnotationDict(pdf, annotation);
    const ref = pdf.context.register(dict);
    nextAnnots.push(ref);
  }

  if (nextAnnots.size() > 0) {
    page.node.set(KEY_ANNOTS, nextAnnots);
  } else {
    page.node.delete(KEY_ANNOTS);
  }
}

function normalizeInputAnnotation(annotation: AnnotationItem): AnnotationItem {
  const now = toIsoNow();
  const id = annotation.id || randomUUID();
  const rects = annotation.rects.map(normalizeRect);
  return {
    id,
    docId: annotation.docId,
    page: annotation.page,
    kind: annotation.kind,
    rects,
    text: annotation.text,
    color: annotation.color,
    createdAt: annotation.createdAt || now,
    updatedAt: annotation.updatedAt || now,
  };
}

async function ensureBackup(pdfPath: string): Promise<string> {
  const backupPath = join(dirname(pdfPath), `${basename(pdfPath)}.bak`);
  try {
    await access(backupPath, constants.F_OK);
  } catch {
    await copyFile(pdfPath, backupPath);
  }
  return backupPath;
}

export async function loadAnnotationsFromPdf(pdfPath: string): Promise<AnnotationItem[]> {
  const src = await readFile(pdfPath);
  const pdf = await PDFDocument.load(src);
  const out: AnnotationItem[] = [];
  const pages = pdf.getPages();

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    if (!page) {
      continue;
    }
    const annots = page.node.lookupMaybe(KEY_ANNOTS, PDFArray);
    if (!annots) {
      continue;
    }

    for (let i = 0; i < annots.size(); i += 1) {
      const dict = annots.lookupMaybe(i, PDFDict);
      if (!dict || !isJournalAnnotation(dict)) {
        continue;
      }
      const parsed = annotationFromDict(dict, pageIndex + 1);
      if (parsed) {
        out.push(parsed);
      }
    }
  }

  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function saveAnnotationsToPdf(pdfPath: string, annotations: AnnotationItem[]): Promise<SavePdfResponse> {
  const backupPath = await ensureBackup(pdfPath);
  const src = await readFile(pdfPath);
  const pdf = await PDFDocument.load(src);
  const pages = pdf.getPages();

  const normalized = annotations.map(normalizeInputAnnotation);
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    if (!page) {
      continue;
    }
    const pageNum = pageIndex + 1;
    const pageAnnotations = normalized.filter((annotation) => annotation.page === pageNum);
    replacePageJournalAnnotations(pdf, page, pageAnnotations);
  }

  const out = await pdf.save();
  try {
    await writeFile(pdfPath, out);
  } catch (error) {
    await copyFile(backupPath, pdfPath);
    throw error;
  }

  return {
    saved: true,
    backupPath,
    overwrittenPath: pdfPath,
  };
}
