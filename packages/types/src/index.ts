export type TargetKind = "figure" | "table" | "supplementary";
export type RecognizedDisplayFamily =
  | "figure"
  | "table"
  | "extended-data-figure"
  | "extended-data-table"
  | "supplementary-figure"
  | "supplementary-table";

export type Rect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type CitationRef = {
  id: string;
  docId: string;
  page: number;
  text: string;
  kind: TargetKind;
  label: string;
  bbox: Rect;
};

export type VisualTarget = {
  id: string;
  docId: string;
  kind: TargetKind;
  label: string;
  page: number;
  captionPage?: number;
  cropRect: Rect;
  captionRect?: Rect;
  caption: string;
  confidence: number;
  source: "auto" | "manual";
};

export type AnnotationKind = "highlight" | "text-note" | "sticky-note";

export type NoteTextStyle = {
  fontSize?: number;
  fontFamily?: string;
  textColor?: string;
};

export type AnnotationItem = {
  id: string;
  docId: string;
  page: number;
  kind: AnnotationKind;
  rects: Rect[];
  text?: string;
  color?: string;
  style?: NoteTextStyle;
  createdAt: string;
  updatedAt: string;
};

export type CreateAnnotationPayload = Omit<AnnotationItem, "id" | "createdAt" | "updatedAt"> & { id?: string };
export type UpdateAnnotationPayload = Partial<Omit<AnnotationItem, "createdAt" | "updatedAt">> & { id: string };

export type OpenDocResponse = {
  docId: string;
  pageCount: number;
  title: string;
};

export type ParseDocResponse = {
  status: "ok" | "failed";
  refsCount: number;
  figuresCount: number;
  tablesCount: number;
  extCount: number;
  suppCount: number;
};

export type ResolveCitationResponse = {
  targetId: string | null;
  kind: TargetKind;
  label: string;
  citationId?: string;
};

export type InTextReferenceMarker = {
  id: string;
  docId: string;
  page: number;
  text: string;
  indices: number[];
  bbox: Rect;
};

export type ReferenceEntry = {
  docId: string;
  index: number;
  text: string;
  page: number;
};

export type ResolveReferenceResponse = {
  markerId: string;
  indices: number[];
};

export type FigureTargetResponse = {
  page: number;
  captionPage?: number;
  cropRect: Rect;
  captionRect?: Rect;
  caption: string;
  imageDataUrl: string;
};

export type FigureTargetCandidate = {
  id: string;
  docId: string;
  kind: TargetKind;
  label: string;
  page: number;
  captionPage?: number;
  cropRect: Rect;
  captionRect?: Rect;
  caption: string;
  confidence: number;
  source: "auto" | "manual";
};

export type FigurePopupPayload = {
  docId: string;
  targetId: string;
  page: number;
  captionPage?: number;
  pageRect?: Rect;
  focusRect?: Rect;
  captionRect?: Rect;
  caption: string;
  pageImageDataUrl?: string;
  imageDataUrl: string;
};

export type OutlineNode = {
  id: string;
  title: string;
  page: number;
  depth: number;
  source: "native" | "heuristic";
  y?: number;
};

export type TranslateProvider = "google" | "libre" | "mymemory";

export type TranslateTextPayload = {
  text: string;
  sourceLang: string;
  targetLang: string;
  provider: TranslateProvider;
};

export type TranslateTextResponse = {
  provider: TranslateProvider;
  sourceLang: string;
  targetLang: string;
  detectedSourceLang?: string;
  translatedText: string;
};

export type TranslatePopupPayload = {
  sourceText: string;
  translatedText: string;
  provider: TranslateProvider;
  sourceLang: string;
  targetLang: string;
  detectedSourceLang?: string;
};

export type RecognizedPopupKind = "ref" | "fig" | "table" | "ext" | "supp";

export type CaptionSyncHighlightsPayload = {
  docId: string;
  targetId: string;
  page: number;
  captionRect: Rect;
  snippets: string[];
};

export type CaptionGetLinkedSnippetsPayload = {
  docId: string;
  targetId: string;
  page: number;
  captionRect: Rect;
};

export type CaptionGetLinkedSnippetsResponse = {
  linkedSnippets: string[];
  articleSnippets: string[];
};

export type AnnotationChangedEvent = {
  docId: string;
  ts: number;
};

export type SavePdfResponse = {
  saved: boolean;
  backupPath: string;
  overwrittenPath: string;
};

export type BindManuallyResponse = {
  ok: boolean;
  targetId: string;
};

export type JournalApi = {
  openExternal: (url: string) => Promise<boolean>;
  resolveDroppedFilePath: (file: File) => string | null;
  docPick: () => Promise<string | null>;
  onMenuFileOpen: (handler: (path: string) => void) => () => void;
  onAnnotationChanged: (handler: (event: AnnotationChangedEvent) => void) => () => void;
  docOpen: (path: string) => Promise<OpenDocResponse>;
  docParse: (docId: string) => Promise<ParseDocResponse>;
  docGetOutline: (docId: string) => Promise<OutlineNode[]>;
  docReadBinary: (path: string) => Promise<number[]>;
  citationResolve: (docId: string, page: number, x: number, y: number) => Promise<ResolveCitationResponse | null>;
  citationResolveByLabel: (
    docId: string,
    kind: TargetKind,
    label: string,
    familyHint?: RecognizedDisplayFamily,
  ) => Promise<ResolveCitationResponse | null>;
  referenceResolve: (docId: string, page: number, x: number, y: number) => Promise<ResolveReferenceResponse | null>;
  referenceGetEntries: (docId: string, indices: number[]) => Promise<ReferenceEntry[]>;
  referenceSearchByText: (docId: string, text: string, limit?: number) => Promise<ReferenceEntry[]>;
  referenceHasEntries: (docId: string) => Promise<boolean>;
  referenceOpenPopup: (payload: { indices: number[]; entries: ReferenceEntry[] }) => Promise<void>;
  translateText: (payload: TranslateTextPayload) => Promise<TranslateTextResponse>;
  translateOpenPopup: (payload: TranslatePopupPayload) => Promise<void>;
  figureGetTarget: (docId: string, targetId: string) => Promise<FigureTargetResponse>;
  figureListTargets: (
    docId: string,
    kind: TargetKind,
    label: string,
    familyHint?: RecognizedDisplayFamily,
  ) => Promise<FigureTargetCandidate[]>;
  figureOpenPopup: (payload: FigurePopupPayload) => Promise<void>;
  recognizedOpenPopup: (docId: string, kind: RecognizedPopupKind) => Promise<boolean>;
  annotationCreate: (payload: CreateAnnotationPayload) => Promise<AnnotationItem>;
  annotationUpdate: (payload: UpdateAnnotationPayload) => Promise<AnnotationItem | null>;
  annotationDelete: (id: string) => Promise<boolean>;
  annotationList: (docId: string) => Promise<AnnotationItem[]>;
  annotationReloadFromPdf: (docId: string) => Promise<AnnotationItem[]>;
  captionSyncHighlights: (payload: CaptionSyncHighlightsPayload) => Promise<void>;
  captionGetLinkedSnippets: (payload: CaptionGetLinkedSnippetsPayload) => Promise<CaptionGetLinkedSnippetsResponse>;
  annotationSaveToPdf: (docId: string) => Promise<SavePdfResponse>;
  mappingBindManually: (
    docId: string,
    citationId: string,
    targetRect: Rect,
    captionText: string,
    targetPage?: number,
  ) => Promise<BindManuallyResponse>;
};

export type ParsedTextSpan = {
  text: string;
  page: number;
  bbox: Rect;
};

export type ParsedCaption = {
  kind: TargetKind;
  label: string;
  caption: string;
  page: number;
  bbox: Rect;
  layoutRect?: Rect;
  quality?: number;
};

export function normalizeTargetLabel(label: string): string {
  return label.trim().toUpperCase();
}

export function baseTargetLabel(label: string): string {
  const normalized = normalizeTargetLabel(label);
  const match = normalized.match(/^(S?\d+)/);
  return match ? match[1] : normalized;
}

export function isExtendedDataText(text: string | undefined): boolean {
  return /^\s*extended\s+data\s+/i.test(text ?? "");
}

export function inferSupplementaryDisplayFamily(text: string | undefined): "figure" | "table" {
  return /\btable\b/i.test(text ?? "") ? "table" : "figure";
}

export function inferRecognizedDisplayFamily(kind: TargetKind, text?: string): RecognizedDisplayFamily {
  if (kind === "figure") {
    return "figure";
  }
  if (kind === "table") {
    return "table";
  }
  const subkind = inferSupplementaryDisplayFamily(text);
  if (isExtendedDataText(text)) {
    return subkind === "table" ? "extended-data-table" : "extended-data-figure";
  }
  return subkind === "table" ? "supplementary-table" : "supplementary-figure";
}

export function buildRecognizedDisplayLabel(kind: TargetKind, label: string, text?: string): string {
  const base = baseTargetLabel(label);
  const family = inferRecognizedDisplayFamily(kind, text);
  if (family === "figure") {
    return `Fig. ${base}`;
  }
  if (family === "table") {
    return `Table ${base}`;
  }
  if (family === "extended-data-table") {
    return `Extended Data Table ${base}`;
  }
  if (family === "extended-data-figure") {
    return `Extended Data Fig. ${base}`;
  }
  if (family === "supplementary-table") {
    return `Supplementary Table ${base}`;
  }
  return `Supplementary Fig. ${base}`;
}

export function buildRecognizedGroupKey(kind: TargetKind, label: string, text?: string): string {
  return `${inferRecognizedDisplayFamily(kind, text)}:${baseTargetLabel(label)}`;
}
