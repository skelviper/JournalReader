import { app, ipcMain, BrowserWindow, dialog, shell } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractCitations, extractCaptions, extractReferenceData, mapCitationsToTargets } from "@journal-reader/parser";
import {
  buildTargetPreviewDataUrl,
  extractTextSpans,
  loadAnnotationsFromPdf,
  openPdfMetadata,
  saveAnnotationsToPdf,
} from "@journal-reader/pdf-core";
import { StorageRepository } from "@journal-reader/storage";
import type {
  AnnotationItem,
  BindManuallyResponse,
  CaptionGetLinkedSnippetsPayload,
  CaptionGetLinkedSnippetsResponse,
  CaptionSyncHighlightsPayload,
  FigurePopupPayload,
  ParsedTextSpan,
  Rect,
  ReferenceEntry,
} from "@journal-reader/types";

const CAPTION_WORD_META_PREFIX = "CAPTION_WORD_HL::";
const CAPTION_SYNC_COLOR = "#fce588";
const spanCache = new Map<string, ParsedTextSpan[]>();
const annotationCache = new Map<string, AnnotationItem[]>();

function toIsoNow(): string {
  return new Date().toISOString();
}

function cloneAnnotation(item: AnnotationItem): AnnotationItem {
  return {
    ...item,
    rects: item.rects.map((rect) => ({ ...rect })),
    style: item.style
      ? {
          fontSize: item.style.fontSize,
          fontFamily: item.style.fontFamily,
          textColor: item.style.textColor,
        }
      : undefined,
  };
}

function cloneAnnotationList(items: AnnotationItem[]): AnnotationItem[] {
  return items.map(cloneAnnotation);
}

function normalizeAnnotationPayload(item: AnnotationItem, docId: string): AnnotationItem {
  const now = toIsoNow();
  return {
    ...item,
    docId,
    rects: item.rects.map((rect) => ({ ...rect })),
    style: item.style
      ? {
          fontSize: item.style.fontSize,
          fontFamily: item.style.fontFamily,
          textColor: item.style.textColor,
        }
      : undefined,
    createdAt: item.createdAt || now,
    updatedAt: item.updatedAt || item.createdAt || now,
  };
}

async function ensureAnnotationsLoaded(repo: StorageRepository, docId: string): Promise<AnnotationItem[]> {
  const cached = annotationCache.get(docId);
  if (cached) {
    return cached;
  }
  const path = repo.getDocumentPath(docId);
  if (!path) {
    annotationCache.set(docId, []);
    return [];
  }
  const loaded = await loadAnnotationsFromPdf(path);
  const normalized = loaded.map((item) => normalizeAnnotationPayload(item, docId));
  annotationCache.set(docId, normalized);
  return normalized;
}

async function reloadAnnotations(repo: StorageRepository, docId: string): Promise<AnnotationItem[]> {
  const path = repo.getDocumentPath(docId);
  if (!path) {
    annotationCache.set(docId, []);
    return [];
  }
  const loaded = await loadAnnotationsFromPdf(path);
  const normalized = loaded.map((item) => normalizeAnnotationPayload(item, docId));
  annotationCache.set(docId, normalized);
  return normalized;
}

function findAnnotationDocId(annotationId: string): string | null {
  for (const [docId, list] of annotationCache.entries()) {
    if (list.some((item) => item.id === annotationId)) {
      return docId;
    }
  }
  return null;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeCaptionText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeArticleSnippet(text: string | undefined): string | null {
  if (!text) {
    return null;
  }
  if (text.startsWith(CAPTION_WORD_META_PREFIX)) {
    return null;
  }
  const normalized = normalizeSnippet(text);
  if (!normalized) {
    return null;
  }
  return normalized.length > 260 ? normalized.slice(0, 260).trim() : normalized;
}

function encodeCaptionWordMeta(targetId: string, snippet: string): string {
  return `${CAPTION_WORD_META_PREFIX}${targetId}::${normalizeSnippet(snippet)}`;
}

function parseCaptionWordMeta(raw: string | undefined): { targetId: string; snippet: string } | null {
  if (!raw || !raw.startsWith(CAPTION_WORD_META_PREFIX)) {
    return null;
  }
  const rest = raw.slice(CAPTION_WORD_META_PREFIX.length);
  const sep = rest.indexOf("::");
  if (sep < 0) {
    return null;
  }
  const targetId = rest.slice(0, sep).trim();
  const snippet = normalizeSnippet(rest.slice(sep + 2));
  if (!targetId || !snippet) {
    return null;
  }
  return { targetId, snippet };
}

function intersectsRect(a: Rect, b: Rect, pad = 0): boolean {
  return !(
    a.x + a.w < b.x - pad ||
    a.x > b.x + b.w + pad ||
    a.y + a.h < b.y - pad ||
    a.y > b.y + b.h + pad
  );
}

function normalizeTokenWord(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

type CaptionWord = {
  text: string;
  norm: string;
  bbox: Rect;
};

function splitSpanToWordRects(span: ParsedTextSpan): Array<{ text: string; bbox: Rect }> {
  const text = span.text;
  if (!text) {
    return [];
  }
  const matches = [...text.matchAll(/\S+/g)];
  if (matches.length <= 1) {
    return [{ text, bbox: span.bbox }];
  }

  const out: Array<{ text: string; bbox: Rect }> = [];
  const totalChars = Math.max(1, text.length);
  for (const match of matches) {
    const token = match[0] ?? "";
    if (!token) {
      continue;
    }
    const start = match.index ?? 0;
    const end = start + token.length;
    const x = span.bbox.x + (span.bbox.w * start) / totalChars;
    const w = Math.max(1, (span.bbox.w * token.length) / totalChars);
    out.push({
      text: token,
      bbox: {
        x,
        y: span.bbox.y,
        w,
        h: span.bbox.h,
      },
    });
  }

  return out.length > 0 ? out : [{ text, bbox: span.bbox }];
}

function collectCaptionWordRects(spans: ParsedTextSpan[], page: number, captionRect: Rect): CaptionWord[] {
  return spans
    .filter((span) => span.page === page && intersectsRect(span.bbox, captionRect, 6))
    .flatMap((span) => splitSpanToWordRects(span))
    .map((item) => ({
      text: item.text,
      norm: normalizeTokenWord(item.text),
      bbox: item.bbox,
    }))
    .filter((item) => item.norm.length > 0);
}

function sortWordsByLineOrder(words: CaptionWord[]): CaptionWord[] {
  return [...words].sort((a, b) => {
    if (Math.abs(a.bbox.y - b.bbox.y) > 4) {
      return b.bbox.y - a.bbox.y;
    }
    return a.bbox.x - b.bbox.x;
  });
}

function sortWordsByColumnOrder(words: CaptionWord[]): CaptionWord[] {
  if (words.length < 10) {
    return sortWordsByLineOrder(words);
  }
  const centers = words
    .map((word) => word.bbox.x + word.bbox.w / 2)
    .sort((a, b) => a - b);
  if (centers.length < 2) {
    return sortWordsByLineOrder(words);
  }

  let maxGap = 0;
  let splitIndex = -1;
  for (let i = 1; i < centers.length; i += 1) {
    const prev = centers[i - 1];
    const curr = centers[i];
    if (prev === undefined || curr === undefined) {
      continue;
    }
    const gap = curr - prev;
    if (gap > maxGap) {
      maxGap = gap;
      splitIndex = i;
    }
  }

  if (splitIndex < 0 || maxGap < 55) {
    return sortWordsByLineOrder(words);
  }

  const leftCenter = centers[splitIndex - 1];
  const rightCenter = centers[splitIndex];
  if (leftCenter === undefined || rightCenter === undefined) {
    return sortWordsByLineOrder(words);
  }
  const splitX = (leftCenter + rightCenter) / 2;
  const left = words.filter((word) => word.bbox.x + word.bbox.w / 2 <= splitX);
  const right = words.filter((word) => word.bbox.x + word.bbox.w / 2 > splitX);
  if (left.length < 4 || right.length < 4) {
    return sortWordsByLineOrder(words);
  }
  return [...sortWordsByLineOrder(left), ...sortWordsByLineOrder(right)];
}

function tokensEqualStrict(a: string, b: string): boolean {
  return a === b;
}

function tokensEqualRelaxed(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  if (a.length < 4 || b.length < 4) {
    return false;
  }
  return a.startsWith(b) || b.startsWith(a);
}

function matchSnippetFuzzyOrdered(orderedWords: CaptionWord[], tokens: string[]): Rect[] {
  if (tokens.length < 3 || orderedWords.length < 3) {
    return [];
  }

  let best: { rects: Rect[]; matched: number; span: number } | null = null;
  const minNeed = Math.max(2, Math.ceil(tokens.length * 0.6));
  for (let start = 0; start < orderedWords.length; start += 1) {
    const rects: Rect[] = [];
    let matched = 0;
    let cursor = start;
    let first = -1;
    let last = -1;
    for (const token of tokens) {
      let found = -1;
      const maxProbe = Math.min(orderedWords.length, cursor + Math.max(8, tokens.length * 2));
      for (let i = cursor; i < maxProbe; i += 1) {
        const candidate = orderedWords[i]?.norm ?? "";
        if (tokensEqualStrict(candidate, token) || tokensEqualRelaxed(candidate, token)) {
          found = i;
          break;
        }
      }
      if (found < 0) {
        continue;
      }
      matched += 1;
      if (first < 0) {
        first = found;
      }
      last = found;
      const bbox = orderedWords[found]?.bbox;
      if (bbox) {
        rects.push(bbox);
      }
      cursor = found + 1;
      if (cursor >= orderedWords.length) {
        break;
      }
    }

    if (matched < minNeed || rects.length < minNeed) {
      continue;
    }

    const span = first >= 0 && last >= first ? last - first + 1 : Number.MAX_SAFE_INTEGER;
    if (!best || matched > best.matched || (matched === best.matched && span < best.span)) {
      best = { rects, matched, span };
    }
  }

  return best?.rects ?? [];
}

function matchSnippetInOrder(
  orderedWords: CaptionWord[],
  tokens: string[],
  comparator: (a: string, b: string) => boolean,
): Rect[] {
  if (tokens.length === 0 || orderedWords.length < tokens.length) {
    return [];
  }
  for (let i = 0; i <= orderedWords.length - tokens.length; i += 1) {
    let ok = true;
    for (let j = 0; j < tokens.length; j += 1) {
      const lhs = orderedWords[i + j]?.norm ?? "";
      const rhs = tokens[j] ?? "";
      if (!comparator(lhs, rhs)) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      continue;
    }
    const rects: Rect[] = [];
    for (let j = 0; j < tokens.length; j += 1) {
      const bbox = orderedWords[i + j]?.bbox;
      if (bbox) {
        rects.push(bbox);
      }
    }
    if (rects.length > 0) {
      return rects;
    }
  }
  return [];
}

function resolveSnippetRectsFromCaptionWords(
  words: CaptionWord[],
  snippet: string,
): Rect[] {
  const tokens = normalizeSnippet(snippet)
    .split(/\s+/)
    .map((token) => normalizeTokenWord(token))
    .filter(Boolean);
  if (tokens.length === 0 || words.length === 0) {
    return [];
  }

  const orders = [sortWordsByLineOrder(words), sortWordsByColumnOrder(words)];
  for (const ordered of orders) {
    const strict = matchSnippetInOrder(ordered, tokens, tokensEqualStrict);
    if (strict.length > 0) {
      return strict;
    }
  }
  for (const ordered of orders) {
    const relaxed = matchSnippetInOrder(ordered, tokens, tokensEqualRelaxed);
    if (relaxed.length > 0) {
      return relaxed;
    }
  }
  for (const ordered of orders) {
    const fuzzy = matchSnippetFuzzyOrdered(ordered, tokens);
    if (fuzzy.length > 0) {
      return fuzzy;
    }
  }
  return [];
}

function deriveSnippetFromRects(words: CaptionWord[], rects: Rect[]): string | null {
  if (words.length === 0 || rects.length === 0) {
    return null;
  }

  const matched = words.filter((word) => rects.some((rect) => intersectsRect(word.bbox, rect, 1.5)));
  if (matched.length === 0) {
    return null;
  }

  const text = normalizeSnippet(matched.map((item) => item.text).join(" "));
  return text || null;
}

function uniqSnippets(values: string[]): string[] {
  return [...new Set(values.map((item) => normalizeSnippet(item)).filter(Boolean))];
}

function sameRects(a: Rect[], b: Rect[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const eps = 0.2;
  for (let i = 0; i < a.length; i += 1) {
    const ra = a[i];
    const rb = b[i];
    if (!ra || !rb) {
      return false;
    }
    if (
      Math.abs(ra.x - rb.x) > eps ||
      Math.abs(ra.y - rb.y) > eps ||
      Math.abs(ra.w - rb.w) > eps ||
      Math.abs(ra.h - rb.h) > eps
    ) {
      return false;
    }
  }
  return true;
}

async function getDocSpans(repo: StorageRepository, docId: string): Promise<ParsedTextSpan[]> {
  const cached = spanCache.get(docId);
  if (cached) {
    return cached;
  }
  const path = repo.getDocumentPath(docId);
  if (!path) {
    return [];
  }
  const spans = await extractTextSpans(path);
  spanCache.set(docId, spans);
  return spans;
}

async function syncCaptionWordHighlights(repo: StorageRepository, payload: CaptionSyncHighlightsPayload): Promise<void> {
  const desiredSnippets = uniqSnippets(payload.snippets);
  const allAnnotations = await ensureAnnotationsLoaded(repo, payload.docId);
  const legacyPrefix = `CAPTION_HL::${payload.targetId}::`;
  let nextAnnotations = allAnnotations.filter(
    (annotation) => !(annotation.kind === "highlight" && (annotation.text ?? "").startsWith(legacyPrefix)),
  );

  const existing = nextAnnotations
    .filter((item) => item.kind === "highlight")
    .map((item) => ({ item, meta: parseCaptionWordMeta(item.text) }))
    .filter((entry): entry is { item: AnnotationItem; meta: { targetId: string; snippet: string } } => !!entry.meta)
    .filter((entry) => entry.meta.targetId === payload.targetId);

  const existingBySnippet = new Map<string, AnnotationItem>();
  for (const entry of existing) {
    existingBySnippet.set(entry.meta.snippet, entry.item);
  }

  const spans = desiredSnippets.length > 0 ? await getDocSpans(repo, payload.docId) : [];
  const captionWords = desiredSnippets.length > 0 ? collectCaptionWordRects(spans, payload.page, payload.captionRect) : [];
  const touched = new Set<string>();

  for (const snippet of desiredSnippets) {
    const rects = resolveSnippetRectsFromCaptionWords(captionWords, snippet);
    const existingItem = existingBySnippet.get(snippet);
    if (rects.length === 0) {
      if (existingItem) {
        touched.add(snippet);
      }
      continue;
    }

    const text = encodeCaptionWordMeta(payload.targetId, snippet);
    if (!existingItem) {
      const now = toIsoNow();
      nextAnnotations.push({
        id: randomUUID(),
        docId: payload.docId,
        page: payload.page,
        kind: "highlight",
        rects: rects.map((rect) => ({ ...rect })),
        color: CAPTION_SYNC_COLOR,
        text,
        createdAt: now,
        updatedAt: now,
      });
      touched.add(snippet);
      continue;
    }

    const needsUpdate =
      !sameRects(existingItem.rects, rects) ||
      (existingItem.text ?? "") !== text ||
      (existingItem.color ?? "") !== CAPTION_SYNC_COLOR;
    if (needsUpdate) {
      existingItem.rects = rects.map((rect) => ({ ...rect }));
      existingItem.text = text;
      existingItem.color = CAPTION_SYNC_COLOR;
      existingItem.updatedAt = toIsoNow();
    }
    touched.add(snippet);
  }

  for (const [snippet, item] of existingBySnippet.entries()) {
    if (!touched.has(snippet)) {
      nextAnnotations = nextAnnotations.filter((annotation) => annotation.id !== item.id);
    }
  }

  annotationCache.set(
    payload.docId,
    nextAnnotations.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(cloneAnnotation),
  );
}

async function getLinkedCaptionSnippets(
  repo: StorageRepository,
  payload: CaptionGetLinkedSnippetsPayload,
): Promise<CaptionGetLinkedSnippetsResponse> {
  const all = (await ensureAnnotationsLoaded(repo, payload.docId)).filter(
    (item) => item.kind === "highlight" && item.page === payload.page,
  );

  const linkedSnippets: string[] = [];
  const articleSnippets: string[] = [];
  const spans = await getDocSpans(repo, payload.docId);
  const captionWords = collectCaptionWordRects(spans, payload.page, payload.captionRect);

  for (const annotation of all) {
    const meta = parseCaptionWordMeta(annotation.text);
    if (meta) {
      if (meta.targetId === payload.targetId) {
        linkedSnippets.push(meta.snippet);
      }
      continue;
    }

    const touchesCaption = annotation.rects.some((rect) => intersectsRect(rect, payload.captionRect, 24));
    if (!touchesCaption) {
      continue;
    }

    const directSnippet = normalizeArticleSnippet(annotation.text);
    if (directSnippet) {
      const directTokenCount = directSnippet
        .split(/\s+/)
        .map((token) => normalizeTokenWord(token))
        .filter(Boolean).length;
      if (directTokenCount < 3) {
        continue;
      }
      const matched = resolveSnippetRectsFromCaptionWords(captionWords, directSnippet);
      if (matched.length > 0) {
        articleSnippets.push(directSnippet);
        continue;
      }
    }

    const snippet = deriveSnippetFromRects(captionWords, annotation.rects);
    if (snippet) {
      articleSnippets.push(snippet);
    }
  }

  return {
    linkedSnippets: uniqSnippets(linkedSnippets),
    articleSnippets: uniqSnippets(articleSnippets),
  };
}

function escapeThenEmphasizeSubpanelLabels(rawText: string): string {
  const escaped = escapeHtml(rawText);
  return escaped.replace(
    /(^|[.;]\s+|\n+|\)\s+)([A-Za-z])\s*([,)])/g,
    (_match, prefix: string, label: string, tail: string) => {
      return `${prefix}<span class="sub">${label}${tail}</span>`;
    },
  );
}

function splitCaptionHeadAndBody(text: string): { headLabel: string | null; body: string } {
  const m = text.match(
    /^((?:Extended\s+Data\s+|Supplementary\s+)?(?:Figure|Fig\.?|Table)\s*[A-Za-z0-9]+[A-Za-z]?\s*:?)\s*(.*)$/i,
  );
  if (!m) {
    return { headLabel: null, body: text };
  }
  return { headLabel: (m[1] ?? "").trim(), body: (m[2] ?? "").trim() };
}

function bodyToParagraphs(rawBody: string): string {
  const chunks = rawBody
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  if (chunks.length === 0) {
    return "";
  }
  return chunks
    .map((chunk) => `<p class="cap-body">${escapeThenEmphasizeSubpanelLabels(chunk.replace(/\n/g, " "))}</p>`)
    .join("");
}

function captionToHtml(caption: string): string {
  const normalized = normalizeCaptionText(caption);
  if (!normalized) {
    return "<p class=\"cap-body\"></p>";
  }

  const parts = splitCaptionHeadAndBody(normalized);
  if (!parts.headLabel) {
    return bodyToParagraphs(parts.body);
  }

  const head = `<p class="cap-body"><span class="cap-label">${escapeHtml(parts.headLabel)}</span>${
    parts.body ? ` ${escapeThenEmphasizeSubpanelLabels(parts.body.split(/\n{2,}/)[0] ?? "")}` : ""
  }</p>`;
  const rest = parts.body.split(/\n{2,}/).slice(1).join("\n\n");
  return `${head}${bodyToParagraphs(rest)}`;
}

function captionToHtmlLegacy(caption: string): string {
  const normalized = normalizeCaptionText(caption);
  if (!normalized) {
    return "<p class=\"cap-body\"></p>";
  }

  const headingMatch = normalized.match(
    /^((?:Extended\s+Data\s+|Supplementary\s+)?(?:Figure|Fig\.?|Table)\s*[A-Za-z0-9]+[A-Za-z]?(?:\s*[|:]\s*[^.]+)?\.)\s*(.*)$/i,
  );

  if (headingMatch) {
    const heading = escapeHtml(headingMatch[1] ?? "");
    const restEscaped = escapeThenEmphasizeSubpanelLabels(headingMatch[2] ?? "");
    return `<p class="cap-head">${heading}</p>${restEscaped ? `<p class="cap-body">${restEscaped}</p>` : ""}`;
  }

  const escaped = escapeThenEmphasizeSubpanelLabels(normalized);
  return `<p class="cap-body">${escaped}</p>`;
}

function safeCaptionToHtml(caption: string): string {
  try {
    return captionToHtml(caption);
  } catch {
    return captionToHtmlLegacy(caption);
  }
}

export function registerIpcHandlers(repo: StorageRepository): void {
  const notifyAnnotationChanged = (docId: string): void => {
    const payload = { docId, ts: Date.now() };
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("annotation.changed", payload);
    }
  };

  ipcMain.handle("app.openExternal", async (_event, url: string) => {
    if (typeof url !== "string") {
      return false;
    }
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      return false;
    }
    await shell.openExternal(trimmed);
    return true;
  });

  ipcMain.handle("doc.pick", async () => {
    const result = await dialog.showOpenDialog({
      title: "Open PDF",
      properties: ["openFile"],
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (result.canceled) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle("doc.open", async (_event, path: string) => {
    const metadata = await openPdfMetadata(path);
    const opened = repo.openDocument(path, metadata.pageCount, metadata.title);
    spanCache.delete(opened.docId);
    annotationCache.delete(opened.docId);
    await reloadAnnotations(repo, opened.docId).catch(() => {
      annotationCache.set(opened.docId, []);
    });
    return opened;
  });

  ipcMain.handle("doc.readBinary", async (_event, path: string) => {
    const buf = await readFile(path);
    return [...buf];
  });

  ipcMain.handle("doc.parse", async (_event, docId: string) => {
    const path = repo.getDocumentPath(docId);
    if (!path) {
      return {
        status: "failed" as const,
        refsCount: 0,
        figuresCount: 0,
        tablesCount: 0,
        suppCount: 0,
      };
    }

    const spans = await extractTextSpans(path);
    const citations = extractCitations(spans, docId);
    const captions = extractCaptions(spans);
    const references = extractReferenceData(spans, docId);
    const manualTargets = repo.listManualTargets(docId);
    const mapped = mapCitationsToTargets(docId, citations, captions, manualTargets);

    spanCache.set(docId, spans);
    repo.replaceCitations(docId, citations);
    repo.replaceReferences(docId, references.markers, references.entries);
    repo.replaceAutoTargets(docId, mapped.targets.filter((target) => target.source === "auto"));
    repo.replaceCitationMappings(mapped.citationsToTarget);

    const stats = repo.stats(docId);
    return {
      status: "ok" as const,
      ...stats,
    };
  });

  ipcMain.handle("citation.resolve", (_event, docId: string, page: number, x: number, y: number) => {
    return repo.resolveCitationAtPoint(docId, page, x, y);
  });

  ipcMain.handle("citation.resolveByLabel", (_event, docId: string, kind: string, label: string) => {
    return repo.resolveCitationByKindLabel(docId, kind as "figure" | "table" | "supplementary", label);
  });

  ipcMain.handle("reference.resolve", (_event, docId: string, page: number, x: number, y: number) => {
    return repo.resolveReferenceAtPoint(docId, page, x, y);
  });

  ipcMain.handle("reference.getEntries", (_event, docId: string, indices: number[]) => {
    return repo.getReferenceEntries(docId, indices);
  });

  ipcMain.handle("reference.searchByText", (_event, docId: string, text: string, limit?: number) => {
    return repo.searchReferenceEntries(docId, text, limit);
  });

  ipcMain.handle("reference.hasEntries", (_event, docId: string) => {
    return repo.hasReferenceEntries(docId);
  });

  ipcMain.handle("figure.getTarget", (_event, docId: string, targetId: string) => {
    const target = repo.getTarget(docId, targetId);
    if (!target) {
      throw new Error(`target not found: ${targetId}`);
    }

    return {
      page: target.page,
      cropRect: target.cropRect,
      captionRect: target.captionRect,
      caption: target.caption,
      imageDataUrl: buildTargetPreviewDataUrl(target.caption, target.page, target.cropRect),
    };
  });

  ipcMain.handle("figure.listTargets", (_event, docId: string, kind: "figure" | "table" | "supplementary", label: string) => {
    return repo.listTargetsByKindLabel(docId, kind, label);
  });

  ipcMain.handle("figure.openPopup", async (_event, payload: FigurePopupPayload) => {
    const popup = new BrowserWindow({
      width: 1080,
      height: 900,
      title: `Figure Preview (Page ${payload.page})`,
      webPreferences: {
        preload: join(app.getAppPath(), "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    const popupMeta = encodeURIComponent(
      JSON.stringify({
        docId: payload.docId,
        targetId: payload.targetId,
        page: payload.page,
        captionRect: payload.captionRect ?? null,
      }),
    );

    const html = `<!doctype html>
      <html>
      <head><meta charset=\"utf-8\"/><title>Figure</title>
      <style>
      html,body{margin:0;padding:0;width:100%;height:100%}
      body{padding:16px;font-family:-apple-system,BlinkMacSystemFont,\"SF Pro Text\",\"Helvetica Neue\",Arial,sans-serif;background:#f3f6fa;color:#1e2d3f;overflow-y:auto}
      .wrap{display:flex;flex-direction:column;gap:14px}
      .img-wrap{background:#fff;border:1px solid #cbd7e4;border-radius:10px;padding:10px}
      .img-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:8px}
      .img-toolbar button{border:1px solid #c1ccdc;background:#fff;border-radius:8px;padding:5px 10px;cursor:pointer}
      .img-toolbar .zoom{font-size:13px;color:#4d6179;min-width:52px;text-align:right}
      .img-stage{border:1px solid #d4deea;border-radius:8px;overflow:auto;height:min(68vh,760px);background:#f7f9fc}
      img{display:block;width:100%;height:auto;object-fit:contain;user-select:none;-webkit-user-drag:none}
      .cap{background:#fff;border:1px solid #cbd7e4;border-radius:10px;padding:12px;line-height:1.52;font-size:16px;font-weight:400}
      .cap-head{margin:0 0 8px;font-weight:700}
      .cap-label{font-weight:700}
      .cap-body{margin:0;font-weight:400}
      .cap .sub{font-weight:700}
      .cap mark.cap-hl{background:#ffe47b;border-radius:3px;padding:0 1px}
      .cap-tools{margin-top:10px;display:flex;align-items:center;gap:8px}
      .cap-tools button{border:1px solid #c1ccdc;background:#fff;border-radius:8px;padding:5px 10px;cursor:pointer}
      .cap-tools button:disabled{opacity:0.5;cursor:not-allowed}
      .cap-hint{font-size:12px;color:#5b6d84}
      </style></head>
      <body><div class=\"wrap\"><div class=\"img-wrap\"><div class=\"img-toolbar\"><button id=\"zoomOut\" type=\"button\" title=\"Zoom out\">-</button><button id=\"zoomReset\" type=\"button\" title=\"Reset zoom\">100%</button><button id=\"zoomIn\" type=\"button\" title=\"Zoom in\">+</button><div class=\"zoom\" id=\"zoomText\">100%</div></div><div class=\"img-stage\" id=\"imgStage\"><img id=\"targetImage\" src=\"${payload.imageDataUrl}\" alt=\"target\"/></div></div><div class=\"cap\"><div id=\"captionText\">${safeCaptionToHtml(
      payload.caption,
    )}</div><div class=\"cap-tools\"><button id=\"captionHighlight\" type=\"button\" title=\"Create linked highlight from selected caption text\">Highlight Selection</button><button id=\"captionClear\" type=\"button\" title=\"Remove all linked caption highlights for this figure\">Clear Caption Highlights</button><div class=\"cap-hint\" id=\"capHint\">Select text in caption, then click Highlight Selection.</div></div></div></div>
    <script>
      (() => {
        const meta = JSON.parse(decodeURIComponent('${popupMeta}'));
        const api = window.journalApi;
        const stage = document.getElementById('imgStage');
        const img = document.getElementById('targetImage');
        const zoomText = document.getElementById('zoomText');
        const zoomIn = document.getElementById('zoomIn');
        const zoomOut = document.getElementById('zoomOut');
        const zoomReset = document.getElementById('zoomReset');
        const captionTextEl = document.getElementById('captionText');
        const captionHighlightBtn = document.getElementById('captionHighlight');
        const captionClearBtn = document.getElementById('captionClear');
        const capHint = document.getElementById('capHint');
        if (!stage || !img || !zoomText || !zoomIn || !zoomOut || !zoomReset || !captionTextEl || !captionHighlightBtn || !captionClearBtn || !capHint) return;

        let scale = 1;
        const minScale = 0.5;
        const maxScale = 5;
        const originalCaptionHtml = captionTextEl.innerHTML;
        let linkedSnippets = [];
        let articleSnippets = [];
        let lastSelectionSnippet = '';

        const clamp = (v) => Math.max(minScale, Math.min(maxScale, v));
        const render = () => {
          img.style.width = (scale * 100).toFixed(3) + '%';
          const pct = Math.round(scale * 100);
          zoomText.textContent = pct + '%';
          zoomReset.textContent = pct + '%';
        };

        const zoomAt = (nextScale, offsetX, offsetY) => {
          const target = clamp(nextScale);
          if (Math.abs(target - scale) < 0.0001) return;
          const ratio = target / scale;
          const nextScrollLeft = (stage.scrollLeft + offsetX) * ratio - offsetX;
          const nextScrollTop = (stage.scrollTop + offsetY) * ratio - offsetY;
          scale = target;
          render();
          requestAnimationFrame(() => {
            stage.scrollLeft = nextScrollLeft;
            stage.scrollTop = nextScrollTop;
          });
        };

        const normalizeSnippet = (text) => text.replace(/\\s+/g, ' ').trim();
        const uniqSnippets = (values) => [...new Set(values.map((item) => normalizeSnippet(item)).filter(Boolean))];
        const allSnippets = () => uniqSnippets([...linkedSnippets, ...articleSnippets]);

        const collectTextNodes = (root) => {
          const nodes = [];
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let current = walker.nextNode();
          while (current) {
            const value = current.nodeValue || '';
            if (value.length > 0) {
              nodes.push({ node: current, text: value });
            }
            current = walker.nextNode();
          }
          return nodes;
        };

        const highlightOccurrence = (root, needle) => {
          const nodes = collectTextNodes(root);
          const full = nodes.map((item) => item.text).join('');
          const normalizedNeedle = needle.toLowerCase();
          if (!normalizedNeedle) return;

          const offsets = [];
          let from = 0;
          const lower = full.toLowerCase();
          while (true) {
            const idx = lower.indexOf(normalizedNeedle, from);
            if (idx < 0) break;
            offsets.push({ start: idx, end: idx + normalizedNeedle.length });
            from = idx + normalizedNeedle.length;
          }

          for (let i = offsets.length - 1; i >= 0; i -= 1) {
            const range = offsets[i];
            let acc = 0;
            let startNode = null;
            let endNode = null;
            let startOffset = 0;
            let endOffset = 0;
            for (const entry of nodes) {
              const next = acc + entry.text.length;
              if (!startNode && range.start >= acc && range.start <= next) {
                startNode = entry.node;
                startOffset = range.start - acc;
              }
              if (!endNode && range.end >= acc && range.end <= next) {
                endNode = entry.node;
                endOffset = range.end - acc;
                break;
              }
              acc = next;
            }
            if (!startNode || !endNode) continue;
            const docRange = document.createRange();
            docRange.setStart(startNode, startOffset);
            docRange.setEnd(endNode, endOffset);
            const mark = document.createElement('mark');
            mark.className = 'cap-hl';
            const frag = docRange.extractContents();
            mark.appendChild(frag);
            docRange.insertNode(mark);
          }
        };

        const renderCaptionHighlights = () => {
          captionTextEl.innerHTML = originalCaptionHtml;
          linkedSnippets = uniqSnippets(linkedSnippets);
          articleSnippets = uniqSnippets(articleSnippets);
          const merged = allSnippets();
          for (const snippet of merged) {
            highlightOccurrence(captionTextEl, snippet);
          }
          capHint.textContent = merged.length > 0
            ? 'Caption highlights stay linked with article highlights automatically.'
            : 'Select text in caption, then click Highlight Selection.';
        };

        const persistCaptionHighlights = async () => {
          if (!api || !meta.docId || !meta.captionRect) return;
          await api.captionSyncHighlights({
            docId: meta.docId,
            targetId: meta.targetId,
            page: meta.page,
            captionRect: meta.captionRect,
            snippets: linkedSnippets,
          });
        };

        const loadLinkedAnnotation = async () => {
          if (!api || !meta.docId || !meta.captionRect) return;
          const result = await api.captionGetLinkedSnippets({
            docId: meta.docId,
            targetId: meta.targetId,
            page: meta.page,
            captionRect: meta.captionRect,
          });
          linkedSnippets = result?.linkedSnippets || [];
          articleSnippets = result?.articleSnippets || [];
          renderCaptionHighlights();
        };

        const selectedCaptionSnippet = () => {
          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
            return '';
          }
          const range = selection.getRangeAt(0);
          if (!captionTextEl.contains(range.commonAncestorContainer)) {
            return '';
          }
          return normalizeSnippet(selection.toString());
        };

        const rememberSelection = () => {
          const snippet = selectedCaptionSnippet();
          if (snippet) {
            lastSelectionSnippet = snippet;
          }
        };

        stage.addEventListener('wheel', (event) => {
          if (!event.ctrlKey) return;
          event.preventDefault();
          const rect = stage.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const y = event.clientY - rect.top;
          const factor = Math.exp(-event.deltaY * 0.0025);
          zoomAt(scale * factor, x, y);
        }, { passive: false });

        zoomIn.addEventListener('click', () => {
          zoomAt(scale + 0.15, stage.clientWidth * 0.5, stage.clientHeight * 0.5);
        });
        zoomOut.addEventListener('click', () => {
          zoomAt(scale - 0.15, stage.clientWidth * 0.5, stage.clientHeight * 0.5);
        });
        zoomReset.addEventListener('click', () => {
          scale = 1;
          render();
          stage.scrollLeft = 0;
          stage.scrollTop = 0;
        });

        const onSelectionChange = () => {
          rememberSelection();
        };
        document.addEventListener('selectionchange', onSelectionChange);
        captionHighlightBtn.addEventListener('mousedown', (event) => {
          event.preventDefault();
        });

        captionHighlightBtn.addEventListener('click', async () => {
          if (!meta.captionRect) {
            capHint.textContent = 'No caption rectangle found, cannot link to article.';
            return;
          }
          const snippet = selectedCaptionSnippet() || lastSelectionSnippet;
          if (!snippet) {
            capHint.textContent = 'Select some caption text first.';
            return;
          }
          if (!linkedSnippets.includes(snippet)) {
            linkedSnippets.push(snippet);
          }
          renderCaptionHighlights();
          await persistCaptionHighlights();
          const selection = window.getSelection();
          if (selection) {
            selection.removeAllRanges();
          }
          lastSelectionSnippet = '';
        });

        captionClearBtn.addEventListener('click', async () => {
          linkedSnippets = [];
          renderCaptionHighlights();
          await persistCaptionHighlights();
        });

        if (!meta.captionRect) {
          captionHighlightBtn.disabled = true;
          captionClearBtn.disabled = true;
          capHint.textContent = 'This figure has no caption rectangle, linked highlights are unavailable.';
        }

        const unsubscribe = typeof api?.onAnnotationChanged === 'function'
          ? api.onAnnotationChanged((event) => {
              if (!meta.docId) return;
              if (event?.docId && event.docId !== meta.docId) return;
              void loadLinkedAnnotation();
            })
          : null;
        window.addEventListener('beforeunload', () => {
          document.removeEventListener('selectionchange', onSelectionChange);
          if (typeof unsubscribe === 'function') {
            unsubscribe();
          }
        });

        render();
        void loadLinkedAnnotation();
      })();
    </script>
    </body></html>`;

    const popupDir = join(app.getPath("temp"), "journal-reader-popups");
    await mkdir(popupDir, { recursive: true });
    const popupFile = join(popupDir, `figure-${Date.now()}-${randomUUID()}.html`);
    await writeFile(popupFile, html, "utf-8");
    popup.once("closed", () => {
      void rm(popupFile, { force: true }).catch(() => undefined);
    });
    await popup.loadFile(popupFile);
  });

  ipcMain.handle("reference.openPopup", (_event, payload: { indices: number[]; entries: ReferenceEntry[] }) => {
    const popup = new BrowserWindow({
      width: 920,
      height: 820,
      title: `References (${payload.indices.join(", ")})`,
      webPreferences: {
        sandbox: true,
      },
    });

    const rows = payload.entries
      .map(
        (entry) =>
          `<div class=\"entry\"><div class=\"idx\">[${entry.index}]</div><div class=\"txt\">${escapeHtml(entry.text)}<div class=\"meta\">p.${entry.page}</div></div></div>`,
      )
      .join("");

    const html = `<!doctype html>
      <html>
      <head><meta charset=\"utf-8\"/><title>References</title>
      <style>
      html,body{margin:0;padding:0;width:100%;height:100%}
      body{padding:16px;font-family:Helvetica,Arial,sans-serif;background:#f3f6fa;color:#1e2d3f;overflow-y:auto}
      .head{font-size:18px;font-weight:700;margin:0 0 10px}
      .list{display:flex;flex-direction:column;gap:10px}
      .entry{display:grid;grid-template-columns:70px 1fr;gap:10px;background:#fff;border:1px solid #cbd7e4;border-radius:10px;padding:10px}
      .idx{font-weight:700;color:#23466a}
      .txt{line-height:1.5}
      .meta{color:#64748b;font-size:12px;margin-top:4px}
      .empty{background:#fff;border:1px solid #cbd7e4;border-radius:10px;padding:12px}
      </style></head>
      <body>
        <div class=\"head\">References: ${escapeHtml(payload.indices.join(", "))}</div>
        ${
          rows
            ? `<div class=\"list\">${rows}</div>`
            : `<div class=\"empty\">No matched reference entries were found for the selected marker.</div>`
        }
      </body></html>`;

    void popup.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });

  ipcMain.handle("annotation.create", async (_event, payload: Omit<AnnotationItem, "id" | "createdAt" | "updatedAt">) => {
    const now = toIsoNow();
    const list = await ensureAnnotationsLoaded(repo, payload.docId);
    const created: AnnotationItem = {
      id: randomUUID(),
      docId: payload.docId,
      page: payload.page,
      kind: payload.kind,
      rects: payload.rects.map((rect) => ({ ...rect })),
      text: payload.text,
      color: payload.color,
      style: payload.style
        ? {
            fontSize: payload.style.fontSize,
            fontFamily: payload.style.fontFamily,
            textColor: payload.style.textColor,
          }
        : undefined,
      createdAt: now,
      updatedAt: now,
    };
    list.push(created);
    annotationCache.set(payload.docId, list.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(cloneAnnotation));
    notifyAnnotationChanged(payload.docId);
    return cloneAnnotation(created);
  });

  ipcMain.handle("annotation.update", async (_event, payload: Partial<AnnotationItem> & { id: string }) => {
    const docId = payload.docId ?? findAnnotationDocId(payload.id);
    if (!docId) {
      return null;
    }
    const list = await ensureAnnotationsLoaded(repo, docId);
    const index = list.findIndex((item) => item.id === payload.id);
    if (index < 0) {
      return null;
    }
    const current = list[index];
    if (!current) {
      return null;
    }
    const updated: AnnotationItem = {
      ...current,
      docId,
      page: payload.page ?? current.page,
      kind: payload.kind ?? current.kind,
      rects: payload.rects ? payload.rects.map((rect) => ({ ...rect })) : current.rects.map((rect) => ({ ...rect })),
      text: payload.text ?? current.text,
      color: payload.color ?? current.color,
      style:
        payload.style !== undefined
          ? {
              fontSize: payload.style?.fontSize,
              fontFamily: payload.style?.fontFamily,
              textColor: payload.style?.textColor,
            }
          : current.style
            ? {
                fontSize: current.style.fontSize,
                fontFamily: current.style.fontFamily,
                textColor: current.style.textColor,
              }
            : undefined,
      updatedAt: toIsoNow(),
    };
    list[index] = updated;
    annotationCache.set(docId, list.map(cloneAnnotation));
    notifyAnnotationChanged(docId);
    return cloneAnnotation(updated);
  });

  ipcMain.handle("annotation.delete", async (_event, id: string) => {
    const docId = findAnnotationDocId(id);
    if (!docId) {
      return false;
    }
    const list = await ensureAnnotationsLoaded(repo, docId);
    const next = list.filter((item) => item.id !== id);
    const deleted = next.length !== list.length;
    if (!deleted) {
      return false;
    }
    annotationCache.set(docId, next.map(cloneAnnotation));
    notifyAnnotationChanged(docId);
    return true;
  });

  ipcMain.handle("annotation.list", async (_event, docId: string) => {
    const list = await ensureAnnotationsLoaded(repo, docId);
    return cloneAnnotationList(list).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  });

  ipcMain.handle("annotation.reloadFromPdf", async (_event, docId: string) => {
    const list = await reloadAnnotations(repo, docId);
    notifyAnnotationChanged(docId);
    return cloneAnnotationList(list).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  });

  ipcMain.handle("caption.syncHighlights", async (_event, payload: CaptionSyncHighlightsPayload) => {
    await syncCaptionWordHighlights(repo, payload);
    notifyAnnotationChanged(payload.docId);
  });

  ipcMain.handle("caption.getLinkedSnippets", async (_event, payload: CaptionGetLinkedSnippetsPayload) => {
    return getLinkedCaptionSnippets(repo, payload);
  });

  ipcMain.handle("annotation.saveToPdf", async (_event, docId: string) => {
    const path = repo.getDocumentPath(docId);
    if (!path) {
      throw new Error(`missing document path for ${docId}`);
    }
    const annotations = await ensureAnnotationsLoaded(repo, docId);
    const result = await saveAnnotationsToPdf(path, annotations);
    await reloadAnnotations(repo, docId);
    notifyAnnotationChanged(docId);
    return result;
  });

  ipcMain.handle(
    "mapping.bindManually",
    (
      _event,
      docId: string,
      citationId: string,
      targetRect: Rect,
      captionText: string,
      targetPage?: number,
    ): BindManuallyResponse => {
      return repo.bindManualTarget(docId, citationId, targetRect, captionText, targetPage);
    },
  );
}
