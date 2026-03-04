export type TargetKind = "figure" | "table" | "supplementary";

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
  docReadBinary: (path: string) => Promise<number[]>;
  citationResolve: (docId: string, page: number, x: number, y: number) => Promise<ResolveCitationResponse | null>;
  citationResolveByLabel: (docId: string, kind: TargetKind, label: string) => Promise<ResolveCitationResponse | null>;
  referenceResolve: (docId: string, page: number, x: number, y: number) => Promise<ResolveReferenceResponse | null>;
  referenceGetEntries: (docId: string, indices: number[]) => Promise<ReferenceEntry[]>;
  referenceSearchByText: (docId: string, text: string, limit?: number) => Promise<ReferenceEntry[]>;
  referenceHasEntries: (docId: string) => Promise<boolean>;
  referenceOpenPopup: (payload: { indices: number[]; entries: ReferenceEntry[] }) => Promise<void>;
  translateText: (payload: TranslateTextPayload) => Promise<TranslateTextResponse>;
  translateOpenPopup: (payload: TranslatePopupPayload) => Promise<void>;
  figureGetTarget: (docId: string, targetId: string) => Promise<FigureTargetResponse>;
  figureListTargets: (docId: string, kind: TargetKind, label: string) => Promise<FigureTargetCandidate[]>;
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
