import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractTextSpans } from "@journal-reader/pdf-core";
import { extractCaptions, extractCitations, extractReferenceData, mapCitationsToTargets } from "@journal-reader/parser";
import type { CitationRef, ParsedCaption, ReferenceEntry } from "@journal-reader/types";

type ExpectedCounts = {
  main?: number;
  ref?: number;
  ext?: number;
  sup?: number;
};

type ActualCounts = {
  main: number;
  ref: number;
  ext: number;
  sup: number;
  targets: number;
};

const EXAMPLE_DIR = process.env.EXAMPLE_PDFS_DIR || "/Users/skelviper/Desktop/Example_pdfs";

function parseExpectedCounts(fileName: string): ExpectedCounts {
  const base = fileName.toLowerCase();
  const pick = (pattern: RegExp): number | undefined => {
    const match = base.match(pattern);
    if (!match?.[1]) {
      return undefined;
    }
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : undefined;
  };

  return {
    main: pick(/(\d+)\s*main/),
    ref: pick(/(\d+)\s*ref/),
    ext: pick(/(\d+)\s*ext/),
    sup: pick(/(\d+)\s*sup/),
  };
}

function extractBaseNumber(label: string): number | null {
  const match = label.trim().toUpperCase().match(/^S?(\d+)/);
  if (!match?.[1]) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function isExtendedFigureCaption(item: ParsedCaption): boolean {
  return /^extended\s+data\s+fig(?:ure)?\b/i.test(item.caption);
}

function isTableCaption(item: ParsedCaption): boolean {
  return /(?:^|\s)table\b/i.test(item.caption);
}

function isSupplementaryFigureCaption(item: ParsedCaption): boolean {
  if (item.kind !== "supplementary") {
    return false;
  }
  if (isExtendedFigureCaption(item) || isTableCaption(item)) {
    return false;
  }
  return /^(supplementary\s+)?(?:figure|fig\.?)\b/i.test(item.caption);
}

function uniqueBaseNumberCount(labels: string[]): number {
  const uniq = new Set<number>();
  for (const label of labels) {
    const num = extractBaseNumber(label);
    if (num !== null) {
      uniq.add(num);
    }
  }
  return uniq.size;
}

function densePrefixCount(values: Iterable<number>): number {
  const sorted = [...new Set(values)].filter((value) => value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return 0;
  }
  let prefix = 0;
  for (const value of sorted) {
    if (value === prefix + 1) {
      prefix = value;
      continue;
    }
    if (value > prefix + 1) {
      break;
    }
  }
  return prefix;
}

function inferReferenceCount(entries: ReferenceEntry[]): number {
  const indices = [...new Set(entries.map((item) => item.index))]
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (indices.length === 0) {
    return 0;
  }

  let prefixEnd = indices[indices.length - 1] ?? indices.length;
  for (let i = 0; i < indices.length - 1; i += 1) {
    const current = indices[i] ?? 0;
    const next = indices[i + 1] ?? current;
    const gap = next - current;
    const prefixSize = i + 1;
    const tailSize = indices.length - prefixSize;
    const largeGap = gap >= 8;
    const stablePrefix = current >= 15;
    const tailLooksLikeOutliers = tailSize <= Math.max(4, Math.floor(prefixSize * 0.2));
    if (largeGap && stablePrefix && tailLooksLikeOutliers) {
      prefixEnd = current;
      break;
    }
  }

  return prefixEnd;
}

function calcActualCounts(
  captions: ReturnType<typeof extractCaptions>,
  citations: CitationRef[],
  references: ReturnType<typeof extractReferenceData>,
  targetCount: number,
): ActualCounts {
  const main = uniqueBaseNumberCount(captions.filter((item) => item.kind === "figure").map((item) => item.label));
  const ext = uniqueBaseNumberCount(captions.filter(isExtendedFigureCaption).map((item) => item.label));

  const supFromCaptionDense = densePrefixCount(
    captions.filter(isSupplementaryFigureCaption).map((item) => extractBaseNumber(item.label)).filter((value): value is number => value !== null),
  );
  const supFromCitationDense = densePrefixCount(
    citations
      .filter((item) => item.kind === "supplementary" && !/\btable\b/i.test(item.text))
      .map((item) => extractBaseNumber(item.label))
      .filter((value): value is number => value !== null),
  );
  const sup = Math.max(supFromCaptionDense, supFromCitationDense);

  const ref = inferReferenceCount(references.entries);

  return {
    main,
    ref,
    ext,
    sup,
    targets: targetCount,
  };
}

function collectMismatches(fileName: string, expected: ExpectedCounts, actual: ActualCounts): string[] {
  const out: string[] = [];
  if (expected.main !== undefined && actual.main !== expected.main) {
    out.push(`${fileName}: main expected ${expected.main}, got ${actual.main}`);
  }
  if (expected.ref !== undefined && actual.ref !== expected.ref) {
    out.push(`${fileName}: ref expected ${expected.ref}, got ${actual.ref}`);
  }
  if (expected.ext !== undefined && actual.ext !== expected.ext) {
    out.push(`${fileName}: ext expected ${expected.ext}, got ${actual.ext}`);
  }
  if (expected.sup !== undefined && actual.sup !== expected.sup) {
    out.push(`${fileName}: sup expected ${expected.sup}, got ${actual.sup}`);
  }
  return out;
}

describe("layout-first parse on Example_pdfs", () => {
  it(
    "matches filename-declared counts for all sample PDFs",
    async () => {
      if (!existsSync(EXAMPLE_DIR)) {
        throw new Error(`Example pdf folder not found: ${EXAMPLE_DIR}`);
      }
      const files = readdirSync(EXAMPLE_DIR)
        .filter((name) => name.toLowerCase().endsWith(".pdf"))
        .sort((a, b) => a.localeCompare(b));
      expect(files.length).toBeGreaterThan(0);

      const summary: Array<Record<string, string | number>> = [];
      const mismatches: string[] = [];

      for (const file of files) {
        const path = join(EXAMPLE_DIR, file);
        const docId = `example:${file}`;
        const spans = await extractTextSpans(path);
        const citations = extractCitations(spans, docId);
        const captions = extractCaptions(spans);
        const references = extractReferenceData(spans, docId);
        const mapped = mapCitationsToTargets(docId, citations, captions, []);
        const expected = parseExpectedCounts(file);
        const actual = calcActualCounts(captions, citations, references, mapped.targets.length);

        summary.push({
          file,
          expected_main: expected.main ?? "-",
          actual_main: actual.main,
          expected_ref: expected.ref ?? "-",
          actual_ref: actual.ref,
          expected_ext: expected.ext ?? "-",
          actual_ext: actual.ext,
          expected_sup: expected.sup ?? "-",
          actual_sup: actual.sup,
          targets: actual.targets,
        });

        mismatches.push(...collectMismatches(file, expected, actual));
      }

      console.table(summary);
      expect(mismatches, mismatches.join("\n")).toHaveLength(0);
    },
    10 * 60 * 1000,
  );
});
