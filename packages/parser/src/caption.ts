import type { ParsedCaption, ParsedTextSpan, Rect, TargetKind } from "@journal-reader/types";

const CAPTION_LABEL = "S?\\s*\\d+\\s*[A-Za-z]?";
const STRICT_CAPTION_PATTERN = new RegExp(
  `^\\s*(Supplementary\\s+(?:Figure|Fig\\.?|Table)|Extended\\s+Data\\s+(?:Figure|Fig\\.?|Table)|Figure|Fig\\.?|Table)\\s*(${CAPTION_LABEL})\\s*([:|.\\-])\\s*(.+)$`,
  "i",
);
const LOOSE_CAPTION_PATTERN = new RegExp(
  `^\\s*(Supplementary\\s+(?:Figure|Fig\\.?|Table)|Extended\\s+Data\\s+(?:Figure|Fig\\.?|Table)|Figure|Fig\\.?|Table)\\s*(${CAPTION_LABEL})\\s+(.+)$`,
  "i",
);
const HEAD_ONLY_CAPTION_PATTERN = new RegExp(
  `^\\s*(Supplementary\\s+(?:Figure|Fig\\.?|Table)|Extended\\s+Data\\s+(?:Figure|Fig\\.?|Table)|Figure|Fig\\.?|Table)\\s*(${CAPTION_LABEL})\\s*[:|.\\-]?\\s*$`,
  "i",
);

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
  return label.replace(/\s+/g, "").trim().toUpperCase();
}

type LineEntry = {
  page: number;
  y: number;
  text: string;
  bbox: Rect;
};

function rectIntersectsHorizontally(a: Rect, b: Rect, pad = 0): boolean {
  const ax0 = a.x - pad;
  const ax1 = a.x + a.w + pad;
  const bx0 = b.x;
  const bx1 = b.x + b.w;
  return !(ax1 < bx0 || ax0 > bx1);
}

function inferLayoutRectForCaption(
  captionRect: Rect,
  pageLines: LineEntry[],
  block: LineEntry[],
  pageBounds: { top: number; bottom: number },
  preferBelow: boolean,
): Rect | null {
  const capTop = captionRect.y + captionRect.h;
  const capBottom = captionRect.y;
  const pageMinX = Math.min(...pageLines.map((line) => line.bbox.x), captionRect.x);
  const pageMaxX = Math.max(...pageLines.map((line) => line.bbox.x + line.bbox.w), captionRect.x + captionRect.w);
  const pageTextWidth = Math.max(1, pageMaxX - pageMinX);
  const xPad = Math.max(24, captionRect.h * 2.8);
  let x0 = captionRect.x - xPad;
  let x1 = captionRect.x + captionRect.w + xPad;
  const minProbeWidth = Math.max(captionRect.w + 140, pageTextWidth * (preferBelow ? 0.56 : 0.7));
  if (x1 - x0 < minProbeWidth) {
    const cx = captionRect.x + captionRect.w / 2;
    x0 = cx - minProbeWidth / 2;
    x1 = cx + minProbeWidth / 2;
  }
  x0 = Math.max(0, Math.min(x0, pageMinX - 16));
  x1 = Math.max(x0 + 30, Math.max(x1, pageMaxX + 16));
  const probeRect: Rect = { x: x0, y: captionRect.y, w: x1 - x0, h: captionRect.h };

  const blockSet = new Set(block);
  const nearby = pageLines.filter((line) => !blockSet.has(line) && rectIntersectsHorizontally(line.bbox, probeRect, 8));
  const minGap = Math.max(18, captionRect.h * 1.5);

  if (!preferBelow) {
    const above = nearby
      .filter((line) => line.bbox.y >= capTop - 1)
      .sort((a, b) => a.bbox.y - b.bbox.y)[0];
    const upper = above ? above.bbox.y : pageBounds.top;
    const h = upper - capTop;
    if (h < minGap) {
      return null;
    }
    return {
      x: x0,
      y: capTop + 2,
      w: x1 - x0,
      h: Math.max(20, h - 4),
    };
  }

  const below = nearby
    .filter((line) => line.bbox.y + line.bbox.h <= capBottom + 1)
    .sort((a, b) => b.bbox.y - a.bbox.y)[0];
  const lower = below ? below.bbox.y + below.bbox.h : pageBounds.bottom;
  const h = capBottom - lower;
  if (h < minGap) {
    return null;
  }
  return {
    x: x0,
    y: lower + 2,
    w: x1 - x0,
    h: Math.max(20, h - 4),
  };
}

function splitCaptionHeadAndBody(rawCaption: string): { head: string; body: string } {
  const idx = rawCaption.indexOf(":");
  if (idx < 0) {
    return { head: rawCaption.trim(), body: "" };
  }
  return {
    head: rawCaption.slice(0, idx).trim(),
    body: rawCaption.slice(idx + 1).trim(),
  };
}

function isNextPagePlaceholder(body: string): boolean {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return true;
  }
  return /^(see\s+next\s+page(?:\s+for\s+caption)?|caption\s+continued\s+on\s+next\s+page)\.?$/i.test(normalized);
}

function mergeCrossPageSameLabelCaptions(captions: ParsedCaption[]): ParsedCaption[] {
  if (captions.length < 2) {
    return captions;
  }
  const sorted = [...captions].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind.localeCompare(b.kind);
    }
    if (a.label !== b.label) {
      return a.label.localeCompare(b.label);
    }
    return a.page - b.page;
  });

  const drop = new Set<number>();
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];
    if (!current || !next) {
      continue;
    }
    if (current.kind !== next.kind || current.label !== next.label) {
      continue;
    }
    if (next.page > current.page + 2) {
      continue;
    }

    const currentParts = splitCaptionHeadAndBody(current.caption);
    const nextParts = splitCaptionHeadAndBody(next.caption);
    const currentBody = currentParts.body;
    const nextBody = nextParts.body;
    if (!isNextPagePlaceholder(currentBody)) {
      continue;
    }
    if (!nextBody || nextBody.length <= currentBody.length + 8) {
      continue;
    }

    sorted[i] = {
      ...current,
      caption: `${currentParts.head}: ${nextBody}`.trim(),
      quality: Math.max(current.quality ?? 0.65, next.quality ?? 0.65),
    };
    drop.add(i + 1);
  }

  return sorted.filter((_item, idx) => !drop.has(idx)).sort((a, b) => a.page - b.page);
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
  }

  return allLines.sort((a, b) => {
    if (a.page !== b.page) {
      return a.page - b.page;
    }
    if (Math.abs(a.y - b.y) > yThreshold) {
      return b.y - a.y;
    }
    return a.bbox.x - b.bbox.x;
  });
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
  const normalizedText = normalizeCaptionLeadNoise(text);
  const strict = normalizedText.match(STRICT_CAPTION_PATTERN);
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

  const loose = normalizedText.match(LOOSE_CAPTION_PATTERN);
  if (!loose) {
    const headOnly = normalizedText.match(HEAD_ONLY_CAPTION_PATTERN);
    if (!headOnly) {
      return null;
    }
    return {
      prefix: headOnly[1],
      label: headOnly[2],
      body: "",
      quality: 0.55,
    };
  }

  const body = loose[3].trim();
  if (!body || body.length < 2) {
    return null;
  }
  if (/^[,.;)\]]/.test(body)) {
    return null;
  }
  const panelLead = /^[a-z]\s*[,.)]/i.test(body);
  const startsLikeText = /^[A-Za-z0-9(]/.test(body);
  if (!panelLead && !startsLikeText) {
    return null;
  }
  if (!/[A-Za-z]/.test(body)) {
    return null;
  }

  return {
    prefix: loose[1],
    label: loose[2],
    body,
    quality: 0.75,
  };
}

function normalizeCaptionLeadNoise(text: string): string {
  let out = text.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 4; i += 1) {
    const stripped = out.replace(/^(\(?\d{1,5}\)?[.:]?)\s+/, "");
    if (stripped === out) {
      break;
    }
    out = stripped;
  }
  out = out.replace(/^[|¦•·]+\s+/, "");
  return out;
}

function looksLikeCrossPageContinuation(text: string): boolean {
  const normalized = normalizeCaptionLeadNoise(text);
  if (!normalized) {
    return false;
  }
  if (/^[a-z]\s*[,.)]/i.test(normalized)) {
    return true;
  }
  if (/^(and|or|where|with|showing|indicating|corresponding|respectively)\b/i.test(normalized)) {
    return true;
  }
  return false;
}

function buildPageBounds(lines: LineEntry[]): Map<number, { top: number; bottom: number }> {
  const map = new Map<number, { top: number; bottom: number }>();
  for (const line of lines) {
    const existing = map.get(line.page);
    if (!existing) {
      map.set(line.page, { top: line.y, bottom: line.y });
      continue;
    }
    existing.top = Math.max(existing.top, line.y);
    existing.bottom = Math.min(existing.bottom, line.y);
  }
  return map;
}

function isNearPageBottom(line: LineEntry, bounds: { top: number; bottom: number }): boolean {
  const threshold = Math.max(20, line.bbox.h * 2.6);
  return line.y <= bounds.bottom + threshold;
}

function isNearPageTop(line: LineEntry, bounds: { top: number; bottom: number }): boolean {
  const threshold = Math.max(28, line.bbox.h * 3.1);
  return line.y >= bounds.top - threshold;
}

function reorderContinuationByPage(lines: LineEntry[]): LineEntry[] {
  if (lines.length === 0) {
    return [];
  }
  const byPage = new Map<number, LineEntry[]>();
  const pageOrder: number[] = [];
  for (const line of lines) {
    if (!byPage.has(line.page)) {
      byPage.set(line.page, []);
      pageOrder.push(line.page);
    }
    byPage.get(line.page)?.push(line);
  }

  const out: LineEntry[] = [];
  for (const page of pageOrder) {
    const pageLines = byPage.get(page) ?? [];
    out.push(...reorderTwoColumnContinuation(pageLines));
  }
  return out;
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
  const pageBounds = buildPageBounds(lines);
  let skipUntil = -1;

  for (let i = 0; i < lines.length; i += 1) {
    if (i < skipUntil) {
      continue;
    }

    const first = lines[i];
    if (!first) {
      continue;
    }

    const parsed = parseCaptionText(first.text);
    if (!parsed) {
      continue;
    }

    const block: LineEntry[] = [first];
    let prev = first;
    let totalChars = first.text.length;
    for (let j = i + 1; j < lines.length && block.length < 34 && totalChars < 4200; j += 1) {
      const next = lines[j];
      if (!next) {
        break;
      }
      if (parseCaptionText(next.text)) {
        break;
      }
      if (!isCaptionContinuation(next.text)) {
        break;
      }

      if (next.page === prev.page) {
        const verticalGap = Math.abs(prev.y - next.y);
        const dynamicGapLimit = Math.max(22, Math.min(52, Math.max(first.bbox.h, next.bbox.h) * 2.9));
        if (verticalGap > dynamicGapLimit) {
          break;
        }
      } else if (next.page === prev.page + 1) {
        const allowCrossPage = parsed.body.length < 120 || block.length <= 2 || (parsed.quality ?? 0.6) <= 0.65;
        if (!allowCrossPage) {
          break;
        }
        const prevBounds = pageBounds.get(prev.page);
        const nextBounds = pageBounds.get(next.page);
        const canBridge =
          !!prevBounds &&
          !!nextBounds &&
          isNearPageBottom(prev, prevBounds) &&
          isNearPageTop(next, nextBounds) &&
          looksLikeCrossPageContinuation(next.text);
        if (!canBridge) {
          break;
        }
      } else {
        break;
      }

      block.push(next);
      prev = next;
      totalChars += next.text.length;
    }

    const continuationLines = reorderContinuationByPage(block.slice(1));
    const continuation = normalizeInlineText(continuationLines.map((line) => line.text));
    const body = normalizeInlineText([parsed.body, continuation]);
    const label = normalizeLabel(parsed.label);

    const pageLines = byPage.get(first.page) ?? [];
    const blockBounds = unionRects(block.map((line) => line.bbox));
    const pageBound = pageBounds.get(first.page) ?? { top: blockBounds.y + blockBounds.h, bottom: blockBounds.y };
    const isTableLike = /table/i.test(parsed.prefix);
    const layoutRect = inferLayoutRectForCaption(blockBounds, pageLines, block, pageBound, isTableLike);

    captions.push({
      kind: kindFromPrefix(parsed.prefix, label),
      label,
      caption: `${parsed.prefix} ${label}: ${body}`,
      page: first.page,
      bbox: unionRects(block.map((line) => line.bbox)),
      layoutRect: layoutRect ?? undefined,
      quality: parsed.quality,
    });

    skipUntil = i + block.length;
  }

  return mergeCrossPageSameLabelCaptions(captions);
}
