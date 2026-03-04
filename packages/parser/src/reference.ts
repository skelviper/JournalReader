import { randomUUID } from "node:crypto";
import type { InTextReferenceMarker, ParsedTextSpan, Rect, ReferenceEntry } from "@journal-reader/types";

type LineToken = {
  span: ParsedTextSpan;
  start: number;
  end: number;
};

type LineEntry = {
  page: number;
  y: number;
  text: string;
  tokens: LineToken[];
  bbox: Rect;
};

type ReferenceParseResult = {
  markers: InTextReferenceMarker[];
  entries: ReferenceEntry[];
};

const BRACKET_MARKER_PATTERN = /\[(\s*\d{1,4}(?:\s*[-–]\s*\d{1,4})?(?:\s*,\s*\d{1,4}(?:\s*[-–]\s*\d{1,4})?)*)\]/g;
const BRACKET_ENTRY_PATTERN = /^\s*\[(\d{1,4})\]\s*(.*)$/;
const NUMBERED_ENTRY_PATTERN = /^\s*(\d{1,4})[.)]\s*(.*)$/;
const LOOSE_NUMBERED_ENTRY_PATTERN = /^\s*(\d{1,4})\s+(.+)$/;
const REFERENCES_HEADER_PATTERN = /^\s*(reference|references|bibliography|literature cited|works cited)\b/i;
const AUTHOR_YEAR_GROUP_PATTERN = /\(([^()]{4,260})\)/g;
const INLINE_AUTHOR_YEAR_PATTERN =
  /([A-Z][A-Za-z'’\-]{1,40}(?:\s+et\s+al\.)?|[A-Z][A-Za-z'’\-]{1,40}\s+(?:and|&)\s+[A-Z][A-Za-z'’\-]{1,40}),\s*((?:19|20)\d{2}[a-z]?(?:\s*,\s*(?:19|20)\d{2}[a-z]?)*)/g;

function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeEntryLeadNoise(text: string): string {
  let out = normalizeSpaces(text);
  out = out.replace(/^[•·\-–]+\s+/, "");
  const withLineNumber = out.match(/^\(?\d{3,6}\)?[.:]?\s+((?:\[\d{1,4}\]|\d{1,4}[.)])\s+.+)$/);
  if (withLineNumber?.[1]) {
    out = withLineNumber[1].trim();
  }
  return out;
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

function sliceRectHorizontally(rect: Rect, fromRatio: number, toRatio: number): Rect {
  const from = Math.max(0, Math.min(1, fromRatio));
  const to = Math.max(from, Math.min(1, toRatio));
  const x0 = rect.x + rect.w * from;
  const x1 = rect.x + rect.w * to;
  return {
    x: x0,
    y: rect.y,
    w: Math.max(1, x1 - x0),
    h: rect.h,
  };
}

function splitPageColumns(pageSpans: ParsedTextSpan[]): ParsedTextSpan[][] {
  if (pageSpans.length < 40) {
    return [pageSpans];
  }

  const centers = pageSpans.map((span) => span.bbox.x + span.bbox.w / 2);
  let c1 = Math.min(...centers);
  let c2 = Math.max(...centers);
  if (!Number.isFinite(c1) || !Number.isFinite(c2) || Math.abs(c2 - c1) < 140) {
    return [pageSpans];
  }

  const assignment = new Array<number>(pageSpans.length).fill(0);
  for (let iter = 0; iter < 8; iter += 1) {
    let sum1 = 0;
    let sum2 = 0;
    let count1 = 0;
    let count2 = 0;

    for (let i = 0; i < centers.length; i += 1) {
      const value = centers[i] ?? 0;
      if (Math.abs(value - c1) <= Math.abs(value - c2)) {
        assignment[i] = 0;
        sum1 += value;
        count1 += 1;
      } else {
        assignment[i] = 1;
        sum2 += value;
        count2 += 1;
      }
    }

    if (count1 === 0 || count2 === 0) {
      return [pageSpans];
    }

    const next1 = sum1 / count1;
    const next2 = sum2 / count2;
    const stable = Math.abs(next1 - c1) < 1 && Math.abs(next2 - c2) < 1;
    c1 = next1;
    c2 = next2;
    if (stable) {
      break;
    }
  }

  const group1: ParsedTextSpan[] = [];
  const group2: ParsedTextSpan[] = [];
  for (let i = 0; i < pageSpans.length; i += 1) {
    if ((assignment[i] ?? 0) === 0) {
      group1.push(pageSpans[i] as ParsedTextSpan);
    } else {
      group2.push(pageSpans[i] as ParsedTextSpan);
    }
  }

  const total = pageSpans.length;
  const minCluster = Math.max(12, Math.floor(total * 0.12));
  if (group1.length < minCluster || group2.length < minCluster) {
    return [pageSpans];
  }

  if (Math.abs(c1 - c2) < 160) {
    return [pageSpans];
  }

  return c1 <= c2 ? [group1, group2] : [group2, group1];
}

function buildLines(spans: ParsedTextSpan[]): LineEntry[] {
  const byPage = new Map<number, ParsedTextSpan[]>();
  for (const span of spans) {
    const list = byPage.get(span.page) ?? [];
    list.push(span);
    byPage.set(span.page, list);
  }

  const lines: LineEntry[] = [];
  const yThreshold = 8;

  for (const [page, pageSpans] of byPage.entries()) {
    const columns = splitPageColumns(pageSpans);
    for (const columnSpans of columns) {
      const sorted = [...columnSpans].sort((a, b) => {
        if (Math.abs(a.bbox.y - b.bbox.y) > yThreshold) {
          return b.bbox.y - a.bbox.y;
        }
        return a.bbox.x - b.bbox.x;
      });

      const rawLines: Array<{ y: number; spans: ParsedTextSpan[] }> = [];
      for (const span of sorted) {
        const line = rawLines.find((item) => Math.abs(item.y - span.bbox.y) <= yThreshold);
        if (!line) {
          rawLines.push({ y: span.bbox.y, spans: [span] });
          continue;
        }
        line.spans.push(span);
        line.y = (line.y + span.bbox.y) / 2;
      }

      const pageLines = rawLines
        .flatMap((line) => {
          const lineSpans = [...line.spans].sort((a, b) => a.bbox.x - b.bbox.x);
          const segments: ParsedTextSpan[][] = [];
          let current: ParsedTextSpan[] = [];

          for (const span of lineSpans) {
            const prev = current[current.length - 1];
            if (!prev) {
              current.push(span);
              continue;
            }

            const gap = span.bbox.x - (prev.bbox.x + prev.bbox.w);
            if (gap > 90) {
              segments.push(current);
              current = [span];
              continue;
            }
            current.push(span);
          }
          if (current.length > 0) {
            segments.push(current);
          }

          return segments.map((segment) => {
            let text = "";
            const tokens: LineToken[] = [];
            for (const span of segment) {
              if (text.length > 0) {
                text += " ";
              }
              const start = text.length;
              text += span.text;
              const end = text.length;
              tokens.push({ span, start, end });
            }

            return {
              page,
              y: line.y,
              text,
              tokens,
              bbox: unionRects(segment.map((span) => span.bbox)),
            };
          });
        })
        .sort((a, b) => b.y - a.y);

      lines.push(...pageLines);
    }
  }

  return lines.sort((a, b) => {
    if (a.page !== b.page) {
      return a.page - b.page;
    }
    return b.y - a.y;
  });
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

    const delta = Math.abs(end - start);
    if (delta > 40) {
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

function parseSuperscriptCandidate(rawText: string): { cleaned: string; indices: number[] } | null {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return null;
  }

  const direct = parseIndexList(trimmed);
  if (direct) {
    return { cleaned: trimmed, indices: direct };
  }

  const stripped = trimmed.replace(/^[([{\u207D]+/, "").replace(/[)\].,;:\u207E]+$/, "").trim();
  const fromStripped = parseIndexList(stripped);
  if (fromStripped) {
    return { cleaned: stripped, indices: fromStripped };
  }

  return null;
}

function matchRectFromTokens(tokens: LineToken[], start: number, end: number): Rect | null {
  const partials: Rect[] = [];
  for (const token of tokens) {
    const overlapStart = Math.max(start, token.start);
    const overlapEnd = Math.min(end, token.end);
    if (overlapEnd <= overlapStart) {
      continue;
    }
    const tokenLength = Math.max(1, token.end - token.start);
    const from = (overlapStart - token.start) / tokenLength;
    const to = (overlapEnd - token.start) / tokenLength;
    partials.push(sliceRectHorizontally(token.span.bbox, from, to));
  }
  if (partials.length > 0) {
    return unionRects(partials);
  }
  return null;
}

function hasDenseReferenceStartsAround(lines: LineEntry[], anchorIndex: number): boolean {
  if (anchorIndex < 0 || anchorIndex >= lines.length) {
    return false;
  }
  const anchorPage = lines[anchorIndex]?.page ?? -1;
  if (anchorPage < 0) {
    return false;
  }
  const probe = lines.filter((line) => line.page >= anchorPage && line.page <= anchorPage + 2);
  const starts = probe.flatMap((line) => parseEntryStartsInLine(line.text).map((entry) => entry.index));
  if (starts.length < 2) {
    return false;
  }
  const unique = [...new Set(starts)];
  const maxIndex = unique.length > 0 ? Math.max(...unique) : 0;
  return unique.length >= 2 && maxIndex >= 2;
}

function findReferencesStarts(lines: LineEntry[]): number[] {
  const starts = new Set<number>();
  const explicitHeaders = lines
    .map((line, idx) => ({ line, idx }))
    .filter((item) => REFERENCES_HEADER_PATTERN.test(normalizeEntryLeadNoise(item.line.text)))
    .map((item) => item.idx);
  for (const idx of explicitHeaders) {
    if (hasDenseReferenceStartsAround(lines, idx)) {
      starts.add(Math.max(0, idx));
    }
  }
  const guessed = guessReferencesStartsByCandidates(lines);
  for (const idx of guessed) {
    starts.add(Math.max(0, idx));
  }
  return [...starts].sort((a, b) => a - b);
}

function parseEntryStart(text: string): { index: number; body: string } | null {
  const normalizedText = normalizeEntryLeadNoise(text);
  const bracket = normalizedText.match(BRACKET_ENTRY_PATTERN);
  if (bracket) {
    return {
      index: Number(bracket[1]),
      body: normalizeSpaces(bracket[2] ?? ""),
    };
  }

  const numbered = normalizedText.match(NUMBERED_ENTRY_PATTERN);
  if (numbered) {
    return {
      index: Number(numbered[1]),
      body: normalizeSpaces(numbered[2] ?? ""),
    };
  }

  const looseNumbered = normalizedText.match(LOOSE_NUMBERED_ENTRY_PATTERN);
  if (looseNumbered) {
    const index = Number(looseNumbered[1]);
    const body = normalizeSpaces(looseNumbered[2] ?? "");
    if (index >= 1 && index <= 999 && isLikelyLooseReferenceBody(body)) {
      return { index, body };
    }
  }

  return null;
}

function isLikelyLooseReferenceBody(body: string): boolean {
  const text = normalizeSpaces(body);
  if (text.length < 12) {
    return false;
  }
  if (!/[A-Za-z]/.test(text)) {
    return false;
  }

  const hasYear = /(?:19|20)\d{2}[a-z]?/.test(text);
  const hasEtAl = /\bet\s+al\.?/i.test(text);
  const hasDoi = /\bdoi[:\s]/i.test(text) || /https?:\/\/doi\.org\//i.test(text);
  const hasAuthorLead = /^[A-Z][A-Za-z'’\-]{1,40}(?:,\s*[A-Z][A-Za-z.\-\s]{0,20})?/.test(text);
  const hasJournalCue = /\b(?:Nature|Science|Cell|Genome|Nucleic|Proceedings|PNAS|Methods|Bioinformatics)\b/i.test(text);
  const hasVolumePages = /\b\d{1,4}\s*[:(]\s*\d{1,5}(?:\s*[-–]\s*\d{1,5})?/.test(text);

  return (
    (hasAuthorLead && (hasYear || hasEtAl || hasDoi || hasJournalCue || hasVolumePages)) ||
    (hasYear && (hasEtAl || hasDoi || hasJournalCue || hasVolumePages))
  );
}

function isNearLineStart(text: string, start: number): boolean {
  if (start < 0 || start > 24) {
    return false;
  }
  const prefix = text.slice(0, start).trim();
  if (!prefix) {
    return true;
  }
  const words = prefix.split(/\s+/).filter(Boolean);
  return words.length <= 2;
}

function parseEntryStartsInLine(text: string): Array<{ index: number; body: string }> {
  const normalized = normalizeEntryLeadNoise(text);
  const out: Array<{ index: number; body: string }> = [];
  const dotMatches = [...normalized.matchAll(/(\d{1,4})\.\s+/g)];
  const firstStart = dotMatches[0]?.index ?? -1;
  const nearStart = isNearLineStart(normalized, firstStart);

  if (nearStart && dotMatches.length > 1) {
    for (let i = 0; i < dotMatches.length; i += 1) {
      const current = dotMatches[i];
      const next = dotMatches[i + 1];
      const start = current?.index ?? -1;
      if (start < 0) {
        continue;
      }
      const end = next?.index ?? normalized.length;
      const segment = normalized.slice(start, end).trim();
      const parsed = parseEntryStart(segment);
      if (parsed) {
        out.push(parsed);
      }
    }
    if (out.length > 1) {
      return out;
    }
    out.length = 0;
  }

  const single = parseEntryStart(normalized);
  if (single) {
    return [single];
  }

  if (nearStart && firstStart > 0) {
    const sliced = parseEntryStart(normalized.slice(firstStart).trim());
    if (sliced) {
      return [sliced];
    }
  }

  // Some two-column layouts get flattened into one line such as
  // "... 61. Jung, I. ...". Detect embedded reference-like starts.
  const embeddedPattern = /(?:^|\s)(\d{1,4})\.\s+([A-Z][A-Za-z'’\-]{1,40}(?:,|\s+(?:and|&)\s+[A-Z]))/g;
  for (const match of normalized.matchAll(embeddedPattern)) {
    const indexStart = match.index ?? -1;
    if (indexStart < 0) {
      continue;
    }
    const rawNumber = match[1];
    if (!rawNumber) {
      continue;
    }
    const leadingOffset = match[0].indexOf(rawNumber);
    if (leadingOffset < 0) {
      continue;
    }
    const start = indexStart + leadingOffset;
    const segment = normalized.slice(start).trim();
    const parsed = parseEntryStart(segment);
    if (!parsed) {
      continue;
    }
    if (parsed.index < 1 || parsed.index > 999) {
      continue;
    }
    if (parsed.body.length < 12) {
      continue;
    }
    out.push(parsed);
  }
  if (out.length > 0) {
    const uniq = new Map<number, { index: number; body: string }>();
    for (const item of out) {
      if (!uniq.has(item.index)) {
        uniq.set(item.index, item);
      }
    }
    return [...uniq.values()];
  }

  return [];
}

function parseIsolatedReferenceIndexToken(text: string): number | null {
  const normalized = normalizeSpaces(text).replace(/[，,;:]+$/, "");
  const bracket = normalized.match(/^\[(\d{1,4})\]$/);
  if (bracket?.[1]) {
    const value = Number(bracket[1]);
    if (Number.isFinite(value) && value >= 1 && value <= 500) {
      return value;
    }
    return null;
  }
  const plain = normalized.match(/^(\d{1,4})[.)]$/);
  if (plain?.[1]) {
    const value = Number(plain[1]);
    if (Number.isFinite(value) && value >= 1 && value <= 500) {
      return value;
    }
  }
  return null;
}

function isLikelyReferenceLeadText(text: string): boolean {
  const normalized = normalizeEntryLeadNoise(text);
  if (normalized.length < 12) {
    return false;
  }
  if (isPlausibleReferenceSeed(normalized)) {
    return true;
  }
  if (/^[A-Z][A-Za-z'’\-]{1,40},\s*[A-Z]/.test(normalized)) {
    return true;
  }
  if (/^[A-Z][A-Za-z'’\-]{1,40}\s+(?:and|&)\s+[A-Z][A-Za-z'’\-]{1,40}/.test(normalized)) {
    return true;
  }
  return false;
}

function extractNumberedEntriesFromSpans(spans: ParsedTextSpan[], docId: string): ReferenceEntry[] {
  if (spans.length === 0) {
    return [];
  }

  const byPage = new Map<number, ParsedTextSpan[]>();
  for (const span of spans) {
    const list = byPage.get(span.page) ?? [];
    list.push(span);
    byPage.set(span.page, list);
  }

  const extracted: ReferenceEntry[] = [];

  for (const [page, pageSpans] of byPage.entries()) {
    if (pageSpans.length < 12) {
      continue;
    }

    const candidates: Array<{ index: number; x: number; y: number; body: string }> = [];
    for (const marker of pageSpans) {
      const index = parseIsolatedReferenceIndexToken(marker.text);
      if (!index) {
        continue;
      }
      const markerRight = marker.bbox.x + marker.bbox.w;
      const markerMidY = marker.bbox.y + marker.bbox.h / 2;
      const maxDy = Math.max(2.8, Math.min(8, marker.bbox.h * 1.25 + 1.5));

      let bestBody = "";
      let bestScore = Number.POSITIVE_INFINITY;
      for (const bodySpan of pageSpans) {
        if (bodySpan === marker) {
          continue;
        }
        if (bodySpan.bbox.x <= markerRight + 0.8) {
          continue;
        }
        const dx = bodySpan.bbox.x - markerRight;
        if (dx > 96) {
          continue;
        }
        const bodyMidY = bodySpan.bbox.y + bodySpan.bbox.h / 2;
        const dy = Math.abs(bodyMidY - markerMidY);
        if (dy > maxDy) {
          continue;
        }
        const bodyText = normalizeEntryLeadNoise(bodySpan.text);
        if (!isLikelyReferenceLeadText(bodyText)) {
          continue;
        }
        const score = dx + dy * 8;
        if (score < bestScore) {
          bestScore = score;
          bestBody = bodyText;
        }
      }

      if (!bestBody) {
        continue;
      }
      candidates.push({
        index,
        x: marker.bbox.x,
        y: marker.bbox.y,
        body: bestBody,
      });
    }

    if (candidates.length < 4) {
      continue;
    }

    const byBucket = new Map<number, Array<{ index: number; x: number; y: number; body: string }>>();
    for (const item of candidates) {
      const bucket = Math.round(item.x / 24);
      const list = byBucket.get(bucket) ?? [];
      list.push(item);
      byBucket.set(bucket, list);
    }
    const bucketEntries = [...byBucket.entries()].sort((a, b) => b[1].length - a[1].length);
    const topCount = bucketEntries[0]?.[1].length ?? 0;

    const accepted: Array<{ index: number; x: number; y: number; body: string }> = [];
    for (const [bucket, items] of bucketEntries.slice(0, 3)) {
      if (items.length < 4) {
        continue;
      }
      if (items.length < Math.max(4, Math.floor(topCount * 0.45))) {
        continue;
      }

      const centerX = bucket * 24;
      const clustered = candidates.filter((item) => Math.abs(item.x - centerX) <= 14);
      if (clustered.length < 4) {
        continue;
      }

      const ordered = [...clustered].sort((a, b) => b.y - a.y);
      let increasing = 0;
      for (let i = 0; i < ordered.length - 1; i += 1) {
        const current = ordered[i];
        const next = ordered[i + 1];
        if ((current?.index ?? 0) < (next?.index ?? 0)) {
          increasing += 1;
        }
      }
      const monotonicScore = ordered.length > 1 ? increasing / (ordered.length - 1) : 1;
      if (monotonicScore < 0.55 && clustered.length < 10) {
        continue;
      }

      accepted.push(...clustered);
    }

    if (accepted.length === 0) {
      const dominant = bucketEntries[0]?.[1] ?? [];
      if (dominant.length >= 8) {
        accepted.push(...dominant);
      }
    }

    if (accepted.length === 0) {
      continue;
    }

    for (const item of accepted) {
      extracted.push({
        docId,
        index: item.index,
        text: item.body,
        page,
      });
    }
  }

  return dedupeReferenceEntries(extracted);
}

function densePrefixLength(indices: number[]): number {
  if (indices.length === 0) {
    return 0;
  }
  const uniqSorted = [...new Set(indices)].sort((a, b) => a - b);
  let prefix = 0;
  for (const idx of uniqSorted) {
    if (idx === prefix + 1) {
      prefix = idx;
      continue;
    }
    if (idx > prefix + 1) {
      break;
    }
  }
  return prefix;
}

function guessReferencesStartsByCandidates(lines: LineEntry[]): number[] {
  if (lines.length === 0) {
    return [];
  }

  const candidates = lines
    .map((line, idx) => ({ idx, line, starts: parseEntryStartsInLine(line.text) }))
    .filter((item) => item.starts.length > 0);

  if (candidates.length === 0) {
    return [];
  }

  const pages = [...new Set(candidates.map((item) => item.line.page))].sort((a, b) => a - b);
  const densePages = pages.filter((page) => {
    const windowItems = candidates.filter((item) => item.line.page >= page && item.line.page <= page + 1);
    const count = windowItems.reduce((acc, item) => acc + item.starts.length, 0);
    const indices = windowItems.flatMap((item) => item.starts.map((entry) => entry.index));
    const uniqueCount = new Set(indices).size;
    const maxIndex = indices.length > 0 ? Math.max(...indices) : 0;
    return count >= 6 && uniqueCount >= 4 && maxIndex >= 6;
  });

  const starts = new Set<number>();
  if (densePages.length > 0) {
    const clusters: number[][] = [];
    for (const page of densePages) {
      const current = clusters[clusters.length - 1];
      if (!current) {
        clusters.push([page]);
        continue;
      }
      const prevPage = current[current.length - 1] ?? page;
      if (page - prevPage <= 3) {
        current.push(page);
        continue;
      }
      clusters.push([page]);
    }
    for (const cluster of clusters) {
      const firstPage = cluster[0];
      if (firstPage === undefined) {
        continue;
      }
      const firstOnPage = candidates.filter((item) => item.line.page === firstPage).sort((a, b) => a.idx - b.idx)[0];
      if (firstOnPage) {
        starts.add(Math.max(0, firstOnPage.idx - 1));
      }
    }
  }

  const startAtOne = candidates.find((item) => item.starts.some((entry) => entry.index === 1));
  if (startAtOne) {
    starts.add(Math.max(0, startAtOne.idx - 1));
  }
  if (starts.size === 0 && candidates[0]) {
    starts.add(Math.max(0, (candidates[0]?.idx ?? 0) - 1));
  }

  return [...starts].sort((a, b) => a - b);
}

function isLikelyEntryContinuation(text: string): boolean {
  const normalized = normalizeEntryLeadNoise(text);
  if (!normalized.trim()) {
    return false;
  }
  if (REFERENCES_HEADER_PATTERN.test(normalized)) {
    return false;
  }
  if (/^(acknowledg|author contributions|data availability|code availability)\b/i.test(normalized)) {
    return false;
  }
  if (/^(reporting summary|editorial polic(y|ies)|statistics for|nature portfolio|checklist)\b/i.test(normalized)) {
    return false;
  }
  return true;
}

type ReferenceColumnBand = {
  xMin: number;
  xMax: number;
  center: number;
  count: number;
};

function isPlausibleReferenceSeed(body: string): boolean {
  const text = normalizeSpaces(body);
  if (text.length < 8 || !/[A-Za-z]/.test(text)) {
    return false;
  }
  if (/^(times|and|for|the|of|to|in|with|this|that|were|was|is|are)\b/i.test(text)) {
    return false;
  }
  if (/^(reporting summary|editorial polic(y|ies)|statistics for|nature portfolio|checklist)\b/i.test(text)) {
    return false;
  }

  const hasYear = /(?:19|20)\d{2}[a-z]?/.test(text);
  const hasEtAl = /\bet\s+al\.?/i.test(text);
  const hasDoi = /\bdoi[:\s]/i.test(text) || /https?:\/\/doi\.org\//i.test(text);
  const hasInitialLead = /^[A-Z]\.\s*[A-Z][A-Za-z'’\-]{1,40},?/.test(text);
  const startsWithParticle = /^(?:de|van|von|da|di|del|la|le|du)\s+[A-Z][A-Za-z'’\-]{1,40}\b/.test(text);
  const hasAuthorLead =
    /^[A-Z][A-Za-z'’\-]{1,40}(?:,\s*[A-Z][A-Za-z.\-\s]{0,20})?/.test(text) ||
    /^[A-Z][A-Za-z'’\-]{1,40}\s+(?:and|&)\s+[A-Z][A-Za-z'’\-]{1,40}/.test(text) ||
    startsWithParticle;
  const hasJournalCue = /\b(?:Nature|Science|Cell|Genome|Nucleic|Proceedings|PNAS|Methods|Bioinformatics)\b/i.test(text);
  const hasVolumePages = /\b\d{1,4}\s*[:(]\s*\d{1,5}(?:\s*[-–]\s*\d{1,5})?/.test(text);

  let score = 0;
  if (hasAuthorLead) score += 2;
  if (hasInitialLead) score += 2;
  if (hasYear) score += 2;
  if (hasEtAl) score += 2;
  if (hasDoi) score += 2;
  if (hasJournalCue) score += 1;
  if (hasVolumePages) score += 1;

  if (/^[a-z]/.test(text) && !startsWithParticle && score < 2) {
    return false;
  }
  return score >= 2;
}

function clusterReferenceBands(lines: LineEntry[]): ReferenceColumnBand[] {
  if (lines.length === 0) {
    return [];
  }
  const sorted = [...lines].sort((a, b) => (a.bbox.x + a.bbox.w / 2) - (b.bbox.x + b.bbox.w / 2));
  const clusters: Array<{ members: LineEntry[]; center: number }> = [];
  const threshold = 180;
  for (const line of sorted) {
    const center = line.bbox.x + line.bbox.w / 2;
    const nearest = clusters
      .map((cluster, idx) => ({ idx, delta: Math.abs(cluster.center - center) }))
      .sort((a, b) => a.delta - b.delta)[0];
    if (!nearest || nearest.delta > threshold) {
      clusters.push({ members: [line], center });
      continue;
    }
    const target = clusters[nearest.idx];
    if (!target) {
      continue;
    }
    target.members.push(line);
    target.center = target.members.reduce((sum, member) => sum + member.bbox.x + member.bbox.w / 2, 0) / target.members.length;
  }

  const bands = clusters
    .map((cluster) => {
      const xMin = Math.min(...cluster.members.map((line) => line.bbox.x)) - 38;
      const xMax = Math.max(...cluster.members.map((line) => line.bbox.x + line.bbox.w)) + 38;
      return {
        xMin,
        xMax,
        center: cluster.center,
        count: cluster.members.length,
      };
    })
    .sort((a, b) => {
      if (a.count !== b.count) {
        return b.count - a.count;
      }
      return a.center - b.center;
    });

  if (bands.length <= 1) {
    return bands;
  }
  const totalCount = bands.reduce((sum, band) => sum + band.count, 0);
  if (totalCount <= 14) {
    return bands.slice(0, 2).sort((a, b) => a.center - b.center);
  }

  const first = bands[0];
  const second = bands[1];
  if (!first || !second) {
    return bands.slice(0, 1);
  }
  if (second.count < Math.max(2, Math.floor(first.count * 0.22))) {
    return [first];
  }
  return [first, second].sort((a, b) => a.center - b.center);
}

function buildReferenceBandsByPage(lines: LineEntry[]): Map<number, ReferenceColumnBand[]> {
  const byPage = new Map<number, LineEntry[]>();
  for (const line of lines) {
    const list = byPage.get(line.page) ?? [];
    list.push(line);
    byPage.set(line.page, list);
  }
  const out = new Map<number, ReferenceColumnBand[]>();
  for (const [page, pageLines] of byPage.entries()) {
    const bands = clusterReferenceBands(pageLines);
    if (bands.length > 0) {
      out.set(page, bands);
    }
  }
  return out;
}

function lineCenterX(line: LineEntry): number {
  return line.bbox.x + line.bbox.w / 2;
}

function lineInBands(line: LineEntry, bands: ReferenceColumnBand[]): boolean {
  if (bands.length === 0) {
    return true;
  }
  const cx = lineCenterX(line);
  return bands.some((band) => cx >= band.xMin && cx <= band.xMax);
}

function resolveBandsForPage(page: number, bandsByPage: Map<number, ReferenceColumnBand[]>): ReferenceColumnBand[] {
  const direct = bandsByPage.get(page);
  if (direct && direct.length > 0) {
    return direct;
  }
  const prev = bandsByPage.get(page - 1);
  if (prev && prev.length > 0) {
    return prev;
  }
  const next = bandsByPage.get(page + 1);
  if (next && next.length > 0) {
    return next;
  }
  return [];
}

function extractReferenceEntries(lines: LineEntry[], docId: string, startIndex: number): ReferenceEntry[] {
  const entries: ReferenceEntry[] = [];
  if (startIndex < 0 || startIndex >= lines.length) {
    return entries;
  }

  const scoped = lines.slice(startIndex + 1);
  const startCandidates = scoped
    .map((line) => ({ line, starts: parseEntryStartsInLine(line.text) }))
    .filter((item) => item.starts.length > 0);
  const plausibleStartLines = startCandidates
    .filter((item) => item.starts.some((entry) => isPlausibleReferenceSeed(entry.body)))
    .map((item) => item.line);
  const allowWeakStarts = plausibleStartLines.length < 2;
  const seedLines = plausibleStartLines.length >= 2 ? plausibleStartLines : startCandidates.map((item) => item.line);
  const seedPages = [...new Set(seedLines.map((line) => line.page))].sort((a, b) => a - b);
  const firstSeedPage = seedPages[0] ?? -1;
  const lastSeedPage = seedPages[seedPages.length - 1] ?? -1;
  const bandsByPage = buildReferenceBandsByPage(seedLines);
  let lastAcceptedIndex = 0;

  for (let i = 0; i < scoped.length; i += 1) {
    const line = scoped[i];
    if (!line) {
      continue;
    }

    if (firstSeedPage > 0 && line.page < firstSeedPage) {
      continue;
    }
    if (lastSeedPage > 0 && line.page > lastSeedPage + 2) {
      break;
    }

    const starts = parseEntryStartsInLine(line.text);
    if (starts.length === 0) {
      continue;
    }
    const lineBands = resolveBandsForPage(line.page, bandsByPage);
    if (lineBands.length > 0 && !lineInBands(line, lineBands)) {
      const detachedNumericOnly = starts.length === 1 && normalizeSpaces(starts[0]?.body ?? "").length <= 2;
      if (!detachedNumericOnly) {
        continue;
      }
      const nextLine = scoped[i + 1];
      if (!nextLine || parseEntryStartsInLine(nextLine.text).length > 0 || !isLikelyEntryContinuation(nextLine.text)) {
        continue;
      }
      const nextBands = resolveBandsForPage(nextLine.page, bandsByPage);
      if (nextBands.length > 0 && !lineInBands(nextLine, nextBands)) {
        continue;
      }
    }

    const acceptedStarts = starts.filter((start) => {
      if (isPlausibleReferenceSeed(start.body)) {
        return true;
      }
      if (starts.length === 1 && normalizeSpaces(start.body).length <= 2) {
        const nextLine = scoped[i + 1];
        const next2Line = scoped[i + 2];
        const firstContinuation =
          nextLine && parseEntryStartsInLine(nextLine.text).length === 0 && isLikelyEntryContinuation(nextLine.text)
            ? normalizeEntryLeadNoise(nextLine.text)
            : "";
        const secondContinuation =
          next2Line && parseEntryStartsInLine(next2Line.text).length === 0 && isLikelyEntryContinuation(next2Line.text)
            ? normalizeEntryLeadNoise(next2Line.text)
            : "";
        if (isPlausibleReferenceSeed(firstContinuation) || isPlausibleReferenceSeed(`${firstContinuation} ${secondContinuation}`)) {
          return true;
        }
      }
      // Tolerate short stretches of weakly formatted entries when numbering is contiguous.
      if (allowWeakStarts && starts.length === 1) {
        if (lastAcceptedIndex === 0 && start.index <= 3) {
          return true;
        }
        if (lastAcceptedIndex > 0 && Math.abs(start.index - lastAcceptedIndex) <= 2) {
          return true;
        }
      }
      return false;
    });
    if (acceptedStarts.length === 0) {
      continue;
    }

    for (const start of acceptedStarts) {
      if (start.index < 1 || start.index > 500) {
        continue;
      }
      if (entries.length >= 8 && lastAcceptedIndex > 0 && start.index > lastAcceptedIndex + 80) {
        continue;
      }

      let text = start.body;
      if (acceptedStarts.length === 1) {
        const anchorX = line.bbox.x;
        for (let j = i + 1; j < scoped.length; j += 1) {
          const next = scoped[j];
          if (!next) {
            break;
          }
          if (parseEntryStartsInLine(next.text).length > 0) {
            break;
          }
          if (next.page > line.page + 1) {
            break;
          }
          if (lastSeedPage > 0 && next.page > lastSeedPage + 1) {
            break;
          }
          const nextBands = resolveBandsForPage(next.page, bandsByPage);
          if (nextBands.length > 0 && !lineInBands(next, nextBands)) {
            if (next.page === line.page) {
              break;
            }
            continue;
          }
          if (next.page === line.page && Math.abs(next.bbox.x - anchorX) > 260) {
            break;
          }
          if (!isLikelyEntryContinuation(next.text)) {
            break;
          }
          text = `${text} ${next.text}`;
        }
      }

      const finalText = normalizeSpaces(text);
      if (finalText.length < 8) {
        continue;
      }
      entries.push({
        docId,
        index: start.index,
        text: finalText,
        page: line.page,
      });
      lastAcceptedIndex = Math.max(lastAcceptedIndex, start.index);
    }
  }

  const byIndex = new Map<number, ReferenceEntry>();
  for (const entry of entries) {
    const current = byIndex.get(entry.index);
    if (!current || entry.text.length > current.text.length) {
      byIndex.set(entry.index, entry);
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function normalizeYear(yearRaw: string): string {
  return yearRaw.replace(/[^\d]/g, "");
}

function looksLikeAuthorYearStart(text: string): boolean {
  const normalized = normalizeEntryLeadNoise(text);
  if (!normalized || REFERENCES_HEADER_PATTERN.test(normalized)) {
    return false;
  }
  if (/^(received|revised|accepted|published):/i.test(normalized)) {
    return false;
  }
  if (/^https?:\/\//i.test(normalized) || /^doi[:\s]/i.test(normalized)) {
    return false;
  }
  if (/^\d{1,4}[.)]\s+/.test(normalized) || /^\[\d{1,4}\]/.test(normalized)) {
    return false;
  }
  const yearMatch = normalized.match(/\((?:19|20)\d{2}[a-z]?\)/i);
  if (!yearMatch || typeof yearMatch.index !== "number") {
    return false;
  }

  const head = normalized.slice(0, yearMatch.index).trim();
  if (head.length < 6 || head.length > 140) {
    return false;
  }

  if (/^[A-Z][A-Za-z'’\-]{1,40},\s+/.test(head)) {
    return true;
  }
  if (/^[A-Z][A-Za-z'’\-]{1,40}\s+(?:and|&)\s+[A-Z][A-Za-z'’\-]{1,40},\s+/.test(head)) {
    return true;
  }
  if (/consortium/i.test(head) && /^[A-Za-z0-9'’\-;,&.\s]+$/.test(head)) {
    return true;
  }
  return false;
}

function isLikelyReferenceFooter(text: string): boolean {
  const normalized = normalizeEntryLeadNoise(text);
  if (!normalized) {
    return false;
  }
  if (/^Cell\s+\d+\b/i.test(normalized)) {
    return true;
  }
  if (/^Supplemental Information\b/i.test(normalized)) {
    return true;
  }
  if (/^https?:\/\/doi\.org\/10\./i.test(normalized)) {
    return true;
  }
  return false;
}

function reorderLinesByPageColumn(lines: LineEntry[]): LineEntry[] {
  if (lines.length === 0) {
    return [];
  }

  const byPage = new Map<number, LineEntry[]>();
  for (const line of lines) {
    const list = byPage.get(line.page) ?? [];
    list.push(line);
    byPage.set(line.page, list);
  }

  const pages = [...byPage.keys()].sort((a, b) => a - b);
  const out: LineEntry[] = [];
  for (const page of pages) {
    const pageLines = (byPage.get(page) ?? []).sort((a, b) => b.y - a.y);
    if (pageLines.length < 12) {
      out.push(...pageLines);
      continue;
    }

    const centers = pageLines
      .map((line) => line.bbox.x + line.bbox.w / 2)
      .sort((a, b) => a - b);
    let bestGap = 0;
    let splitIndex = -1;
    for (let i = 1; i < centers.length; i += 1) {
      const prev = centers[i - 1];
      const curr = centers[i];
      if (prev === undefined || curr === undefined) {
        continue;
      }
      const gap = curr - prev;
      if (gap > bestGap) {
        bestGap = gap;
        splitIndex = i;
      }
    }
    if (splitIndex < 0 || bestGap < 90) {
      out.push(...pageLines);
      continue;
    }

    const leftCenter = centers[splitIndex - 1];
    const rightCenter = centers[splitIndex];
    if (leftCenter === undefined || rightCenter === undefined) {
      out.push(...pageLines);
      continue;
    }
    const splitX = (leftCenter + rightCenter) / 2;
    const left = pageLines.filter((line) => line.bbox.x + line.bbox.w / 2 <= splitX).sort((a, b) => b.y - a.y);
    const right = pageLines.filter((line) => line.bbox.x + line.bbox.w / 2 > splitX).sort((a, b) => b.y - a.y);
    if (left.length < 4 || right.length < 4) {
      out.push(...pageLines);
      continue;
    }
    out.push(...left, ...right);
  }

  return out;
}

function extractAuthorYearEntries(lines: LineEntry[], docId: string, startIndex: number): ReferenceEntry[] {
  if (startIndex < 0 || startIndex >= lines.length) {
    return [];
  }

  const out: ReferenceEntry[] = [];
  const scoped = reorderLinesByPageColumn(lines.slice(startIndex + 1));
  let currentText = "";
  let currentPage = -1;
  let anchorX = 0;
  let sequence = 1;

  const flush = (): void => {
    const finalText = normalizeSpaces(currentText);
    if (finalText.length >= 24 && /\((?:19|20)\d{2}[a-z]?\)/i.test(finalText)) {
      out.push({
        docId,
        index: sequence,
        text: finalText,
        page: currentPage > 0 ? currentPage : (out[out.length - 1]?.page ?? 1),
      });
      sequence += 1;
    }
    currentText = "";
    currentPage = -1;
    anchorX = 0;
  };

  for (const line of scoped) {
    const normalized = normalizeEntryLeadNoise(line.text);
    if (!normalized) {
      continue;
    }

    if (looksLikeAuthorYearStart(normalized)) {
      flush();
      currentText = normalized;
      currentPage = line.page;
      anchorX = line.bbox.x;
      continue;
    }

    if (!currentText) {
      continue;
    }
    if (isLikelyReferenceFooter(normalized)) {
      continue;
    }
    if (!isLikelyEntryContinuation(normalized)) {
      continue;
    }
    if (line.page > currentPage + 1) {
      flush();
      continue;
    }
    if (line.page === currentPage && Math.abs(line.bbox.x - anchorX) > 170) {
      continue;
    }
    currentText = `${currentText} ${normalized}`;
  }

  flush();
  return out;
}

function dedupeReferenceEntries(entries: ReferenceEntry[]): ReferenceEntry[] {
  const byIndex = new Map<number, ReferenceEntry>();
  for (const entry of entries) {
    const current = byIndex.get(entry.index);
    if (!current) {
      byIndex.set(entry.index, entry);
      continue;
    }
    if (entry.text.length > current.text.length) {
      byIndex.set(entry.index, entry);
      continue;
    }
    if (entry.text.length === current.text.length && entry.page < current.page) {
      byIndex.set(entry.index, entry);
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function isNumberedEntriesUnreliable(entries: ReferenceEntry[]): boolean {
  if (entries.length === 0) {
    return true;
  }
  const indices = entries.map((entry) => entry.index).filter((idx) => idx > 0);
  const maxIndex = Math.max(...indices);
  const prefix = densePrefixLength(indices);
  const density = entries.length / Math.max(1, maxIndex);
  if (maxIndex >= 400) {
    return true;
  }
  if (maxIndex > entries.length * 6 && density < 0.2) {
    return true;
  }
  if (entries.length >= 10 && prefix < 4) {
    return true;
  }
  return false;
}

function normalizeSurname(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^[^a-z]+/g, "")
    .replace(/[^a-z'’\-]+$/g, "");
}

function extractEntryAuthorYearKeys(entryText: string): string[] {
  const yearMatch = entryText.match(/\((?:19|20)\d{2}[a-z]?\)/i);
  if (!yearMatch) {
    return [];
  }
  const year = normalizeYear(yearMatch[0] ?? "");
  if (!year) {
    return [];
  }

  const keys = new Set<string>();
  const startSurname = entryText.match(/^\s*([A-Z][A-Za-z'’\-]{1,40}),/);
  if (startSurname?.[1]) {
    const surname = normalizeSurname(startSurname[1]);
    if (surname) {
      keys.add(`${surname}:${year}`);
    }
  }
  const andPair = entryText.match(/^\s*([A-Z][A-Za-z'’\-]{1,40})\s+(?:and|&)\s+([A-Z][A-Za-z'’\-]{1,40}),/);
  if (andPair?.[1]) {
    const surname = normalizeSurname(andPair[1]);
    if (surname) {
      keys.add(`${surname}:${year}`);
    }
  }
  return [...keys];
}

function buildAuthorYearEntryIndex(entries: ReferenceEntry[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const entry of entries) {
    const keys = extractEntryAuthorYearKeys(entry.text);
    for (const key of keys) {
      const list = map.get(key) ?? [];
      if (!list.includes(entry.index)) {
        list.push(entry.index);
      }
      map.set(key, list);
    }
  }
  return map;
}

function parseAuthorYearToken(token: string): { surname: string; year: string } | null {
  const normalized = normalizeSpaces(token);
  if (!normalized) {
    return null;
  }

  const etAl = normalized.match(/([A-Z][A-Za-z'’\-]{1,40})\s+et\s+al\.,\s*(?:19|20)\d{2}[a-z]?/i);
  if (etAl?.[1]) {
    return {
      surname: normalizeSurname(etAl[1]),
      year: "",
    };
  }

  const andPair = normalized.match(
    /([A-Z][A-Za-z'’\-]{1,40})\s+(?:and|&)\s+[A-Z][A-Za-z'’\-]{1,40},\s*(?:19|20)\d{2}[a-z]?/i,
  );
  if (andPair?.[1]) {
    return {
      surname: normalizeSurname(andPair[1]),
      year: "",
    };
  }

  const single = normalized.match(/([A-Z][A-Za-z'’\-]{1,40}),\s*(?:19|20)\d{2}[a-z]?/i);
  if (single?.[1]) {
    return {
      surname: normalizeSurname(single[1]),
      year: "",
    };
  }

  return null;
}

function parseAuthorYearGroupToIndices(groupText: string, entryIndexByAuthorYear: Map<string, number[]>): number[] {
  const parts = groupText.split(";").map((part) => normalizeSpaces(part)).filter(Boolean);
  if (parts.length === 0) {
    return [];
  }

  const indices: number[] = [];
  const seen = new Set<number>();
  for (const part of parts) {
    const parsed = parseAuthorYearToken(part);
    if (!parsed || !parsed.surname) {
      continue;
    }
    const years = [...part.matchAll(/(?:19|20)\d{2}[a-z]?/g)]
      .map((match) => normalizeYear(match[0] ?? ""))
      .filter(Boolean);
    if (years.length === 0) {
      continue;
    }
    for (const year of years) {
      const matched = entryIndexByAuthorYear.get(`${parsed.surname}:${year}`) ?? [];
      for (const idx of matched) {
        if (!seen.has(idx)) {
          seen.add(idx);
          indices.push(idx);
        }
      }
    }
  }
  return indices;
}

function parseAuthorYearSnippetToIndices(snippet: string, entryIndexByAuthorYear: Map<string, number[]>): number[] {
  const parsed = parseAuthorYearToken(snippet);
  if (!parsed || !parsed.surname) {
    return [];
  }
  const years = [...snippet.matchAll(/(?:19|20)\d{2}[a-z]?/g)]
    .map((match) => normalizeYear(match[0] ?? ""))
    .filter(Boolean);
  if (years.length === 0) {
    return [];
  }

  const out: number[] = [];
  const seen = new Set<number>();
  for (const year of years) {
    const matched = entryIndexByAuthorYear.get(`${parsed.surname}:${year}`) ?? [];
    for (const idx of matched) {
      if (!seen.has(idx)) {
        seen.add(idx);
        out.push(idx);
      }
    }
  }
  return out;
}

function isLikelySuperscriptMarker(line: LineEntry, token: LineToken, cleanedText: string, indices: number[]): boolean {
  if (indices.length === 0) {
    return false;
  }

  const prev = line.tokens
    .filter((item) => item.end <= token.start)
    .sort((a, b) => b.end - a.end)[0];
  if (!prev) {
    return false;
  }

  const prevText = prev.span.text.trim();
  if (!/[A-Za-z)]$/.test(prevText)) {
    return false;
  }

  const dx = token.span.bbox.x - (prev.span.bbox.x + prev.span.bbox.w);
  if (dx < -8 || dx > 30) {
    return false;
  }

  const prevH = Math.max(1, prev.span.bbox.h);
  const thisH = Math.max(1, token.span.bbox.h);
  const small = thisH <= prevH * 0.9;
  const raised = token.span.bbox.y >= prev.span.bbox.y + prevH * 0.12;
  const listLike = cleanedText.includes(",") || cleanedText.includes("-") || cleanedText.includes("–");

  return small || raised || listLike;
}

function dedupeMarkers(markers: InTextReferenceMarker[]): InTextReferenceMarker[] {
  const uniq = new Map<string, InTextReferenceMarker>();
  for (const marker of markers) {
    const key = `${marker.page}:${marker.indices.join(",")}:${Math.round(marker.bbox.x)}:${Math.round(marker.bbox.y)}`;
    if (!uniq.has(key)) {
      uniq.set(key, marker);
    }
  }
  return [...uniq.values()];
}

function filterMarkersByEntryIndex(markers: InTextReferenceMarker[], entries: ReferenceEntry[]): InTextReferenceMarker[] {
  if (entries.length < 10) {
    return markers;
  }
  const allowed = new Set(entries.map((entry) => entry.index));
  return markers.filter((marker) => marker.indices.every((index) => allowed.has(index)));
}

function extractInTextMarkers(
  lines: LineEntry[],
  docId: string,
  referencesStart: number,
  entryIndexByAuthorYear: Map<string, number[]>,
): InTextReferenceMarker[] {
  const markers: InTextReferenceMarker[] = [];
  const contentLines = referencesStart >= 0 ? lines.slice(0, referencesStart) : lines;

  for (const line of contentLines) {
    for (const match of line.text.matchAll(BRACKET_MARKER_PATTERN)) {
      const full = match[0] ?? "";
      const body = match[1] ?? "";
      const start = match.index ?? -1;
      if (start < 0) {
        continue;
      }
      const end = start + full.length;
      const indices = parseIndexList(body);
      if (!indices) {
        continue;
      }
      const bbox = matchRectFromTokens(line.tokens, start, end) ?? line.bbox;
      markers.push({
        id: randomUUID(),
        docId,
        page: line.page,
        text: full,
        indices,
        bbox,
      });
    }

    for (const token of line.tokens) {
      const parsed = parseSuperscriptCandidate(token.span.text);
      if (!parsed) {
        continue;
      }
      if (!isLikelySuperscriptMarker(line, token, parsed.cleaned, parsed.indices)) {
        continue;
      }
      markers.push({
        id: randomUUID(),
        docId,
        page: line.page,
        text: parsed.cleaned,
        indices: parsed.indices,
        bbox: token.span.bbox,
      });
    }

    if (entryIndexByAuthorYear.size > 0) {
      for (const match of line.text.matchAll(AUTHOR_YEAR_GROUP_PATTERN)) {
        const full = match[0] ?? "";
        const body = match[1] ?? "";
        const start = match.index ?? -1;
        if (start < 0 || !/(?:19|20)\d{2}/.test(body)) {
          continue;
        }
        const end = start + full.length;
        const indices = parseAuthorYearGroupToIndices(body, entryIndexByAuthorYear);
        if (indices.length === 0) {
          continue;
        }
        const bbox = matchRectFromTokens(line.tokens, start, end) ?? line.bbox;
        markers.push({
          id: randomUUID(),
          docId,
          page: line.page,
          text: full,
          indices,
          bbox,
        });
      }

      for (const match of line.text.matchAll(INLINE_AUTHOR_YEAR_PATTERN)) {
        const full = match[0] ?? "";
        const start = match.index ?? -1;
        if (start < 0) {
          continue;
        }
        const before = start > 0 ? line.text[start - 1] ?? "" : "";
        const after = line.text[start + full.length] ?? "";
        // Inline mode is meant for non-parenthesized mentions; parenthesized ones
        // are already handled by AUTHOR_YEAR_GROUP_PATTERN.
        if (before === "(" || after === ")") {
          continue;
        }
        const indices = parseAuthorYearSnippetToIndices(full, entryIndexByAuthorYear);
        if (indices.length === 0) {
          continue;
        }
        const end = start + full.length;
        const bbox = matchRectFromTokens(line.tokens, start, end) ?? line.bbox;
        markers.push({
          id: randomUUID(),
          docId,
          page: line.page,
          text: full,
          indices,
          bbox,
        });
      }
    }
  }

  return dedupeMarkers(markers);
}

export function inferReferenceCount(entries: ReferenceEntry[], markers: InTextReferenceMarker[] = []): number {
  const indices = [
    ...entries.map((entry) => entry.index),
    ...markers.flatMap((marker) => marker.indices ?? []),
  ]
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.floor(value));
  if (indices.length === 0) {
    return 0;
  }

  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  let inferred = sorted[sorted.length - 1] ?? sorted.length;

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const current = sorted[i] ?? 0;
    const next = sorted[i + 1] ?? current;
    const gap = next - current;
    const prefixSize = i + 1;
    const tailSize = sorted.length - prefixSize;
    const largeGap = gap >= 8;
    const stablePrefix = current >= 15;
    const tailLooksLikeOutliers = tailSize <= Math.max(4, Math.floor(prefixSize * 0.2));
    if (largeGap && stablePrefix && tailLooksLikeOutliers) {
      inferred = current;
      break;
    }
  }

  return inferred;
}

export function extractReferenceData(spans: ParsedTextSpan[], docId: string): ReferenceParseResult {
  const lines = buildLines(spans);
  const startCandidates = findReferencesStarts(lines);
  const referencesStart = startCandidates[0] ?? -1;
  const numberedEntries = dedupeReferenceEntries(
    (startCandidates.length > 0 ? startCandidates : [referencesStart]).flatMap((start) => extractReferenceEntries(lines, docId, start)),
  );
  const authorYearEntries = dedupeReferenceEntries(
    (startCandidates.length > 0 ? startCandidates : [referencesStart]).flatMap((start) => extractAuthorYearEntries(lines, docId, start)),
  );
  let entries =
    authorYearEntries.length >= 8 && (isNumberedEntriesUnreliable(numberedEntries) || authorYearEntries.length > numberedEntries.length * 1.25)
      ? authorYearEntries
      : numberedEntries;

  const spanNumberedEntries = extractNumberedEntriesFromSpans(spans, docId);
  if (spanNumberedEntries.length > 0) {
    const merged = dedupeReferenceEntries([...entries, ...spanNumberedEntries]);
    const basePrefix = densePrefixLength(entries.map((item) => item.index));
    const mergedPrefix = densePrefixLength(merged.map((item) => item.index));
    const baseInferred = inferReferenceCount(entries);
    const mergedInferred = inferReferenceCount(merged);
    const shouldAdoptSpanFallback =
      (mergedPrefix >= Math.max(12, basePrefix + 6) && mergedInferred >= baseInferred) ||
      (basePrefix < 8 && mergedPrefix >= 20) ||
      (entries.length < 24 && merged.length >= entries.length + 10 && mergedInferred >= baseInferred + 8);
    if (shouldAdoptSpanFallback) {
      entries = merged;
    }
  }

  const authorYearIndex = buildAuthorYearEntryIndex(entries);
  const markers = filterMarkersByEntryIndex(extractInTextMarkers(lines, docId, referencesStart, authorYearIndex), entries);
  return { markers, entries };
}

export type { ReferenceParseResult };
