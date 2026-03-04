import { app, ipcMain, BrowserWindow, dialog, shell } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractCitations, extractCaptions, extractReferenceData, inferReferenceCount, mapCitationsToTargets } from "@journal-reader/parser";
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
  RecognizedPopupKind,
  ReferenceEntry,
  TranslatePopupPayload,
  TranslateProvider,
  TranslateTextPayload,
  TranslateTextResponse,
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

function isExtendedDataCaption(text: string): boolean {
  return /^\s*extended\s+data\s+fig(?:ure)?\b/i.test(text);
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

async function loadPopupHtmlFile(popup: BrowserWindow, prefix: string, html: string): Promise<boolean> {
  try {
    const popupDir = join(app.getPath("temp"), "journal-reader-popups");
    await mkdir(popupDir, { recursive: true });
    const popupFile = join(popupDir, `${prefix}-${Date.now()}-${randomUUID()}.html`);
    await writeFile(popupFile, html, "utf-8");
    popup.once("closed", () => {
      void rm(popupFile, { force: true }).catch(() => undefined);
    });
    await popup.loadFile(popupFile);
    return true;
  } catch (error) {
    const fallbackHtml = `<!doctype html><html><head><meta charset="utf-8"/><title>Popup Error</title><style>html,body{margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif;background:#f3f6fa;color:#1e2d3f;padding:16px}pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #cbd7e4;border-radius:8px;padding:10px}</style></head><body><h3>Popup Rendering Error</h3><pre>${escapeHtml(error instanceof Error ? error.message : String(error))}</pre></body></html>`;
    try {
      await popup.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fallbackHtml)}`);
      return true;
    } catch {
      return false;
    }
  }
}

function normalizeLangCode(raw: string | undefined, fallback: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  return value || fallback;
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 12000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function chunkText(text: string, maxChars: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.length <= maxChars) {
    return [normalized];
  }
  const chunks: string[] = [];
  let index = 0;
  while (index < normalized.length) {
    const next = normalized.slice(index, index + maxChars);
    chunks.push(next);
    index += maxChars;
  }
  return chunks;
}

async function translateWithGoogle(payload: TranslateTextPayload): Promise<TranslateTextResponse> {
  const sourceLang = normalizeLangCode(payload.sourceLang, "auto");
  const targetLang = normalizeLangCode(payload.targetLang, "en");
  const chunks = chunkText(payload.text, 1500);
  const translatedChunks: string[] = [];
  let detectedSourceLang: string | undefined;
  for (const chunk of chunks) {
    const query = new URLSearchParams({
      client: "gtx",
      sl: sourceLang,
      tl: targetLang,
      dt: "t",
      q: chunk,
    });
    const response = await fetchWithTimeout(`https://translate.googleapis.com/translate_a/single?${query.toString()}`, {
      headers: {
        Accept: "application/json,text/plain,*/*",
        "User-Agent": "JournalReaderApp/0.0.1",
      },
    });
    if (!response.ok) {
      throw new Error(`Google translate request failed (${response.status})`);
    }
    const data = (await response.json()) as unknown;
    const outer = Array.isArray(data) ? data : [];
    const segments = Array.isArray(outer[0]) ? (outer[0] as unknown[]) : [];
    const translatedChunk = segments
      .map((segment) => {
        const row = Array.isArray(segment) ? segment : [];
        return typeof row[0] === "string" ? row[0] : "";
      })
      .join("");
    if (!translatedChunk.trim()) {
      throw new Error("Google returned an empty translation result.");
    }
    translatedChunks.push(translatedChunk);
    if (!detectedSourceLang && typeof outer[2] === "string") {
      detectedSourceLang = outer[2];
    }
  }
  const translatedText = translatedChunks.join("").trim();
  return {
    provider: "google",
    sourceLang,
    targetLang,
    detectedSourceLang,
    translatedText,
  };
}

async function translateWithLibre(payload: TranslateTextPayload): Promise<TranslateTextResponse> {
  const sourceLang = normalizeLangCode(payload.sourceLang, "auto");
  const targetLang = normalizeLangCode(payload.targetLang, "en");
  const response = await fetchWithTimeout("https://libretranslate.de/translate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "JournalReaderApp/0.0.1",
    },
    body: JSON.stringify({
      q: payload.text,
      source: sourceLang,
      target: targetLang,
      format: "text",
      api_key: "",
    }),
  });
  if (!response.ok) {
    throw new Error(`LibreTranslate request failed (${response.status})`);
  }
  const data = (await response.json()) as {
    translatedText?: string;
    detectedLanguage?: { language?: string };
  };
  const translatedText = (data.translatedText ?? "").trim();
  if (!translatedText) {
    throw new Error("LibreTranslate returned an empty translation result.");
  }
  return {
    provider: "libre",
    sourceLang,
    targetLang,
    detectedSourceLang: data.detectedLanguage?.language,
    translatedText,
  };
}

async function translateWithMyMemory(payload: TranslateTextPayload): Promise<TranslateTextResponse> {
  const sourceLang = normalizeLangCode(payload.sourceLang, "auto");
  const targetLang = normalizeLangCode(payload.targetLang, "en");
  const from = sourceLang === "auto" ? "en" : sourceLang;
  const chunks = chunkText(payload.text, 600);
  const translatedChunks: string[] = [];
  for (const chunk of chunks) {
    const query = new URLSearchParams({
      q: chunk,
      langpair: `${from}|${targetLang}`,
    });
    const response = await fetchWithTimeout(`https://api.mymemory.translated.net/get?${query.toString()}`, {
      headers: {
        Accept: "application/json,text/plain,*/*",
        "User-Agent": "JournalReaderApp/0.0.1",
      },
    });
    if (!response.ok) {
      throw new Error(`MyMemory request failed (${response.status})`);
    }
    const data = (await response.json()) as {
      responseData?: { translatedText?: string };
      responseStatus?: number;
      responseDetails?: string;
    };
    if (data.responseStatus && data.responseStatus !== 200) {
      throw new Error(data.responseDetails || `MyMemory returned ${data.responseStatus}`);
    }
    const piece = (data.responseData?.translatedText ?? "").trim();
    if (!piece) {
      throw new Error("MyMemory returned an empty translation result.");
    }
    translatedChunks.push(piece);
  }
  const translatedText = translatedChunks.join("").trim();
  if (!translatedText) {
    throw new Error("MyMemory returned an empty translation result.");
  }
  return {
    provider: "mymemory",
    sourceLang,
    targetLang,
    detectedSourceLang: sourceLang === "auto" ? undefined : sourceLang,
    translatedText,
  };
}

async function translateText(payload: TranslateTextPayload): Promise<TranslateTextResponse> {
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) {
    throw new Error("Text to translate is empty.");
  }
  const normalized: TranslateTextPayload = {
    text,
    sourceLang: normalizeLangCode(payload.sourceLang, "auto"),
    targetLang: normalizeLangCode(payload.targetLang, "en"),
    provider: payload.provider ?? "google",
  };
  const order: TranslateProvider[] =
    normalized.provider === "google"
      ? ["google", "libre", "mymemory"]
      : normalized.provider === "libre"
        ? ["libre", "mymemory", "google"]
        : ["mymemory", "libre", "google"];
  const failures: string[] = [];
  for (const provider of order) {
    try {
      if (provider === "google") {
        return await translateWithGoogle({ ...normalized, provider });
      }
      if (provider === "libre") {
        return await translateWithLibre({ ...normalized, provider });
      }
      return await translateWithMyMemory({ ...normalized, provider });
    } catch (error) {
      failures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Translation providers failed. ${failures.join(" | ")}`);
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
        extCount: 0,
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
    const extCount = mapped.targets.filter(
      (target) => target.kind === "supplementary" && isExtendedDataCaption(target.caption ?? ""),
    ).length;
    const refsCount = inferReferenceCount(references.entries, references.markers);
    return {
      status: "ok" as const,
      refsCount,
      figuresCount: stats.figuresCount,
      tablesCount: stats.tablesCount,
      extCount,
      suppCount: Math.max(0, stats.suppCount - extCount),
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

  ipcMain.handle("translate.text", async (_event, payload: TranslateTextPayload) => {
    return translateText(payload);
  });

  ipcMain.handle("translate.openPopup", async (_event, payload: TranslatePopupPayload) => {
    const popup = new BrowserWindow({
      width: 760,
      height: 540,
      minWidth: 560,
      minHeight: 420,
      title: `Translation (${payload.provider})`,
      webPreferences: {
        sandbox: true,
      },
    });

    const sourceLabel =
      payload.sourceLang === "auto" ? `Auto (${payload.detectedSourceLang || "unknown"})` : payload.sourceLang;
    const html = `<!doctype html>
      <html>
      <head><meta charset=\"utf-8\"/><title>Translation</title>
      <style>
      html,body{margin:0;padding:0;width:100%;height:100%}
      body{padding:14px;font-family:-apple-system,BlinkMacSystemFont,\"SF Pro Text\",\"Helvetica Neue\",Arial,sans-serif;background:#f3f6fa;color:#1e2d3f;overflow:auto}
      .meta{font-size:12px;color:#5b6d84;margin-bottom:10px}
      .card{background:#fff;border:1px solid #cbd7e4;border-radius:10px;padding:10px 12px}
      .head{font-size:13px;font-weight:700;color:#31465f;margin:0 0 6px}
      .txt{font-size:15px;line-height:1.54;white-space:pre-wrap;word-break:break-word}
      .grid{display:grid;grid-template-rows:auto auto;gap:10px}
      </style></head>
      <body>
        <div class=\"meta\">Provider: ${escapeHtml(payload.provider)} | ${escapeHtml(sourceLabel)} → ${escapeHtml(payload.targetLang)}</div>
        <div class=\"grid\">
          <div class=\"card\"><div class=\"head\">Source</div><div class=\"txt\">${escapeHtml(payload.sourceText)}</div></div>
          <div class=\"card\"><div class=\"head\">Translation</div><div class=\"txt\">${escapeHtml(payload.translatedText)}</div></div>
        </div>
      </body></html>`;
    await loadPopupHtmlFile(popup, "translation", html);
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

  ipcMain.handle("recognized.openPopup", async (_event, docId: string, kind: RecognizedPopupKind) => {
    try {
      const popup = new BrowserWindow({
        width: 960,
        height: 760,
        minWidth: 680,
        minHeight: 520,
        title: "Recognized Items",
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });

      let title = "Recognized Items";
      let rows = "";
      try {
        if (kind === "ref") {
          title = "Recognized References";
          const entries = repo.listAllReferenceEntries(docId);
          rows = entries
            .map(
              (entry) =>
                `<div class="row"><div class="id">[${entry.index}]</div><div><div class="txt">${escapeHtml(entry.text)}</div><div class="meta">p.${entry.page}</div></div></div>`,
            )
            .join("");
        } else {
          const targetKind = kind === "fig" ? "figure" : kind === "table" ? "table" : "supplementary";
          title =
            kind === "fig"
              ? "Recognized Figures"
              : kind === "ext"
                ? "Recognized Extended Data Figures"
              : kind === "supp"
                ? "Recognized Supplementary Figures/Tables"
                : "Recognized Tables";
          const allTargets = repo.listTargetsByKind(docId, targetKind);
          const targets =
            kind === "ext"
              ? allTargets.filter((target) => isExtendedDataCaption(typeof target.caption === "string" ? target.caption : ""))
              : kind === "supp"
                ? allTargets.filter((target) => !isExtendedDataCaption(typeof target.caption === "string" ? target.caption : ""))
                : allTargets;
          rows = targets
            .map((target) => {
              const caption = normalizeSnippet(typeof target.caption === "string" ? target.caption : "").slice(0, 600);
              const label = typeof target.label === "string" ? target.label : String(target.label ?? "");
              const source = typeof target.source === "string" ? target.source : "auto";
              const confidence = Number.isFinite(target.confidence) ? target.confidence : 0;
              return `<div class="row"><div class="id">${escapeHtml(label)}</div><div><div class="txt">${escapeHtml(caption)}</div><div class="meta">p.${target.page} | ${escapeHtml(source)} | conf ${confidence.toFixed(2)}</div></div></div>`;
            })
            .join("");
        }
      } catch (error) {
        rows = `<div class="empty">Failed to render recognized list: ${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
      }

      const html = `<!doctype html>
        <html><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>
        <style>
        html,body{margin:0;padding:0;width:100%;height:100%}
        body{padding:14px;font-family:-apple-system,BlinkMacSystemFont,\"SF Pro Text\",\"Helvetica Neue\",Arial,sans-serif;background:#f3f6fa;color:#1e2d3f;overflow:auto}
        .head{font-size:20px;font-weight:800;margin:0 0 10px}
        .list{display:flex;flex-direction:column;gap:10px}
        .row{display:grid;grid-template-columns:100px 1fr;gap:10px;background:#fff;border:1px solid #cbd7e4;border-radius:10px;padding:10px}
        .id{font-weight:700;color:#26466a;word-break:break-word}
        .txt{line-height:1.48;white-space:pre-wrap;word-break:break-word}
        .meta{color:#64748b;font-size:12px;margin-top:4px}
        .empty{background:#fff;border:1px solid #cbd7e4;border-radius:10px;padding:12px}
        </style>
        </head><body>
        <div class="head">${escapeHtml(title)}</div>
        ${rows.includes('class="empty"') ? rows : rows ? `<div class="list">${rows}</div>` : `<div class="empty">No recognized items found.</div>`}
        </body></html>`;

      try {
        await popup.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        return true;
      } catch {
        return await loadPopupHtmlFile(popup, "recognized", html);
      }
    } catch (error) {
      console.error("[journal-reader] recognized.openPopup failed:", error);
      return false;
    }
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
        captionPage: payload.captionPage ?? payload.page,
        captionRect: payload.captionRect ?? null,
        pageRect: payload.pageRect ?? null,
        focusRect: payload.focusRect ?? null,
        fullPageMode: Boolean(payload.pageImageDataUrl && payload.pageRect && payload.focusRect),
      }),
    );

    const html = `<!doctype html>
      <html>
      <head><meta charset=\"utf-8\"/><title>Figure</title>
      <style>
      html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}
      *{box-sizing:border-box}
      body{padding:12px;font-family:-apple-system,BlinkMacSystemFont,\"SF Pro Text\",\"Helvetica Neue\",Arial,sans-serif;background:#f3f6fa;color:#1e2d3f}
      .wrap{display:grid;grid-template-rows:minmax(0,1fr) auto;gap:12px;height:100%}
      .img-wrap{background:#fff;border:1px solid #cbd7e4;border-radius:10px;padding:10px;display:flex;flex-direction:column;min-height:0;min-width:0}
      .img-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;min-width:0}
      .toolbar-group{display:inline-flex;align-items:center;gap:6px;padding:4px;border:1px solid #ccd7e7;border-radius:12px;background:#eef3fa}
      .icon-btn{width:34px;height:30px;border:1px solid #bcc6d4;background:#fff;border-radius:8px;padding:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:#2b3848}
      .icon-btn:hover{background:#f7f9fc}
      .icon-btn.active{border-color:#2d5f9e;background:#dce9fb}
      .icon-btn svg{width:17px;height:17px;stroke:currentColor;stroke-width:1.8;fill:none;stroke-linecap:round;stroke-linejoin:round}
      .zoom-reset{min-width:76px;padding:0 10px;font-variant-numeric:tabular-nums}
      .zoom{font-size:13px;color:#4d6179;min-width:52px;text-align:right;font-variant-numeric:tabular-nums}
      .img-toolbar .hint{font-size:12px;color:#5b6d84;flex:1 1 220px;min-width:120px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .tool-group{display:inline-flex;align-items:center;gap:4px}
      .tool{width:34px;height:30px;border:1px solid #bcc6d4;background:#fff;border-radius:8px;padding:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:#2b3848}
      .tool:hover{background:#f7f9fc}
      .tool svg{width:17px;height:17px;stroke:currentColor;stroke-width:1.8;fill:none;stroke-linecap:round;stroke-linejoin:round}
      .tool.active{border-color:#2d5f9e;background:#dce9fb}
      .swatches{display:inline-flex;align-items:center;gap:5px}
      .swatch{width:16px;height:16px;border-radius:50%;border:1px solid #a5b2c3;padding:0;cursor:pointer}
      .swatch.active{box-shadow:0 0 0 2px #2d5f9e}
      .img-stage{border:1px solid #d4deea;border-radius:8px;overflow:hidden;min-height:0;flex:1;background:#f7f9fc;min-width:0;max-width:100%}
      .canvas-wrap{position:relative;display:block;width:max-content;height:max-content}
      img{display:block;max-width:none;max-height:none;user-select:none;-webkit-user-drag:none}
      .ann-layer{position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none}
      .ann-preview{position:absolute;border:1px dashed #2b5f9f;background:rgba(66,120,203,0.14);pointer-events:none;display:none}
      .p-ann-interactive{pointer-events:auto}
      .p-ann-hl{position:absolute;border:none;border-radius:2px;background:rgba(252,229,136,0.42);mix-blend-mode:multiply;padding:0;cursor:pointer}
      .p-ann-hl:hover{outline:1px solid #d4a20c}
      .p-ann-text{position:absolute;display:flex;flex-direction:column;gap:4px;padding:0;background:transparent;cursor:move}
      .p-ann-text .p-ann-toolbar{display:none;align-items:center;gap:6px;padding:3px 5px;border:1px solid #c6cfdd;border-radius:8px;background:#f8fbffeb;width:max-content;box-shadow:0 6px 16px rgba(27,46,78,0.18)}
      .p-ann-text.focused .p-ann-toolbar{display:inline-flex}
      .p-ann-toolbar select,.p-ann-toolbar input[type="color"]{height:24px;border:1px solid #c1cad8;border-radius:6px;background:#fff;color:#2d3b4d;font-size:12px}
      .p-ann-toolbar select{padding:1px 6px}
      .p-ann-toolbar input[type="color"]{width:28px;padding:0}
      .p-ann-textarea{min-width:70px;min-height:28px;width:100%;resize:both;border:none;background:transparent;outline:none;line-height:1.12;font-weight:500;padding:0;overflow:hidden;cursor:text}
      .p-ann-text.focused .p-ann-textarea{box-shadow:0 0 0 1px #2a5fa8 inset;border-radius:4px}
      .p-ann-textarea::placeholder{color:#7486a0}
      .p-ann-actions{display:flex;justify-content:flex-end;gap:4px}
      .p-ann-actions button{width:18px;height:18px;border-radius:7px;padding:0;line-height:16px;font-size:12px}
      .p-ann-delete{display:inline-flex;align-items:center;justify-content:center;border:1px solid #c5b68f;background:#ffffffcf;color:#7a6042;border-radius:7px;width:18px;height:18px;line-height:16px;padding:0;cursor:pointer}
      .p-ann-sticky{position:absolute;cursor:move}
      .p-ann-sticky .icon{width:20px;height:20px;border-radius:50%;border:1px solid #cdbd8b;background:#ffefbb;color:#6b5731;padding:0;line-height:1;cursor:pointer;box-shadow:0 2px 6px rgba(60,56,42,0.2)}
      .p-ann-sticky .popover{position:absolute;left:24px;top:-8px;width:220px;min-height:120px;border:1px solid #d5c08b;border-radius:10px;background:#fff4ca;box-shadow:0 12px 28px rgba(48,44,31,0.22);padding:6px 8px 8px;display:none;flex-direction:column;gap:6px}
      .p-ann-sticky:hover .popover,.p-ann-sticky:focus-within .popover{display:flex}
      .p-ann-sticky-head{display:flex;align-items:center;justify-content:space-between;color:#6e6040;font-size:11px}
      .p-ann-sticky textarea{width:100%;min-height:84px;resize:vertical;border:none;background:transparent;outline:none;line-height:1.35;padding:0}
      .cap{background:#fff;border:1px solid #cbd7e4;border-radius:10px;padding:12px;line-height:1.52;font-size:16px;font-weight:400;max-height:34vh;overflow:auto}
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
      <body><div class=\"wrap\"><div class=\"img-wrap\"><div class=\"img-toolbar\"><div class=\"toolbar-group\"><button id=\"zoomOut\" class=\"icon-btn\" type=\"button\" title=\"Zoom out\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M5 12h14\"/></svg></button><button id=\"zoomReset\" class=\"icon-btn zoom-reset\" type=\"button\" title=\"Reset zoom\">100%</button><button id=\"zoomIn\" class=\"icon-btn\" type=\"button\" title=\"Zoom in\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M5 12h14M12 5v14\"/></svg></button><div class=\"zoom\" id=\"zoomText\">100%</div></div><div class=\"toolbar-group tool-group\" id=\"modeTools\"><button id=\"toolPointer\" class=\"tool active\" type=\"button\" title=\"Pointer mode\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M5 3l6 16 2-6 6-2z\"/></svg></button><button id=\"toolGrab\" class=\"tool\" type=\"button\" title=\"Grab mode\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M7 11V6a1 1 0 0 1 2 0v5M10 11V5a1 1 0 0 1 2 0v6M13 11V6a1 1 0 0 1 2 0v5M16 12V8a1 1 0 0 1 2 0v6a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6v-2a2 2 0 0 1 2-2z\"/></svg></button></div><div class=\"toolbar-group tool-group\" id=\"annotationTools\"><button id=\"toolHighlight\" class=\"tool\" type=\"button\" title=\"Highlight mode\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M3 17h10m4-10 4 4-7 7H10V14z\"/></svg></button><button id=\"toolText\" class=\"tool\" type=\"button\" title=\"Text note mode\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M5 5h14v10H9l-4 4zM8 9h8M8 12h6\"/></svg></button><button id=\"toolSticky\" class=\"tool\" type=\"button\" title=\"Sticky note mode\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M5 4h14v14l-4-3-4 3-4-3-2 2z\"/></svg></button></div><div class=\"swatches\" id=\"highlightColors\"><button class=\"swatch active\" data-color=\"#fce588\" type=\"button\" title=\"Yellow highlight\" style=\"background:#fce588\"></button><button class=\"swatch\" data-color=\"#b8f3b4\" type=\"button\" title=\"Green highlight\" style=\"background:#b8f3b4\"></button><button class=\"swatch\" data-color=\"#f9c5e5\" type=\"button\" title=\"Pink highlight\" style=\"background:#f9c5e5\"></button><button class=\"swatch\" data-color=\"#b9d9ff\" type=\"button\" title=\"Blue highlight\" style=\"background:#b9d9ff\"></button></div><div class=\"hint\" id=\"locHint\"></div></div><div class=\"img-stage\" id=\"imgStage\"><div class=\"canvas-wrap\" id=\"canvasWrap\"><img id=\"targetImage\" src=\"${payload.pageImageDataUrl ?? payload.imageDataUrl}\" alt=\"target\"/><div class=\"ann-layer\" id=\"annLayer\"></div><div class=\"ann-preview\" id=\"annPreview\"></div></div></div></div><div class=\"cap\"><div id=\"captionText\">${safeCaptionToHtml(
      payload.caption,
    )}</div><div class=\"cap-tools\"><button id=\"captionHighlight\" type=\"button\" title=\"Create linked highlight from selected caption text\">Highlight Selection</button><button id=\"captionClear\" type=\"button\" title=\"Remove all linked caption highlights for this figure\">Clear Caption Highlights</button><div class=\"cap-hint\" id=\"capHint\">Select text in caption, then click Highlight Selection.</div></div></div></div>
    <script>
      (() => {
        const meta = JSON.parse(decodeURIComponent('${popupMeta}'));
        const api = window.journalApi;
        const stage = document.getElementById('imgStage');
        const canvasWrap = document.getElementById('canvasWrap');
        const img = document.getElementById('targetImage');
        const annLayer = document.getElementById('annLayer');
        const annPreview = document.getElementById('annPreview');
        const zoomText = document.getElementById('zoomText');
        const zoomIn = document.getElementById('zoomIn');
        const zoomOut = document.getElementById('zoomOut');
        const zoomReset = document.getElementById('zoomReset');
        const locHint = document.getElementById('locHint');
        const toolPointer = document.getElementById('toolPointer');
        const toolGrab = document.getElementById('toolGrab');
        const toolHighlight = document.getElementById('toolHighlight');
        const toolText = document.getElementById('toolText');
        const toolSticky = document.getElementById('toolSticky');
        const swatchButtons = Array.from(document.querySelectorAll('#highlightColors .swatch'));
        const captionTextEl = document.getElementById('captionText');
        const captionHighlightBtn = document.getElementById('captionHighlight');
        const captionClearBtn = document.getElementById('captionClear');
        const capHint = document.getElementById('capHint');
        if (
          !stage ||
          !canvasWrap ||
          !img ||
          !annLayer ||
          !annPreview ||
          !zoomText ||
          !zoomIn ||
          !zoomOut ||
          !zoomReset ||
          !locHint ||
          !toolPointer ||
          !toolGrab ||
          !toolHighlight ||
          !toolText ||
          !toolSticky ||
          !captionTextEl ||
          !captionHighlightBtn ||
          !captionClearBtn ||
          !capHint
        ) return;

        let scale = 1;
        let initialScale = 1;
        let baseFitScale = 1;
        let baseDisplayWidth = 1;
        let baseDisplayHeight = 1;
        const minScale = 0.5;
        const maxScale = 3.2;
        let toolMode = 'pointer';
        let interactionMode = 'pointer';
        let highlightColor = '#fce588';
        const originalCaptionHtml = captionTextEl.innerHTML;
        let linkedSnippets = [];
        let articleSnippets = [];
        let lastSelectionSnippet = '';
        let panDragging = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let dragStartScrollLeft = 0;
        let dragStartScrollTop = 0;
        let noteDrag = null;
        let highlightDrag = null;
        let suppressClick = false;
        let pageAnnotations = [];
        let wheelThrottleRaf = null;
        let wheelPending = null;

        const hasAnnotationApi =
          Boolean(api) &&
          typeof api.annotationList === 'function' &&
          typeof api.annotationCreate === 'function' &&
          typeof api.annotationUpdate === 'function' &&
          typeof api.annotationDelete === 'function';
        const canEditPageAnnotations = Boolean(hasAnnotationApi && meta.docId && meta.pageRect);
        const pageRect = meta.pageRect || null;
        const focusRect = meta.focusRect || null;
        const canUseFocusRect = (() => {
          if (!meta.fullPageMode || !pageRect || !focusRect) {
            return false;
          }
          const pageW = Math.max(1, Number(pageRect.w) || 1);
          const pageH = Math.max(1, Number(pageRect.h) || 1);
          const fx = Number(focusRect.x);
          const fy = Number(focusRect.y);
          const fw = Math.max(1, Number(focusRect.w) || 1);
          const fh = Math.max(1, Number(focusRect.h) || 1);
          if (!Number.isFinite(fx) || !Number.isFinite(fy) || !Number.isFinite(fw) || !Number.isFinite(fh)) {
            return false;
          }
          const areaRatio = (fw * fh) / (pageW * pageH);
          const widthRatio = fw / pageW;
          const heightRatio = fh / pageH;
          if (areaRatio < 0.02 || areaRatio > 0.9) {
            return false;
          }
          if (widthRatio < 0.08 || heightRatio < 0.08) {
            return false;
          }
          return true;
        })();
        const minViewRectSize = 4;
        const NOTE_FONTS = [
          { label: 'SF Pro', value: '"SF Pro Text", -apple-system, BlinkMacSystemFont, sans-serif' },
          { label: 'Times', value: '"Times New Roman", Times, serif' },
          { label: 'Helvetica', value: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
          { label: 'Menlo', value: 'Menlo, Monaco, monospace' },
        ];
        const NOTE_FONT_SIZES = [16, 20, 24, 28, 32, 40];
        const normalizeNoteStyle = (annotation) => {
          const style = annotation.style || {};
          const fallbackColor = annotation.kind === 'text-note' ? '#db4638' : '#29384b';
          const fallbackSize = annotation.kind === 'text-note' ? 28 : 13;
          return {
            fontSize: Number.isFinite(style.fontSize) ? Math.max(10, Math.min(72, style.fontSize)) : fallbackSize,
            fontFamily: style.fontFamily || NOTE_FONTS[0].value,
            textColor: style.textColor || fallbackColor,
          };
        };

        const clampScale = (v) => Math.max(minScale, Math.min(maxScale, v));
        const clampScroll = (value, max) => Math.max(0, Math.min(max, value));
        const WHEEL_DELTA_CAP = 56;
        const getDisplaySize = () => ({
          w: Math.max(1, img.clientWidth || 1),
          h: Math.max(1, img.clientHeight || 1),
        });
        const clampPointToImage = (point) => {
          const size = getDisplaySize();
          return {
            x: Math.max(0, Math.min(size.w, point.x)),
            y: Math.max(0, Math.min(size.h, point.y)),
          };
        };
        const clientToViewPoint = (clientX, clientY) => {
          const rect = canvasWrap.getBoundingClientRect();
          return clampPointToImage({ x: clientX - rect.left, y: clientY - rect.top });
        };
        const normalizeViewRect = (a, b) => {
          const x = Math.min(a.x, b.x);
          const y = Math.min(a.y, b.y);
          const w = Math.max(1, Math.abs(a.x - b.x));
          const h = Math.max(1, Math.abs(a.y - b.y));
          return { x, y, w, h };
        };
        const pdfRectToViewRect = (rect) => {
          if (!pageRect) return null;
          const size = getDisplaySize();
          const pageW = Math.max(1, pageRect.w);
          const pageH = Math.max(1, pageRect.h);
          const leftRatio = (rect.x - pageRect.x) / pageW;
          const rightRatio = (rect.x + rect.w - pageRect.x) / pageW;
          const topRatio = (pageRect.y + pageRect.h - (rect.y + rect.h)) / pageH;
          const bottomRatio = (pageRect.y + pageRect.h - rect.y) / pageH;
          const x0 = Math.min(leftRatio, rightRatio) * size.w;
          const x1 = Math.max(leftRatio, rightRatio) * size.w;
          const y0 = Math.min(topRatio, bottomRatio) * size.h;
          const y1 = Math.max(topRatio, bottomRatio) * size.h;
          return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
        };
        const viewRectToPdfRect = (rect) => {
          if (!pageRect) return null;
          const size = getDisplaySize();
          const pageW = Math.max(1, pageRect.w);
          const pageH = Math.max(1, pageRect.h);
          const left = pageRect.x + (rect.x / size.w) * pageW;
          const right = pageRect.x + ((rect.x + rect.w) / size.w) * pageW;
          const top = pageRect.y + pageH * (1 - rect.y / size.h);
          const bottom = pageRect.y + pageH * (1 - (rect.y + rect.h) / size.h);
          const x = Math.min(left, right);
          const y = Math.min(bottom, top);
          const w = Math.max(1, Math.abs(right - left));
          const h = Math.max(1, Math.abs(top - bottom));
          return { x, y, w, h };
        };
        const viewPointToPdfPoint = (point) => {
          if (!pageRect) return null;
          const size = getDisplaySize();
          const pageW = Math.max(1, pageRect.w);
          const pageH = Math.max(1, pageRect.h);
          return {
            x: pageRect.x + (point.x / size.w) * pageW,
            y: pageRect.y + pageH * (1 - point.y / size.h),
          };
        };
        const syncHighlightSwatches = () => {
          for (const btn of swatchButtons) {
            const color = btn.dataset.color || '';
            btn.classList.toggle('active', color === highlightColor);
            btn.disabled = !canEditPageAnnotations;
          }
        };
        const setStatusHint = (text) => {
          if (text) {
            locHint.textContent = text;
            return;
          }
          if (!canEditPageAnnotations) {
            locHint.textContent = 'Preview mode: page annotations are unavailable in this popup.';
            return;
          }
          if (toolMode === 'highlight') {
            locHint.textContent = 'Highlight mode: drag to create highlight on figure page.';
            return;
          }
          if (toolMode === 'text-note') {
            locHint.textContent = 'Text note mode: click to place a text note.';
            return;
          }
          if (toolMode === 'sticky-note') {
            locHint.textContent = 'Sticky mode: click to place a sticky note.';
            return;
          }
          if (interactionMode === 'grab') {
            locHint.textContent = 'Grab mode: drag to pan the image.';
            return;
          }
          locHint.textContent = meta.fullPageMode
            ? 'Full-page preview.'
            : 'Pointer mode';
        };
        const applyToolUi = () => {
          toolPointer.classList.toggle('active', toolMode === 'pointer' && interactionMode === 'pointer');
          toolGrab.classList.toggle('active', toolMode === 'pointer' && interactionMode === 'grab');
          toolHighlight.classList.toggle('active', toolMode === 'highlight');
          toolText.classList.toggle('active', toolMode === 'text-note');
          toolSticky.classList.toggle('active', toolMode === 'sticky-note');
          toolPointer.disabled = !canEditPageAnnotations;
          toolGrab.disabled = !canEditPageAnnotations;
          toolHighlight.disabled = !canEditPageAnnotations;
          toolText.disabled = !canEditPageAnnotations;
          toolSticky.disabled = !canEditPageAnnotations;
          syncHighlightSwatches();
          setStatusHint('');
        };
        const setToolMode = (mode) => {
          if (!canEditPageAnnotations) return;
          if (mode !== 'pointer') {
            interactionMode = 'pointer';
          }
          toolMode = mode;
          applyToolUi();
          setStageCursor();
        };
        const setInteractionMode = (mode) => {
          if (!canEditPageAnnotations) return;
          interactionMode = mode === 'grab' ? 'grab' : 'pointer';
          toolMode = 'pointer';
          applyToolUi();
          setStageCursor();
        };
        const updatePreviewRect = () => {
          if (!highlightDrag) {
            annPreview.style.display = 'none';
            return;
          }
          const rect = normalizeViewRect(highlightDrag.start, highlightDrag.current);
          annPreview.style.display = rect.w >= 1 && rect.h >= 1 ? 'block' : 'none';
          annPreview.style.left = rect.x + 'px';
          annPreview.style.top = rect.y + 'px';
          annPreview.style.width = rect.w + 'px';
          annPreview.style.height = rect.h + 'px';
        };
        const upsertLocalAnnotation = (updated) => {
          const idx = pageAnnotations.findIndex((item) => item.id === updated.id);
          if (idx >= 0) {
            pageAnnotations[idx] = updated;
            return;
          }
          pageAnnotations.push(updated);
          pageAnnotations.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
        };
        const removeLocalAnnotation = (id) => {
          pageAnnotations = pageAnnotations.filter((item) => item.id !== id);
        };
        const commitAnnotationUpdate = async (id, patch) => {
          if (!hasAnnotationApi) return;
          const updated = await api.annotationUpdate({ id, ...patch });
          if (updated) {
            upsertLocalAnnotation(updated);
            renderPageAnnotations();
          }
        };
        const renderPageAnnotations = () => {
          while (annLayer.firstChild) {
            annLayer.removeChild(annLayer.firstChild);
          }
          if (!canEditPageAnnotations) {
            return;
          }
          for (const annotation of pageAnnotations) {
            if (annotation.kind === 'highlight') {
              for (let i = 0; i < (annotation.rects || []).length; i += 1) {
                const rect = annotation.rects[i];
                const viewRect = pdfRectToViewRect(rect);
                if (!viewRect) continue;
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'p-ann-hl p-ann-interactive';
                btn.dataset.annId = annotation.id;
                btn.style.left = viewRect.x + 'px';
                btn.style.top = viewRect.y + 'px';
                btn.style.width = viewRect.w + 'px';
                btn.style.height = viewRect.h + 'px';
                btn.style.background = annotation.color || '#fce588';
                btn.title = 'Click to delete highlight';
                btn.addEventListener('mousedown', (event) => {
                  event.stopPropagation();
                });
                btn.addEventListener('click', async (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!hasAnnotationApi) return;
                  const ok = window.confirm('Delete this highlight?');
                  if (!ok) return;
                  const deleted = await api.annotationDelete(annotation.id);
                  if (deleted) {
                    removeLocalAnnotation(annotation.id);
                    renderPageAnnotations();
                  }
                });
                annLayer.appendChild(btn);
              }
              continue;
            }

            const anchor = annotation.rects && annotation.rects[0];
            if (!anchor) continue;
            const viewRect = pdfRectToViewRect(anchor);
            if (!viewRect) continue;

            if (annotation.kind === 'text-note') {
              const styleState = normalizeNoteStyle(annotation);
              const wrap = document.createElement('div');
              wrap.className = 'p-ann-text p-ann-interactive';
              wrap.dataset.annId = annotation.id;
              wrap.style.left = viewRect.x + 'px';
              wrap.style.top = viewRect.y + 'px';
              wrap.style.width = Math.max(72, viewRect.w) + 'px';
              wrap.style.minHeight = Math.max(28, viewRect.h) + 'px';
              const toolbar = document.createElement('div');
              toolbar.className = 'p-ann-toolbar';

              const sizeSelect = document.createElement('select');
              sizeSelect.title = 'Font size';
              for (const size of NOTE_FONT_SIZES) {
                const option = document.createElement('option');
                option.value = String(size);
                option.textContent = size + 'px';
                if (size === styleState.fontSize) {
                  option.selected = true;
                }
                sizeSelect.appendChild(option);
              }

              const familySelect = document.createElement('select');
              familySelect.title = 'Font family';
              for (const font of NOTE_FONTS) {
                const option = document.createElement('option');
                option.value = font.value;
                option.textContent = font.label;
                if (font.value === styleState.fontFamily) {
                  option.selected = true;
                }
                familySelect.appendChild(option);
              }

              const colorInput = document.createElement('input');
              colorInput.type = 'color';
              colorInput.title = 'Text color';
              colorInput.value = styleState.textColor;

              const deleteBtn = document.createElement('button');
              deleteBtn.type = 'button';
              deleteBtn.className = 'p-ann-delete';
              deleteBtn.textContent = '×';
              deleteBtn.title = 'Delete text note';
              deleteBtn.addEventListener('click', async (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!hasAnnotationApi) return;
                const deleted = await api.annotationDelete(annotation.id);
                if (deleted) {
                  removeLocalAnnotation(annotation.id);
                  renderPageAnnotations();
                }
              });

              toolbar.appendChild(sizeSelect);
              toolbar.appendChild(familySelect);
              toolbar.appendChild(colorInput);
              toolbar.appendChild(deleteBtn);
              wrap.appendChild(toolbar);

              const textarea = document.createElement('textarea');
              textarea.className = 'p-ann-textarea';
              textarea.value = annotation.text || '';
              textarea.placeholder = 'Text';
              const applyTextStyle = () => {
                textarea.style.fontSize = styleState.fontSize + 'px';
                textarea.style.fontFamily = styleState.fontFamily;
                textarea.style.color = styleState.textColor;
              };
              applyTextStyle();
              const commitStyle = () => {
                void commitAnnotationUpdate(annotation.id, {
                  style: {
                    fontSize: styleState.fontSize,
                    fontFamily: styleState.fontFamily,
                    textColor: styleState.textColor,
                  },
                });
              };
              textarea.addEventListener('mousedown', (event) => {
                event.stopPropagation();
              });
              textarea.addEventListener('focus', () => {
                wrap.classList.add('focused');
              });
              textarea.addEventListener('blur', () => {
                queueMicrotask(() => {
                  if (!wrap.contains(document.activeElement)) {
                    wrap.classList.remove('focused');
                  }
                });
                const nextRect = viewRectToPdfRect({
                  x: parseFloat(wrap.style.left || '0'),
                  y: parseFloat(wrap.style.top || '0'),
                  w: Math.max(72, textarea.getBoundingClientRect().width),
                  h: Math.max(28, textarea.getBoundingClientRect().height),
                });
                const patch = { text: textarea.value };
                if (nextRect) {
                  patch.rects = [nextRect];
                }
                void commitAnnotationUpdate(annotation.id, patch);
              });
              wrap.appendChild(textarea);

              sizeSelect.addEventListener('mousedown', (event) => event.stopPropagation());
              familySelect.addEventListener('mousedown', (event) => event.stopPropagation());
              colorInput.addEventListener('mousedown', (event) => event.stopPropagation());
              deleteBtn.addEventListener('mousedown', (event) => event.stopPropagation());
              sizeSelect.addEventListener('focus', () => wrap.classList.add('focused'));
              familySelect.addEventListener('focus', () => wrap.classList.add('focused'));
              colorInput.addEventListener('focus', () => wrap.classList.add('focused'));
              sizeSelect.addEventListener('change', (event) => {
                const next = Number(event.target.value);
                if (!Number.isFinite(next)) return;
                styleState.fontSize = Math.max(10, Math.min(72, next));
                applyTextStyle();
                commitStyle();
              });
              familySelect.addEventListener('change', (event) => {
                styleState.fontFamily = event.target.value || NOTE_FONTS[0].value;
                applyTextStyle();
                commitStyle();
              });
              colorInput.addEventListener('input', (event) => {
                styleState.textColor = event.target.value || '#db4638';
                applyTextStyle();
                commitStyle();
              });

              wrap.addEventListener('mousedown', (event) => {
                event.stopPropagation();
                if (event.button !== 0 || toolMode !== 'pointer') return;
                const target = event.target instanceof HTMLElement ? event.target : null;
                if (target?.closest('textarea,button,input,select,option')) return;
                noteDrag = {
                  id: annotation.id,
                  startClientX: event.clientX,
                  startClientY: event.clientY,
                  startRects: annotation.rects.map((item) => ({ ...item })),
                };
                event.preventDefault();
              });

              annLayer.appendChild(wrap);
              continue;
            }

            const sticky = document.createElement('div');
            sticky.className = 'p-ann-sticky p-ann-interactive';
            sticky.dataset.annId = annotation.id;
            sticky.style.left = viewRect.x + 'px';
            sticky.style.top = viewRect.y + 'px';
            sticky.style.width = Math.max(18, viewRect.w) + 'px';
            sticky.style.height = Math.max(18, viewRect.h) + 'px';

            const icon = document.createElement('button');
            icon.type = 'button';
            icon.className = 'icon';
            icon.textContent = '🗒';
            icon.title = 'Sticky note';
            icon.addEventListener('mousedown', (event) => {
              event.stopPropagation();
            });
            sticky.appendChild(icon);

            const pop = document.createElement('div');
            pop.className = 'popover';
            const head = document.createElement('div');
            head.className = 'p-ann-sticky-head';
            const title = document.createElement('span');
            title.textContent = 'Sticky note';
            const actions = document.createElement('div');
            actions.className = 'p-ann-actions';
            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'p-ann-delete';
            deleteBtn.textContent = '×';
            deleteBtn.title = 'Delete sticky note';
            deleteBtn.addEventListener('click', async (event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!hasAnnotationApi) return;
              const deleted = await api.annotationDelete(annotation.id);
              if (deleted) {
                removeLocalAnnotation(annotation.id);
                renderPageAnnotations();
              }
            });
            actions.appendChild(deleteBtn);
            head.appendChild(title);
            head.appendChild(actions);
            pop.appendChild(head);

            const textarea = document.createElement('textarea');
            textarea.value = annotation.text || '';
            textarea.placeholder = 'Add note...';
            const style = normalizeNoteStyle(annotation);
            textarea.style.fontSize = style.fontSize + 'px';
            textarea.style.fontFamily = style.fontFamily;
            textarea.style.color = style.textColor;
            textarea.addEventListener('mousedown', (event) => {
              event.stopPropagation();
            });
            textarea.addEventListener('blur', () => {
              void commitAnnotationUpdate(annotation.id, { text: textarea.value });
            });
            pop.appendChild(textarea);
            sticky.appendChild(pop);

            sticky.addEventListener('mousedown', (event) => {
              event.stopPropagation();
              if (event.button !== 0 || toolMode !== 'pointer') return;
              const target = event.target instanceof HTMLElement ? event.target : null;
              if (target?.closest('textarea,button,input,select,option')) return;
              noteDrag = {
                id: annotation.id,
                startClientX: event.clientX,
                startClientY: event.clientY,
                startRects: annotation.rects.map((item) => ({ ...item })),
              };
              event.preventDefault();
            });

            annLayer.appendChild(sticky);
          }
        };
        const loadPageAnnotations = async () => {
          if (!canEditPageAnnotations) return;
          const list = await api.annotationList(meta.docId);
          pageAnnotations = (Array.isArray(list) ? list : []).filter((item) => item.page === meta.page);
          renderPageAnnotations();
        };
        const setStageCursor = () => {
          if (noteDrag) {
            stage.style.cursor = 'grabbing';
            return;
          }
          if (highlightDrag || toolMode === 'highlight') {
            stage.style.cursor = 'crosshair';
            return;
          }
          if (panDragging) {
            stage.style.cursor = 'grabbing';
            return;
          }
          if (toolMode === 'text-note' || toolMode === 'sticky-note') {
            stage.style.cursor = 'copy';
            return;
          }
          if (!canEditPageAnnotations) {
            stage.style.cursor = meta.fullPageMode || scale > 1.001 ? 'grab' : 'default';
            return;
          }
          stage.style.cursor = interactionMode === 'grab' ? 'grab' : 'default';
        };
        const computeBaseDisplaySize = () => {
          const naturalWidth = img.naturalWidth || 1;
          const naturalHeight = img.naturalHeight || 1;
          const stageWidth = Math.max(1, stage.clientWidth - 2);
          const stageHeight = Math.max(1, stage.clientHeight - 2);
          const fitByContain = Math.min(stageWidth / naturalWidth, stageHeight / naturalHeight);
          const fitByWidth = stageWidth / naturalWidth;
          const computedFit = meta.fullPageMode ? fitByWidth : fitByContain;
          baseFitScale = Number.isFinite(computedFit) && computedFit > 0 ? computedFit : 1;
          baseDisplayWidth = Math.max(1, Math.round(naturalWidth * baseFitScale));
          baseDisplayHeight = Math.max(1, Math.round(naturalHeight * baseFitScale));
        };

        const render = () => {
          const displayWidth = Math.max(1, Math.round(baseDisplayWidth * scale));
          const displayHeight = Math.max(1, Math.round(baseDisplayHeight * scale));
          img.style.width = displayWidth + 'px';
          img.style.height = displayHeight + 'px';
          canvasWrap.style.width = img.style.width;
          canvasWrap.style.height = img.style.height;
          const allowScroll = meta.fullPageMode || scale > 1.001;
          stage.style.overflow = allowScroll ? 'auto' : 'hidden';
          stage.style.overflowX = allowScroll ? 'auto' : 'hidden';
          stage.style.overflowY = allowScroll ? 'auto' : 'hidden';
          setStageCursor();
          const pct = Math.round(scale * 100);
          zoomText.textContent = pct + '%';
          zoomReset.textContent = pct + '%';
          setStatusHint('');
          renderPageAnnotations();
          updatePreviewRect();
        };

        const centerOnFocusRect = () => {
          if (!canUseFocusRect || !pageRect || !focusRect) {
            return;
          }
          const pageW = Math.max(1, pageRect.w);
          const pageH = Math.max(1, pageRect.h);
          const normX = (focusRect.x - pageRect.x) / pageW;
          const normW = focusRect.w / pageW;
          const normTop = (pageRect.y + pageRect.h - (focusRect.y + focusRect.h)) / pageH;
          const normH = focusRect.h / pageH;
          const displayW = img.clientWidth || 1;
          const displayH = img.clientHeight || 1;
          const focusX = normX * displayW;
          const focusY = normTop * displayH;
          const focusW = Math.max(1, normW * displayW);
          const focusH = Math.max(1, normH * displayH);
          const targetLeft = focusX + focusW * 0.5 - stage.clientWidth * 0.5;
          const targetTop = focusY + focusH * 0.5 - stage.clientHeight * 0.5;
          stage.scrollLeft = clampScroll(targetLeft, Math.max(0, displayW - stage.clientWidth));
          stage.scrollTop = clampScroll(targetTop, Math.max(0, displayH - stage.clientHeight));
        };

        const computeInitialScale = () => {
          if (!canUseFocusRect || !pageRect || !focusRect) {
            return 1;
          }
          const pageW = Math.max(1, pageRect.w);
          const pageH = Math.max(1, pageRect.h);
          const focusW = Math.max(0.02, focusRect.w / pageW);
          const focusH = Math.max(0.02, focusRect.h / pageH);
          const naturalWidth = img.naturalWidth || 1;
          const naturalHeight = img.naturalHeight || 1;
          const stageWidth = Math.max(1, stage.clientWidth - 2);
          const stageHeight = Math.max(1, stage.clientHeight - 2);
          const targetAbsolute = Math.min(
            stageWidth / Math.max(1, naturalWidth * focusW * 1.18),
            stageHeight / Math.max(1, naturalHeight * focusH * 1.18),
          );
          const safeFitScale = Math.max(0.0001, baseFitScale);
          const relative = targetAbsolute / safeFitScale;
          return clampScale(Math.max(0.95, Math.min(1.02, relative)));
        };

        const zoomAt = (nextScale, offsetX, offsetY, snapToFocus = false) => {
          const target = clampScale(nextScale);
          if (Math.abs(target - scale) < 0.0001) return;
          if (!Number.isFinite(target)) return;
          const safeOffsetX = Number.isFinite(offsetX) ? offsetX : stage.clientWidth * 0.5;
          const safeOffsetY = Number.isFinite(offsetY) ? offsetY : stage.clientHeight * 0.5;
          const beforeContentWidth = Math.max(
            stage.clientWidth,
            stage.scrollWidth,
            canvasWrap.clientWidth || 0,
            img.clientWidth || 0,
            1,
          );
          const beforeContentHeight = Math.max(
            stage.clientHeight,
            stage.scrollHeight,
            canvasWrap.clientHeight || 0,
            img.clientHeight || 0,
            1,
          );
          const anchorX = clampScroll((stage.scrollLeft + safeOffsetX) / beforeContentWidth, 1);
          const anchorY = clampScroll((stage.scrollTop + safeOffsetY) / beforeContentHeight, 1);
          scale = target;
          render();
          requestAnimationFrame(() => {
            if (snapToFocus && meta.fullPageMode && meta.focusRect) {
              centerOnFocusRect();
              return;
            }
            const afterContentWidth = Math.max(
              stage.clientWidth,
              stage.scrollWidth,
              canvasWrap.clientWidth || 0,
              img.clientWidth || 0,
              1,
            );
            const afterContentHeight = Math.max(
              stage.clientHeight,
              stage.scrollHeight,
              canvasWrap.clientHeight || 0,
              img.clientHeight || 0,
              1,
            );
            const nextScrollLeft = anchorX * afterContentWidth - safeOffsetX;
            const nextScrollTop = anchorY * afterContentHeight - safeOffsetY;
            const maxLeft = Math.max(0, stage.scrollWidth - stage.clientWidth);
            const maxTop = Math.max(0, stage.scrollHeight - stage.clientHeight);
            stage.scrollLeft = clampScroll(Number.isFinite(nextScrollLeft) ? nextScrollLeft : 0, maxLeft);
            stage.scrollTop = clampScroll(Number.isFinite(nextScrollTop) ? nextScrollTop : 0, maxTop);
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
            page: meta.captionPage || meta.page,
            captionRect: meta.captionRect,
            snippets: linkedSnippets,
          });
        };

        const loadLinkedAnnotation = async () => {
          if (!api || !meta.docId || !meta.captionRect) return;
          const result = await api.captionGetLinkedSnippets({
            docId: meta.docId,
            targetId: meta.targetId,
            page: meta.captionPage || meta.page,
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

        toolPointer.addEventListener('click', () => setInteractionMode('pointer'));
        toolGrab.addEventListener('click', () => setInteractionMode('grab'));
        toolHighlight.addEventListener('click', () => setToolMode('highlight'));
        toolText.addEventListener('click', () => setToolMode('text-note'));
        toolSticky.addEventListener('click', () => setToolMode('sticky-note'));
        for (const swatch of swatchButtons) {
          swatch.addEventListener('click', () => {
            if (!canEditPageAnnotations) return;
            const next = swatch.dataset.color || '';
            if (!next) return;
            highlightColor = next;
            syncHighlightSwatches();
          });
        }

        const onGlobalWheel = (event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          if (stage.contains(event.target)) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
        };
        const onGlobalGesture = (event) => {
          event.preventDefault();
        };
        document.addEventListener('wheel', onGlobalWheel, { passive: false, capture: true });
        window.addEventListener('gesturestart', onGlobalGesture, { passive: false });
        window.addEventListener('gesturechange', onGlobalGesture, { passive: false });
        window.addEventListener('gestureend', onGlobalGesture, { passive: false });

        stage.addEventListener('wheel', (event) => {
          if (!event.ctrlKey) {
            const maxLeft = Math.max(0, stage.scrollWidth - stage.clientWidth);
            const hasHorizontalOverflow = maxLeft > 0;
            const horizontalIntent = Math.abs(event.deltaX) > 0.01 || event.shiftKey;
            if (!hasHorizontalOverflow || !horizontalIntent) return;
            const rawDx = Math.abs(event.deltaX) > 0.01 ? event.deltaX : event.deltaY;
            const dx = Number.isFinite(rawDx) ? rawDx : 0;
            const nextLeft = clampScroll(stage.scrollLeft + dx, maxLeft);
            if (Math.abs(nextLeft - stage.scrollLeft) > 0.001) {
              stage.scrollLeft = nextLeft;
              event.preventDefault();
              event.stopPropagation();
            }
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (wheelPending) {
            wheelPending.deltaY += event.deltaY;
            wheelPending.clientX = event.clientX;
            wheelPending.clientY = event.clientY;
          } else {
            wheelPending = {
              deltaY: event.deltaY,
              clientX: event.clientX,
              clientY: event.clientY,
            };
          }
          if (wheelThrottleRaf !== null) {
            return;
          }
          wheelThrottleRaf = window.requestAnimationFrame(() => {
            wheelThrottleRaf = null;
            const pending = wheelPending;
            wheelPending = null;
            if (!pending) return;
            const currentScale = scale;
            const delta = Math.max(-WHEEL_DELTA_CAP, Math.min(WHEEL_DELTA_CAP, pending.deltaY));
            if (Math.abs(delta) < 0.001) return;
            if ((currentScale >= maxScale - 0.0001 && delta < 0) || (currentScale <= minScale + 0.0001 && delta > 0)) {
              return;
            }
            const gain = currentScale > 1 ? 0.00105 : 0.00122;
            const zoomFactor = Math.exp(-delta * gain);
            const nextScale = clampScale(currentScale * zoomFactor);
            if (Math.abs(nextScale - currentScale) < 0.0005) return;
            const rect = stage.getBoundingClientRect();
            const offsetX = pending.clientX - rect.left;
            const offsetY = pending.clientY - rect.top;
            zoomAt(nextScale, offsetX, offsetY);
          });
        }, { passive: false });

        zoomIn.addEventListener('click', () => {
          zoomAt(scale * 1.08, stage.clientWidth * 0.5, stage.clientHeight * 0.5, false);
        });
        zoomOut.addEventListener('click', () => {
          zoomAt(scale / 1.08, stage.clientWidth * 0.5, stage.clientHeight * 0.5, false);
        });
        zoomReset.addEventListener('click', () => {
          scale = initialScale;
          render();
          if (canUseFocusRect) {
            centerOnFocusRect();
          } else {
            stage.scrollLeft = 0;
            stage.scrollTop = 0;
          }
        });

        const onImageLoad = () => {
          computeBaseDisplaySize();
          scale = 1;
          initialScale = computeInitialScale();
          scale = initialScale;
          render();
          if (canUseFocusRect) {
            centerOnFocusRect();
          } else {
            stage.scrollLeft = 0;
            stage.scrollTop = 0;
          }
          void loadPageAnnotations();
        };
        img.addEventListener('load', onImageLoad);
        if (img.complete && (img.naturalWidth || 0) > 0) {
          onImageLoad();
        }

        const resizeObserver = new ResizeObserver(() => {
          if (scale > 1.001) {
            stage.scrollLeft = clampScroll(stage.scrollLeft, Math.max(0, stage.scrollWidth - stage.clientWidth));
            stage.scrollTop = clampScroll(stage.scrollTop, Math.max(0, stage.scrollHeight - stage.clientHeight));
            return;
          }
          const beforeWidth = Math.max(1, img.clientWidth || 1);
          const beforeHeight = Math.max(1, img.clientHeight || 1);
          const centerX = (stage.scrollLeft + stage.clientWidth * 0.5) / beforeWidth;
          const centerY = (stage.scrollTop + stage.clientHeight * 0.5) / beforeHeight;
          computeBaseDisplaySize();
          render();
          if (canUseFocusRect) {
            centerOnFocusRect();
            return;
          }
          const afterWidth = Math.max(1, img.clientWidth || 1);
          const afterHeight = Math.max(1, img.clientHeight || 1);
          const nextScrollLeft = centerX * afterWidth - stage.clientWidth * 0.5;
          const nextScrollTop = centerY * afterHeight - stage.clientHeight * 0.5;
          stage.scrollLeft = clampScroll(nextScrollLeft, Math.max(0, stage.scrollWidth - stage.clientWidth));
          stage.scrollTop = clampScroll(nextScrollTop, Math.max(0, stage.scrollHeight - stage.clientHeight));
        });
        resizeObserver.observe(stage);

        stage.addEventListener('mousedown', (event) => {
          if (event.button !== 0) return;
          const target = event.target instanceof HTMLElement ? event.target : null;
          if (target?.closest('.p-ann-interactive')) {
            return;
          }
          if (canEditPageAnnotations && toolMode === 'highlight') {
            const start = clientToViewPoint(event.clientX, event.clientY);
            highlightDrag = { start, current: start };
            updatePreviewRect();
            setStageCursor();
            event.preventDefault();
            return;
          }
          const canPanByMode = canEditPageAnnotations ? toolMode === 'pointer' && interactionMode === 'grab' : meta.fullPageMode || scale > 1.001;
          if (!canPanByMode) return;
          const maxLeft = Math.max(0, stage.scrollWidth - stage.clientWidth);
          const maxTop = Math.max(0, stage.scrollHeight - stage.clientHeight);
          if (maxLeft <= 0.5 && maxTop <= 0.5) return;
          panDragging = true;
          dragStartX = event.clientX;
          dragStartY = event.clientY;
          dragStartScrollLeft = stage.scrollLeft;
          dragStartScrollTop = stage.scrollTop;
          setStageCursor();
          event.preventDefault();
        });
        stage.addEventListener('click', async (event) => {
          if (suppressClick) {
            suppressClick = false;
            return;
          }
          if (!canEditPageAnnotations || (toolMode !== 'text-note' && toolMode !== 'sticky-note')) return;
          const target = event.target instanceof HTMLElement ? event.target : null;
          if (target?.closest('.p-ann-interactive')) return;
          const point = clientToViewPoint(event.clientX, event.clientY);
          const pdfPoint = viewPointToPdfPoint(point);
          if (!pdfPoint) return;
          if (toolMode === 'text-note') {
            await api.annotationCreate({
              docId: meta.docId,
              page: meta.page,
              kind: 'text-note',
              rects: [{ x: pdfPoint.x, y: pdfPoint.y, w: 180, h: 46 }],
              text: '',
              style: {
                fontSize: 28,
                fontFamily: '"SF Pro Text", -apple-system, BlinkMacSystemFont, sans-serif',
                textColor: '#db4638',
              },
            });
            setToolMode('pointer');
            return;
          }
          await api.annotationCreate({
            docId: meta.docId,
            page: meta.page,
            kind: 'sticky-note',
            rects: [{ x: pdfPoint.x, y: pdfPoint.y, w: 22, h: 22 }],
            text: '',
            style: {
              fontSize: 13,
              fontFamily: '"SF Pro Text", -apple-system, BlinkMacSystemFont, sans-serif',
              textColor: '#29384b',
            },
          });
          setToolMode('pointer');
        });

        const onWindowMouseMove = (event) => {
          if (noteDrag) {
            const dx = event.clientX - noteDrag.startClientX;
            const dy = event.clientY - noteDrag.startClientY;
            const targets = annLayer.querySelectorAll('[data-ann-id="' + noteDrag.id + '"]');
            for (const node of targets) {
              node.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
            }
            return;
          }
          if (highlightDrag) {
            highlightDrag.current = clientToViewPoint(event.clientX, event.clientY);
            updatePreviewRect();
            return;
          }
          if (!panDragging) return;
          const dx = event.clientX - dragStartX;
          const dy = event.clientY - dragStartY;
          stage.scrollLeft = clampScroll(dragStartScrollLeft - dx, Math.max(0, stage.scrollWidth - stage.clientWidth));
          stage.scrollTop = clampScroll(dragStartScrollTop - dy, Math.max(0, stage.scrollHeight - stage.clientHeight));
        };
        const onWindowMouseUp = async (event) => {
          if (noteDrag) {
            const moved = noteDrag;
            noteDrag = null;
            const dx = event.clientX - moved.startClientX;
            const dy = event.clientY - moved.startClientY;
            const targets = annLayer.querySelectorAll('[data-ann-id="' + moved.id + '"]');
            for (const node of targets) {
              node.style.transform = 'none';
            }
            if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
              const size = getDisplaySize();
              const dxPdf = (dx / size.w) * Math.max(1, pageRect?.w || 1);
              const dyPdf = -(dy / size.h) * Math.max(1, pageRect?.h || 1);
              const nextRects = moved.startRects.map((rect) => ({
                ...rect,
                x: rect.x + dxPdf,
                y: rect.y + dyPdf,
              }));
              await commitAnnotationUpdate(moved.id, { rects: nextRects });
            }
            setStageCursor();
            suppressClick = true;
            return;
          }
          if (highlightDrag) {
            const dragged = highlightDrag;
            highlightDrag = null;
            updatePreviewRect();
            const viewRect = normalizeViewRect(dragged.start, dragged.current);
            if (viewRect.w >= minViewRectSize && viewRect.h >= minViewRectSize) {
              const pdfRect = viewRectToPdfRect(viewRect);
              if (pdfRect && canEditPageAnnotations) {
                await api.annotationCreate({
                  docId: meta.docId,
                  page: meta.page,
                  kind: 'highlight',
                  rects: [pdfRect],
                  color: highlightColor,
                });
              }
            }
            suppressClick = true;
            setStageCursor();
            return;
          }
          if (!panDragging) return;
          panDragging = false;
          setStageCursor();
          suppressClick = true;
        };
        const onWindowMouseUpListener = (event) => {
          void onWindowMouseUp(event);
        };
        window.addEventListener('mousemove', onWindowMouseMove);
        window.addEventListener('mouseup', onWindowMouseUpListener);

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

        if (!canEditPageAnnotations) {
          setStatusHint('Preview mode: page annotations are unavailable in this popup.');
        }

        const unsubscribe = typeof api?.onAnnotationChanged === 'function'
          ? api.onAnnotationChanged((event) => {
              if (!meta.docId) return;
              if (event?.docId && event.docId !== meta.docId) return;
              void loadLinkedAnnotation();
              void loadPageAnnotations();
            })
          : null;
        window.addEventListener('beforeunload', () => {
          document.removeEventListener('selectionchange', onSelectionChange);
          document.removeEventListener('wheel', onGlobalWheel, true);
          resizeObserver.disconnect();
          window.removeEventListener('mousemove', onWindowMouseMove);
          window.removeEventListener('mouseup', onWindowMouseUpListener);
          window.removeEventListener('gesturestart', onGlobalGesture);
          window.removeEventListener('gesturechange', onGlobalGesture);
          window.removeEventListener('gestureend', onGlobalGesture);
          if (wheelThrottleRaf !== null) {
            window.cancelAnimationFrame(wheelThrottleRaf);
            wheelThrottleRaf = null;
          }
          if (typeof unsubscribe === 'function') {
            unsubscribe();
          }
        });

        computeBaseDisplaySize();
        applyToolUi();
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

  ipcMain.handle("reference.openPopup", async (_event, payload: { indices: number[]; entries: ReferenceEntry[] }) => {
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

    await loadPopupHtmlFile(popup, "references", html);
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
