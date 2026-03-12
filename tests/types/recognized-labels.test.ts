import { describe, expect, it } from "vitest";
import {
  buildRecognizedDisplayLabel,
  buildRecognizedGroupKey,
  inferRecognizedDisplayFamily,
} from "@journal-reader/types";

describe("recognized display normalization", () => {
  it("normalizes panel labels to main figure label for display", () => {
    expect(buildRecognizedDisplayLabel("figure", "1B", "Figure 1: main caption")).toBe("Fig. 1");
    expect(buildRecognizedDisplayLabel("figure", "2G", "Fig. 2: caption")).toBe("Fig. 2");
  });

  it("keeps supplementary families separated for figure/table", () => {
    expect(
      buildRecognizedDisplayLabel("supplementary", "S1D", "Supplementary Fig. S1: extra panels"),
    ).toBe("Supplementary Fig. S1");
    expect(
      buildRecognizedDisplayLabel("supplementary", "S1", "Supplementary Table S1: statistics"),
    ).toBe("Supplementary Table S1");
  });

  it("keeps extended data families separated from main figure", () => {
    expect(
      buildRecognizedDisplayLabel("supplementary", "1A", "Extended Data Fig. 1: control"),
    ).toBe("Extended Data Fig. 1");
    expect(buildRecognizedDisplayLabel("figure", "1A", "Figure 1: main")).toBe("Fig. 1");
  });

  it("builds stable group keys by family + base label", () => {
    expect(buildRecognizedGroupKey("figure", "1B", "Figure 1")).toBe("figure:1");
    expect(buildRecognizedGroupKey("supplementary", "S1A", "Supplementary Fig. S1")).toBe(
      "supplementary-figure:S1",
    );
    expect(buildRecognizedGroupKey("supplementary", "1A", "Extended Data Fig. 1")).toBe(
      "extended-data-figure:1",
    );
  });

  it("infers display family with explicit text cues", () => {
    expect(inferRecognizedDisplayFamily("supplementary", "Supplementary Table S3")).toBe("supplementary-table");
    expect(inferRecognizedDisplayFamily("supplementary", "Extended Data Fig. 4")).toBe("extended-data-figure");
    expect(inferRecognizedDisplayFamily("table", "Table 2")).toBe("table");
  });
});
