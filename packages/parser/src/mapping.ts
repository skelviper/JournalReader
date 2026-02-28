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
  const citationsToTarget = new Map<string, string>();
  const unresolvedCitationIds: string[] = [];

  for (const citation of citations) {
    const citationLabel = citation.label.toUpperCase();
    const citationBase = baseLabel(citationLabel);
    const manualMatch = existingManualTargets.find(
      (target) =>
        target.kind === citation.kind &&
        (target.label.toUpperCase() === citationLabel || baseLabel(target.label) === citationBase),
    );
    if (manualMatch) {
      citationsToTarget.set(citation.id, manualMatch.id);
      continue;
    }

    let matchedCaptions = captionIdx.get(key(citation.kind, citation.label)) ?? [];
    if (matchedCaptions.length === 0 && citationBase !== citationLabel) {
      matchedCaptions = captionIdx.get(key(citation.kind, citationBase)) ?? [];
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

    const existingAuto = targets.find(
      (target) =>
        target.source === "auto" &&
        target.kind === citation.kind &&
        target.label.toUpperCase() === best.label.toUpperCase() &&
        target.page === best.page,
    );

    if (existingAuto) {
      citationsToTarget.set(citation.id, existingAuto.id);
      continue;
    }

    const target: VisualTarget = {
      id: randomUUID(),
      docId,
      kind: citation.kind,
      label: best.label,
      page: best.page,
      cropRect: guessCropRect(best.bbox, citation.kind),
      captionRect: best.bbox,
      caption: best.caption,
      confidence: bestScore,
      source: "auto",
    };

    targets.push(target);
    citationsToTarget.set(citation.id, target.id);
  }

  return {
    targets,
    citationsToTarget,
    unresolvedCitationIds,
  };
}

export type { MapResult };
