import type { Rect } from "@journal-reader/types";

function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildTargetPreviewDataUrl(caption: string, page: number, rect: Rect): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="420">
<defs>
  <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
    <stop offset="0%" stop-color="#f4f7ff"/>
    <stop offset="100%" stop-color="#edf2f8"/>
  </linearGradient>
</defs>
<rect width="100%" height="100%" fill="url(#g)" />
<rect x="48" y="48" width="624" height="260" fill="#ffffff" stroke="#2f4b73" stroke-width="2" rx="8"/>
<text x="60" y="90" font-size="18" font-family="Menlo, monospace" fill="#17324d">Preview Placeholder</text>
<text x="60" y="120" font-size="14" font-family="Menlo, monospace" fill="#2d4e6d">Page: ${page}</text>
<text x="60" y="145" font-size="14" font-family="Menlo, monospace" fill="#2d4e6d">Rect: (${rect.x.toFixed(
    1,
  )}, ${rect.y.toFixed(1)}, ${rect.w.toFixed(1)}, ${rect.h.toFixed(1)})</text>
<foreignObject x="60" y="170" width="600" height="120">
  <div xmlns="http://www.w3.org/1999/xhtml" style="font-family: Helvetica, Arial, sans-serif; font-size: 14px; color: #153047; line-height: 1.3;">
    ${escapeXml(caption)}
  </div>
</foreignObject>
</svg>`;

  const encoded = Buffer.from(svg, "utf-8").toString("base64");
  return `data:image/svg+xml;base64,${encoded}`;
}
