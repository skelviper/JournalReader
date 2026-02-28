import type { ParsedCaption, ParsedTextSpan, Rect, TargetKind } from "@journal-reader/types";

const STRICT_CAPTION_PATTERN =
  /^\s*(Supplementary\s+(?:Figure|Fig\.?|Table)|Extended\s+Data\s+(?:Figure|Fig\.?|Table)|Figure|Fig\.?|Table)\s*(S?\d+[A-Za-z]?)\s*([:|.\-])\s*(.+)$/i;
const LOOSE_CAPTION_PATTERN =
  /^\s*(Supplementary\s+(?:Figure|Fig\.?|Table)|Extended\s+Data\s+(?:Figure|Fig\.?|Table)|Figure|Fig\.?|Table)\s*(S?\d+[A-Za-z]?)\s+(.+)$/i;

function kindFromPrefix(prefix: string, label: string): TargetKind {
  const lower = prefix.toLowerCase();
  if (lower.startsWith("supplementary") || lower.startsWith("extended data")) {
    return "supplementary";
  }
  if (label.toUpperCase().startsWith("S")) {
    return "supplementary";
  }
  if (lower.startsWith("table")) {
    return "table";
  }
  return "figure";
}

function normalizeLabel(label: string): string {
  return label.trim().toUpperCase();
}

type LineEntry = {
  page: number;
  y: number;
  text: string;
  bbox: Rect;
};

function splitSpansByHorizontalGap(spans: ParsedTextSpan[]): ParsedTextSpan[][] {
  if (spans.length <= 1) {
    return [spans];
  }

  const segments: ParsedTextSpan[][] = [];
  let current: ParsedTextSpan[] = [];

  for (const span of spans) {
    const prev = current[current.length - 1];
    if (!prev) {
      current.push(span);
      continue;
    }

    const prevRight = prev.bbox.x + prev.bbox.w;
    const gap = span.bbox.x - prevRight;
    // PDF text extraction may return a whole column line as one very wide span.
    // Relative thresholds become too strict in that case; use absolute visual gap.
    const minAbsGap = Math.max(18, Math.min(42, prev.bbox.h * 1.45));
    if (gap > minAbsGap) {
      segments.push(current);
      current = [span];
      continue;
    }

    current.push(span);
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

function sortLinesTopToBottom(lines: LineEntry[]): LineEntry[] {
  return [...lines].sort((a, b) => {
    if (Math.abs(a.y - b.y) > 3) {
      return b.y - a.y;
    }
    return a.bbox.x - b.bbox.x;
  });
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

function normalizeInlineText(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function reorderTwoColumnContinuation(lines: LineEntry[]): LineEntry[] {
  if (lines.length < 4) {
    return lines;
  }

  const centers = lines
    .map((line) => line.bbox.x + line.bbox.w / 2)
    .sort((a, b) => a - b);
  if (centers.length < 2) {
    return lines;
  }

  const minCenter = centers[0] ?? 0;
  const maxCenter = centers[centers.length - 1] ?? minCenter;
  const spread = maxCenter - minCenter;
  if (spread < 120) {
    return lines;
  }

  let bestGap = 0;
  let bestIndex = -1;
  for (let i = 1; i < centers.length; i += 1) {
    const prev = centers[i - 1];
    const cur = centers[i];
    if (prev === undefined || cur === undefined) {
      continue;
    }
    const gap = cur - prev;
    if (gap > bestGap) {
      bestGap = gap;
      bestIndex = i;
    }
  }

  if (bestIndex < 0 || bestGap < Math.max(60, spread * 0.18)) {
    return lines;
  }

  const leftCenter = centers[bestIndex - 1];
  const rightCenter = centers[bestIndex];
  if (leftCenter === undefined || rightCenter === undefined) {
    return lines;
  }
  const splitX = (leftCenter + rightCenter) / 2;
  const left = lines.filter((line) => line.bbox.x + line.bbox.w / 2 <= splitX);
  const right = lines.filter((line) => line.bbox.x + line.bbox.w / 2 > splitX);
  if (left.length < 2 || right.length < 2) {
    return lines;
  }

  const leftTop = Math.max(...left.map((line) => line.y));
  const leftBottom = Math.min(...left.map((line) => line.y));
  const rightTop = Math.max(...right.map((line) => line.y));
  const rightBottom = Math.min(...right.map((line) => line.y));
  const overlap = Math.max(0, Math.min(leftTop, rightTop) - Math.max(leftBottom, rightBottom));
  const leftHeight = Math.max(1, leftTop - leftBottom);
  const rightHeight = Math.max(1, rightTop - rightBottom);
  if (overlap < Math.min(leftHeight, rightHeight) * 0.25) {
    return lines;
  }

  return [...sortLinesTopToBottom(left), ...sortLinesTopToBottom(right)];
}

function buildPageLines(spans: ParsedTextSpan[]): LineEntry[] {
  const byPage = new Map<number, ParsedTextSpan[]>();
  for (const span of spans) {
    const list = byPage.get(span.page) ?? [];
    list.push(span);
    byPage.set(span.page, list);
  }

  const allLines: LineEntry[] = [];
  const yThreshold = 4;

  for (const [page, pageSpans] of byPage.entries()) {
    const sorted = [...pageSpans].sort((a, b) => {
      if (Math.abs(a.bbox.y - b.bbox.y) > yThreshold) {
        return b.bbox.y - a.bbox.y;
      }
      return a.bbox.x - b.bbox.x;
    });

    const rawLines: Array<{ y: number; spans: ParsedTextSpan[] }> = [];
    for (const span of sorted) {
      const match = rawLines.find((line) => Math.abs(line.y - span.bbox.y) <= yThreshold);
      if (!match) {
        rawLines.push({ y: span.bbox.y, spans: [span] });
        continue;
      }
      match.spans.push(span);
      match.y = (match.y + span.bbox.y) / 2;
    }

    const lines = rawLines
      .flatMap((line) => {
        const lineSpans = [...line.spans].sort((a, b) => a.bbox.x - b.bbox.x);
        const segments = splitSpansByHorizontalGap(lineSpans);
        return segments.map((segment) => {
          const text = normalizeInlineText(segment.map((span) => span.text));
          return {
            page,
            y: line.y,
            text,
            bbox: unionRects(segment.map((span) => span.bbox)),
          };
        });
      })
      .filter((line) => line.text.length > 0)
      .sort((a, b) => {
        if (Math.abs(a.y - b.y) > yThreshold) {
          return b.y - a.y;
        }
        return a.bbox.x - b.bbox.x;
      });

    allLines.push(...lines);
  }

  return allLines;
}

function isCaptionContinuation(text: string): boolean {
  const t = text.trim();
  if (!t) {
    return false;
  }
  if (/^(Figure|Fig\.?|Table|Supplementary|Extended Data)\s*(S?\d+)/i.test(t)) {
    return false;
  }
  if (/^(Article|References|Acknowledg|Methods|Received|Accepted|Published|Open access)\b/i.test(t)) {
    return false;
  }
  return true;
}

function parseCaptionText(
  text: string,
): { prefix: string; label: string; body: string; quality: number } | null {
  const strict = text.match(STRICT_CAPTION_PATTERN);
  if (strict) {
    const body = strict[4].trim();
    if (!body || /^[,;)\]]/.test(body)) {
      return null;
    }
    return {
      prefix: strict[1],
      label: strict[2],
      body,
      quality: 1,
    };
  }

  const loose = text.match(LOOSE_CAPTION_PATTERN);
  if (!loose) {
    return null;
  }

  const body = loose[3].trim();
  if (!body || body.length < 12) {
    return null;
  }
  if (/^[,.;)\]]/.test(body)) {
    return null;
  }
  if (!/^[A-Z]/.test(body)) {
    return null;
  }

  return {
    prefix: loose[1],
    label: loose[2],
    body,
    quality: 0.75,
  };
}

export function extractCaptions(spans: ParsedTextSpan[]): ParsedCaption[] {
  const captions: ParsedCaption[] = [];
  const lines = buildPageLines(spans);
  const byPage = new Map<number, LineEntry[]>();
  for (const line of lines) {
    const list = byPage.get(line.page) ?? [];
    list.push(line);
    byPage.set(line.page, list);
  }

  for (const [page, pageLines] of byPage.entries()) {
    let skipUntil = -1;
    for (let i = 0; i < pageLines.length; i += 1) {
      if (i < skipUntil) {
        continue;
      }

      const first = pageLines[i];
      if (!first) {
        continue;
      }

      const parsed = parseCaptionText(first.text);
      if (!parsed) {
        continue;
      }

      const block: LineEntry[] = [first];
      let prevY = first.y;
      let totalChars = first.text.length;
      for (let j = i + 1; j < pageLines.length && block.length < 24 && totalChars < 3200; j += 1) {
        const next = pageLines[j];
        if (!next) {
          break;
        }
        if (parseCaptionText(next.text)) {
          break;
        }

        const verticalGap = Math.abs(prevY - next.y);
        if (verticalGap > 22) {
          break;
        }
        if (!isCaptionContinuation(next.text)) {
          break;
        }
        block.push(next);
        prevY = next.y;
        totalChars += next.text.length;
      }

      const continuationLines = reorderTwoColumnContinuation(block.slice(1));
      const continuation = normalizeInlineText(continuationLines.map((line) => line.text));
      const body = normalizeInlineText([parsed.body, continuation]);
      const label = normalizeLabel(parsed.label);

      captions.push({
        kind: kindFromPrefix(parsed.prefix, label),
        label,
        caption: `${parsed.prefix} ${label}: ${body}`,
        page,
        bbox: unionRects(block.map((line) => line.bbox)),
        quality: parsed.quality,
      });

      skipUntil = i + block.length;
    }
  }

  return captions;
}
