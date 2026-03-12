import { randomUUID } from "node:crypto";
import type { CitationRef, ParsedCaption, Rect, VisualTarget } from "@journal-reader/types";

type MapResult = {
  targets: VisualTarget[];
  citationsToTarget: Map<string, string>;
  unresolvedCitationIds: string[];
};

function key(kind: string, label: string): string {
  return `${kind}:${label.toUpperCase()}`;
}

function baseLabel(label: string): string {
  const normalized = label.toUpperCase().trim();
  const match = normalized.match(/^(S?\d+)/);
  return match ? match[1] : normalized;
}

function distanceScore(citationPage: number, captionPage: number): number {
  const delta = Math.abs(citationPage - captionPage);
  return 1 / (1 + delta);
}

function guessCropRect(captionRect: Rect, kind: VisualTarget["kind"]): Rect {
  const width = Math.max(320, captionRect.w + 320);
  const height = 280;

  if (kind === "table") {
    // Tables are often rendered below the caption line.
    return {
      x: Math.max(0, captionRect.x - 40),
      y: Math.max(0, captionRect.y - height - 12),
      w: width,
      h: height,
    };
  }

  // Figures are typically placed above their caption line.
  return {
    x: Math.max(0, captionRect.x - 40),
    y: Math.max(0, captionRect.y + captionRect.h + 12),
    w: width,
    h: height,
  };
}

function captionTargetKey(kind: string, label: string, page: number): string {
  return `${kind}:${baseLabel(label)}:${page}`;
}

export function mapCitationsToTargets(
  docId: string,
  citations: CitationRef[],
  captions: ParsedCaption[],
  existingManualTargets: VisualTarget[] = [],
): MapResult {
  const captionIdx = new Map<string, ParsedCaption[]>();
  for (const caption of captions) {
    const k = key(caption.kind, caption.label);
    const row = captionIdx.get(k) ?? [];
    row.push(caption);
    captionIdx.set(k, row);
  }

  const targets: VisualTarget[] = [...existingManualTargets];
  const autoTargetByCaption = new Map<string, VisualTarget>();

  const pickedCaptionsByBase = new Map<string, ParsedCaption>();
  for (const caption of captions) {
    const dedupeKey = captionTargetKey(caption.kind, caption.label, caption.page);
    const prev = pickedCaptionsByBase.get(dedupeKey);
    if (!prev) {
      pickedCaptionsByBase.set(dedupeKey, caption);
      continue;
    }
    const prevBaseExact = baseLabel(prev.label) === prev.label.toUpperCase();
    const nextBaseExact = baseLabel(caption.label) === caption.label.toUpperCase();
    if (nextBaseExact && !prevBaseExact) {
      pickedCaptionsByBase.set(dedupeKey, caption);
      continue;
    }
    if ((caption.quality ?? 0.7) > (prev.quality ?? 0.7)) {
      pickedCaptionsByBase.set(dedupeKey, caption);
    }
  }

  for (const caption of pickedCaptionsByBase.values()) {
    const target: VisualTarget = {
      id: randomUUID(),
      docId,
      kind: caption.kind,
      label: caption.label,
      page: caption.page,
      captionPage: caption.page,
      cropRect: caption.layoutRect ?? guessCropRect(caption.bbox, caption.kind),
      captionRect: caption.bbox,
      caption: caption.caption,
      confidence: caption.quality ?? 0.7,
      source: "auto",
    };
    targets.push(target);
    autoTargetByCaption.set(captionTargetKey(caption.kind, caption.label, caption.page), target);
  }

  const citationsToTarget = new Map<string, string>();
  const unresolvedCitationIds: string[] = [];

  for (const citation of citations) {
    const citationLabel = citation.label.toUpperCase();
    const citationBase = baseLabel(citationLabel);
    const hasSubfigureSuffix = citationBase !== citationLabel;
    const manualMatch = existingManualTargets.find(
      (target) =>
        target.kind === citation.kind &&
        (target.label.toUpperCase() === citationLabel || baseLabel(target.label) === citationBase),
    );
    if (manualMatch) {
      citationsToTarget.set(citation.id, manualMatch.id);
      continue;
    }

    const exactCaptions = captionIdx.get(key(citation.kind, citation.label)) ?? [];
    const baseCaptions = hasSubfigureSuffix ? (captionIdx.get(key(citation.kind, citationBase)) ?? []) : [];
    let matchedCaptions = exactCaptions;
    // For "Fig. 1a"/"1b" references, users expect to open the whole figure panel.
    // Prefer the base caption (Fig. 1) when it exists; fall back to exact label otherwise.
    if (hasSubfigureSuffix && baseCaptions.length > 0) {
      matchedCaptions = baseCaptions;
    } else if (matchedCaptions.length === 0 && baseCaptions.length > 0) {
      matchedCaptions = baseCaptions;
    }
    if (matchedCaptions.length === 0) {
      unresolvedCitationIds.push(citation.id);
      continue;
    }

    let best = matchedCaptions[0];
    let bestScore = distanceScore(citation.page, best.page) * (best.quality ?? 0.8);
    for (const cand of matchedCaptions.slice(1)) {
      const score = distanceScore(citation.page, cand.page) * (cand.quality ?? 0.8);
      if (score > bestScore) {
        best = cand;
        bestScore = score;
      }
    }

    const existingAuto = autoTargetByCaption.get(captionTargetKey(best.kind, best.label, best.page));

    if (existingAuto?.id) {
      citationsToTarget.set(citation.id, existingAuto.id);
      continue;
    }
    unresolvedCitationIds.push(citation.id);
  }

  return {
    targets,
    citationsToTarget,
    unresolvedCitationIds,
  };
}

export type { MapResult };
