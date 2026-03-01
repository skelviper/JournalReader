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

function findReferencesStart(lines: LineEntry[]): number {
  return lines.findIndex((line) => REFERENCES_HEADER_PATTERN.test(normalizeEntryLeadNoise(line.text)));
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
    if (index >= 1 && index <= 999 && body.length >= 10 && /[A-Za-z]/.test(body)) {
      return { index, body };
    }
  }

  return null;
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

  return [];
}

function guessReferencesStartByCandidates(lines: LineEntry[]): number {
  if (lines.length === 0) {
    return -1;
  }

  const candidates = lines
    .map((line, idx) => ({ idx, line, starts: parseEntryStartsInLine(line.text) }))
    .filter((item) => item.starts.length > 0);

  if (candidates.length === 0) {
    return -1;
  }

  const byPage = new Map<number, Array<{ idx: number; starts: Array<{ index: number; body: string }> }>>();
  for (const item of candidates) {
    const list = byPage.get(item.line.page) ?? [];
    list.push({ idx: item.idx, starts: item.starts });
    byPage.set(item.line.page, list);
  }

  const pages = [...byPage.keys()].sort((a, b) => a - b);
  for (const page of pages) {
    const windowItems = candidates.filter((item) => item.line.page >= page && item.line.page <= page + 2);
    const count = windowItems.reduce((acc, item) => acc + item.starts.length, 0);
    const indices = windowItems.flatMap((item) => item.starts.map((entry) => entry.index));
    const uniqueCount = new Set(indices).size;
    const maxIndex = indices.length > 0 ? Math.max(...indices) : 0;
    if (count >= 8 && uniqueCount >= 6 && maxIndex >= 10) {
      const firstOnPage = windowItems
        .filter((item) => item.line.page === page)
        .sort((a, b) => a.idx - b.idx)[0];
      if (firstOnPage) {
        return Math.max(0, firstOnPage.idx - 1);
      }
    }
  }

  const startAtOne = candidates
    .find((item) => item.starts.some((entry) => entry.index === 1));
  if (startAtOne) {
    return Math.max(0, startAtOne.idx - 1);
  }

  return Math.max(0, candidates[0]?.idx ?? 0);
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
  return true;
}

function extractReferenceEntries(lines: LineEntry[], docId: string, startIndex: number): ReferenceEntry[] {
  const entries: ReferenceEntry[] = [];
  if (startIndex < 0 || startIndex >= lines.length) {
    return entries;
  }

  const scoped = lines.slice(startIndex + 1);
  for (let i = 0; i < scoped.length; i += 1) {
    const line = scoped[i];
    if (!line) {
      continue;
    }

    const starts = parseEntryStartsInLine(line.text);
    if (starts.length === 0) {
      continue;
    }

    for (const start of starts) {
      if (start.index < 1 || start.index > 500) {
        continue;
      }

      let text = start.body;
      if (starts.length === 1) {
        const anchorX = line.bbox.x;
        for (let j = i + 1; j < scoped.length; j += 1) {
          const next = scoped[j];
          if (!next) {
            break;
          }
          if (parseEntryStartsInLine(next.text).length > 0) {
            break;
          }
          if (next.page === line.page && Math.abs(next.bbox.x - anchorX) > 360) {
            continue;
          }
          if (next.page > line.page + 1) {
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

function extractInTextMarkers(lines: LineEntry[], docId: string, referencesStart: number): InTextReferenceMarker[] {
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
  }

  return dedupeMarkers(markers);
}

export function extractReferenceData(spans: ParsedTextSpan[], docId: string): ReferenceParseResult {
  const lines = buildLines(spans);
  const referencesStart = (() => {
    const explicit = findReferencesStart(lines);
    if (explicit >= 0) {
      return explicit;
    }
    return guessReferencesStartByCandidates(lines);
  })();
  const entries = extractReferenceEntries(lines, docId, referencesStart);
  const markers = filterMarkersByEntryIndex(extractInTextMarkers(lines, docId, referencesStart), entries);
  return { markers, entries };
}

export type { ReferenceParseResult };
