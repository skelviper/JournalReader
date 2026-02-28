import { randomUUID } from "node:crypto";
import type { CitationRef, ParsedTextSpan, Rect, TargetKind } from "@journal-reader/types";

const PREFIX_PATTERN =
  /\b(Supplementary\s+(?:Figure|Fig\.?|Table)|Extended\s+Data\s+(?:Figure|Fig\.?|Table)|Figures?|Figs?\.?|Tables?)(?=\s|$)/gi;

type CitationMatch = {
  text: string;
  kind: TargetKind;
  label: string;
  start: number;
  end: number;
};

type LineToken = {
  span: ParsedTextSpan;
  start: number;
  end: number;
};

type ParsedLabel = {
  label: string;
  start: number;
  end: number;
};

function normalizeLabel(label: string): string {
  return label.trim().toUpperCase();
}

function labelParts(label: string): { base: string; suffix: string } | null {
  const match = normalizeLabel(label).match(/^(S?\d+)([A-Z]?)$/);
  if (!match) {
    return null;
  }
  return {
    base: match[1] ?? "",
    suffix: match[2] ?? "",
  };
}

function kindFromPrefix(prefix: string, label: string): TargetKind {
  const lower = prefix.toLowerCase();
  const normalizedLabel = normalizeLabel(label);
  if (lower.startsWith("supplementary") || lower.startsWith("extended data")) {
    return "supplementary";
  }
  if (lower.startsWith("table")) {
    return normalizedLabel.startsWith("S") ? "supplementary" : "table";
  }
  return normalizedLabel.startsWith("S") ? "supplementary" : "figure";
}

function skipWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && /\s/.test(text[i] ?? "")) {
    i += 1;
  }
  return i;
}

function parseLabelToken(text: string, index: number, currentBase: string | null): ParsedLabel & { next: number; base: string } | null {
  const remain = text.slice(index);
  const full = remain.match(/^(S?\d+)([A-Za-z]?)/);
  if (full) {
    const base = normalizeLabel(full[1] ?? "");
    const suffix = normalizeLabel(full[2] ?? "");
    const label = `${base}${suffix}`;
    const end = index + (full[0]?.length ?? 0);
    if (label) {
      return { label, start: index, end, next: end, base };
    }
  }

  if (!currentBase) {
    return null;
  }

  const letter = remain[0] ?? "";
  const next = remain[1] ?? "";
  if (!/[A-Za-z]/.test(letter) || /[A-Za-z]/.test(next)) {
    return null;
  }
  const suffix = normalizeLabel(letter);
  const label = `${currentBase}${suffix}`;
  const end = index + 1;
  return { label, start: index, end, next: end, base: currentBase };
}

function expandRange(startLabel: string, endLabel: string): string[] {
  const start = labelParts(startLabel);
  const end = labelParts(endLabel);
  if (!start || !end) {
    return [startLabel, endLabel];
  }
  if (start.base !== end.base || start.suffix.length !== 1 || end.suffix.length !== 1) {
    return [startLabel, endLabel];
  }

  const from = start.suffix.charCodeAt(0);
  const to = end.suffix.charCodeAt(0);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return [startLabel, endLabel];
  }

  const step = from <= to ? 1 : -1;
  if (Math.abs(to - from) > 10) {
    return [startLabel, endLabel];
  }

  const out: string[] = [];
  for (let code = from; step > 0 ? code <= to : code >= to; code += step) {
    out.push(`${start.base}${String.fromCharCode(code)}`);
  }
  return out;
}

function consumeListSeparator(text: string, index: number): { next: number; consumed: boolean } {
  let i = skipWhitespace(text, index);
  const ch = text[i] ?? "";
  if (ch === "," || ch === ";" || ch === "/") {
    return { next: skipWhitespace(text, i + 1), consumed: true };
  }

  if (ch === "&") {
    return { next: skipWhitespace(text, i + 1), consumed: true };
  }

  const andMatch = text.slice(i).match(/^and\b/i);
  if (andMatch) {
    return { next: skipWhitespace(text, i + (andMatch[0]?.length ?? 0)), consumed: true };
  }

  return { next: index, consumed: false };
}

function parseLabelSequence(text: string, startIndex: number): { labels: ParsedLabel[]; end: number } {
  const labels: ParsedLabel[] = [];
  let i = skipWhitespace(text, startIndex);
  let currentBase: string | null = null;

  for (let guard = 0; guard < 24; guard += 1) {
    const parsed = parseLabelToken(text, i, currentBase);
    if (!parsed) {
      break;
    }
    labels.push({ label: parsed.label, start: parsed.start, end: parsed.end });
    i = parsed.next;
    currentBase = parsed.base;
    i = skipWhitespace(text, i);

    const dash = text[i] ?? "";
    if (dash === "-" || dash === "–" || dash === "—") {
      const afterDash = skipWhitespace(text, i + 1);
      const rangeEnd = parseLabelToken(text, afterDash, currentBase);
      if (rangeEnd) {
        const expanded = expandRange(parsed.label, rangeEnd.label);
        for (const expandedLabel of expanded.slice(1)) {
          labels.push({
            label: expandedLabel,
            start: rangeEnd.start,
            end: rangeEnd.end,
          });
        }
        i = skipWhitespace(text, rangeEnd.next);
        currentBase = rangeEnd.base;
      }
    }

    const sep = consumeListSeparator(text, i);
    if (!sep.consumed) {
      break;
    }
    i = sep.next;
  }

  return { labels, end: i };
}

function sliceRectHorizontally(rect: Rect, fromRatio: number, toRatio: number): Rect {
  const clampedFrom = Math.max(0, Math.min(1, fromRatio));
  const clampedTo = Math.max(clampedFrom, Math.min(1, toRatio));
  const x0 = rect.x + rect.w * clampedFrom;
  const x1 = rect.x + rect.w * clampedTo;
  return {
    x: x0,
    y: rect.y,
    w: Math.max(1, x1 - x0),
    h: rect.h,
  };
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
    const fromRatio = (overlapStart - token.start) / tokenLength;
    const toRatio = (overlapEnd - token.start) / tokenLength;
    partials.push(sliceRectHorizontally(token.span.bbox, fromRatio, toRatio));
  }

  if (partials.length > 0) {
    return unionRects(partials);
  }

  const overlapTokens = tokens
    .filter((token) => token.end > start && token.start < end)
    .map((token) => token.span.bbox);
  if (overlapTokens.length > 0) {
    return unionRects(overlapTokens);
  }
  return null;
}

function addMatch(
  out: CitationMatch[],
  seen: Set<string>,
  text: string,
  kind: TargetKind,
  label: string,
  start: number,
  end: number,
): void {
  const normalized = normalizeLabel(label);
  const key = `${start}:${end}:${kind}:${normalized}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  out.push({
    text,
    kind,
    label: normalized,
    start,
    end,
  });
}

function findCitationMatches(text: string): CitationMatch[] {
  const out: CitationMatch[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(PREFIX_PATTERN)) {
    const prefix = match[1] ?? match[0] ?? "";
    const start = match.index ?? -1;
    if (start < 0) {
      continue;
    }

    const parseStart = start + (match[0]?.length ?? 0);
    const parsedLabels = parseLabelSequence(text, parseStart);
    if (parsedLabels.labels.length === 0) {
      continue;
    }

    for (const parsed of parsedLabels.labels) {
      const normalized = normalizeLabel(parsed.label);
      addMatch(
        out,
        seen,
        `${prefix} ${normalized}`,
        kindFromPrefix(prefix, normalized),
        normalized,
        parsed.start,
        parsed.end,
      );
    }
  }

  return out;
}

function buildLineTokens(spans: ParsedTextSpan[]): { text: string; tokens: LineToken[] } {
  let text = "";
  const tokens: LineToken[] = [];

  for (const span of spans) {
    if (text.length > 0) {
      text += " ";
    }
    const start = text.length;
    text += span.text;
    const end = text.length;
    tokens.push({ span, start, end });
  }

  return { text, tokens };
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

function citationsFromLine(docId: string, spans: ParsedTextSpan[]): CitationRef[] {
  if (spans.length === 0) {
    return [];
  }
  const { text, tokens } = buildLineTokens(spans);
  const matches = findCitationMatches(text);
  const page = spans[0].page;

  return matches.map((match) => {
    const bbox = matchRectFromTokens(tokens, match.start, match.end) ?? unionRects(spans.map((span) => span.bbox));

    return {
      id: randomUUID(),
      docId,
      page,
      text: match.text,
      kind: match.kind,
      label: match.label,
      bbox,
    };
  });
}

function groupSpansByLine(spans: ParsedTextSpan[]): ParsedTextSpan[][] {
  const byPage = new Map<number, ParsedTextSpan[]>();
  for (const span of spans) {
    const list = byPage.get(span.page) ?? [];
    list.push(span);
    byPage.set(span.page, list);
  }

  const lines: ParsedTextSpan[][] = [];
  const yThreshold = 5;

  for (const [page, pageSpans] of byPage.entries()) {
    const sorted = [...pageSpans].sort((a, b) => {
      if (Math.abs(a.bbox.y - b.bbox.y) > yThreshold) {
        return b.bbox.y - a.bbox.y;
      }
      return a.bbox.x - b.bbox.x;
    });

    const pageLines: Array<{ y: number; spans: ParsedTextSpan[] }> = [];
    for (const span of sorted) {
      const line = pageLines.find((entry) => Math.abs(entry.y - span.bbox.y) <= yThreshold);
      if (!line) {
        pageLines.push({ y: span.bbox.y, spans: [span] });
        continue;
      }
      line.spans.push(span);
      line.y = (line.y + span.bbox.y) / 2;
    }

    for (const line of pageLines) {
      const lineSpans = line.spans
        .map((span) => ({ ...span, page }))
        .sort((a, b) => a.bbox.x - b.bbox.x);
      lines.push(lineSpans);
    }
  }

  return lines;
}

export function extractCitationsFromSpan(span: ParsedTextSpan): CitationRef[] {
  return findCitationMatches(span.text).map((match) => {
    const textLength = Math.max(1, span.text.length);
    const fromRatio = match.start / textLength;
    const toRatio = match.end / textLength;
    return {
      id: randomUUID(),
      docId: "",
      page: span.page,
      text: match.text,
      kind: match.kind,
      label: normalizeLabel(match.label),
      bbox: sliceRectHorizontally(span.bbox, fromRatio, toRatio),
    };
  });
}

export function extractCitations(spans: ParsedTextSpan[], docId: string): CitationRef[] {
  const lineCitations = groupSpansByLine(spans).flatMap((line) => citationsFromLine(docId, line));
  const merged =
    lineCitations.length > 0
      ? lineCitations
      : spans.flatMap((span) =>
          extractCitationsFromSpan(span).map((citation) => ({
            ...citation,
            docId,
          })),
        );

  const uniq = new Map<string, CitationRef>();
  for (const citation of merged) {
    const key = `${citation.page}:${citation.kind}:${citation.label}:${Math.round(citation.bbox.x)}:${Math.round(citation.bbox.y)}`;
    if (!uniq.has(key)) {
      uniq.set(key, citation);
    }
  }
  return [...uniq.values()];
}
