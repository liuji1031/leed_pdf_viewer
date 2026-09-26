# Research-paper chat assistant for LeedPDF

## Context

LeedPDF today is an annotation-first PDF viewer: freehand ink, text boxes, sticky notes, stamps, arrows, images. It has **no text layer at all** — `extractTextFromCurrentPage()` ([PDFViewer.svelte:306-360](src/lib/components/PDFViewer.svelte#L306-L360)) flattens `getTextContent()` into a plaintext blob and throws away every glyph coordinate, so nothing in the app can point at a specific phrase on the page.

The goal is to turn it into a research-paper reading tool: select a term or sentence, ask an LLM about it in a side panel, and have that conversation stay permanently anchored to the passage that prompted it. Months later, the highlighted phrase is the index into your own thinking — double-click it and the chat jumps back to that conversation; hover it and a one-line summary appears without leaving the page.

Three things have to be built that don't exist yet: a real pdf.js text layer with working mouse selection (the pointer/gesture layer was recently rewritten in `0af3c1f` specifically to fix stylus drawing and trackpad pinch-zoom, and must not regress), a durable anchor format that survives zoom/rotation/reload, and a chat subsystem with its own storage.

**Decisions already made:** docked resizable right column; one new dependency for streaming markdown; user-supplied OpenRouter key in localStorage called directly from the browser (`src-tauri/tauri.conf.json` has `"csp": null`, so the Tauri desktop build is unblocked); incremental `feat:` commits on `feature/chat-interface`.

---

## Architecture

New files:

| File | Role |
|---|---|
| `src/lib/utils/textAnchor.ts` | Pure geometry/offset maths. `Range` → durable anchor, and back. |
| `src/lib/components/PDFTextLayer.svelte` | Owns one pdf.js `TextLayer` instance. |
| `src/lib/components/ChatHighlightOverlay.svelte` | Renders anchored highlight rects; hover/dblclick hit-testing. |
| `src/lib/components/ChatHighlightCard.svelte` | Hover summary card. |
| `src/lib/utils/chatStorage.ts` | IndexedDB `LeedPDFChat` v1 (sessions + messages + parsed documents). |
| `src/lib/services/docParser/{types,minerULocal,minerUCloud,blockLookup}.ts` | MinerU backends + selection→block lookup (§5a). |
| `src/lib/services/parseQueue.ts` | Background parse jobs started on PDF open (§5a). |
| `src/lib/services/contextBuilder.ts` | Tiered token-budgeted prompt assembly (§5a). |
| `src/lib/services/openRouter.ts` | Streaming SSE client. |
| `src/lib/services/summaryScheduler.ts` | Module singleton; the summary state machine. |
| `src/lib/stores/chatStore.ts` | `chatSessions`, `chatMessages`, `activeSessionId`, `pendingSelection`. |
| `src/lib/stores/settingsStore.ts` | The repo's first prefs store (API key, endpoint, model, timings). |
| `src/lib/components/ChatPanel.svelte` + `ChatMessage.svelte` + `ChatComposer.svelte` | Panel shell. |
| `src/lib/components/SettingsModal.svelte` | Modeled on `CompressionSettingsModal.svelte`. |
| `Dockerfile`, `.dockerignore`, `Caddyfile`, `docker-compose{,.dev,.test,.gpu}.yml` | Containerised dev/test/deploy (§7). |

Heavily modified: [PDFViewer.svelte](src/lib/components/PDFViewer.svelte), [drawingStore.ts](src/lib/stores/drawingStore.ts), [Toolbar.svelte](src/lib/components/Toolbar.svelte), and the four route shells.

---

## 1. Text layer, gated on a new `'ask'` tool

Add `'ask'` to the `DrawingTool` union ([drawingStore.ts:5](src/lib/stores/drawingStore.ts#L5)). Gating on a tool (rather than always-on) means every existing pointer code path stays byte-identical when `tool !== 'ask'` — that is the regression defence. Do **not** overload the existing `'select'` tool; it drives `TextSelectionOverlay` and would give one tool two UIs.

`PDFTextLayer.svelte` mounts inside the existing `<div class="relative">` wrapper (PDFViewer.svelte:3196), sized to `canvasDisplayWidth/Height`:

```svelte
<div bind:this={containerEl} class="leed-text-layer" class:interactive
     style="width:{width}px;height:{height}px;--scale-factor:{scale};--total-scale-factor:{scale};"></div>
```

- Rebuild on **pageNumber** or **rotation** change (`layer.cancel()` + `replaceChildren()` first).
- **Do not rebuild on scale** — pdf.js ≥4 emits span geometry as `calc(var(--scale-factor) * Npx)`, so a zoom commit is a CSS-variable update. Set both variable names; the 4.x→5.x rename means one of them is live and the other is inert.
- **Do nothing during live pinch/wheel** — the layer is a child of `contentWrapperDiv`, so the wrapper's CSS `scale()` carries it along with the canvas.
- Vendor only the `.textLayer` rules from `pdfjs-dist/web/pdf_viewer.css` into a `:global()` block. Importing the whole file leaks annotation-layer and page-container styles into the app.

**Z-index: touch no existing overlay.** The actual current values are not a clean ladder — ArrowOverlay 3, LinkOverlay 3, TextOverlay 4, StampOverlay 8, ImageOverlay 9, StickyNoteOverlay 10 — so "bump everything by one" would mean editing six working components for no benefit. Instead:

- `PDFTextLayer` is **mounted only when `tool === 'ask'`** (`{#if askModeActive}`), at `z-index: 11`, above everything. When the tool isn't active it is not in the DOM at all.
- `ChatHighlightOverlay` sits at `z-index: 3` with `pointer-events: none` **unconditionally**, so it cannot intercept input from any existing overlay regardless of stacking.

Consequence, and it's the right trade: while in ask mode the text layer covers the sticky notes and text boxes, so they aren't clickable. That is exactly how a modal tool should behave (eraser mode is no different), it is instantly reversible by switching tools, and it costs zero edits to existing components.

### Unblocking mouse selection — five surgical edits

Mirror the tool into a plain variable, because listeners are registered once in `onMount` and must read state at call time:

```ts
let askModeActive = false;
$: askModeActive = $drawingState.tool === 'ask';
```

1. `drawingCanvas` (PDFViewer.svelte:3205-3212) gets `class:pointer-events-none={askModeActive}`. This alone neutralises the `setPointerCapture` (:896) and `preventDefault()` (:894) blockers — they are simply never reached.
2. `contextmenu` (:839-840): replace the two inline arrows with a named handler that returns early when `askModeActive && e.target.closest('.leed-text-layer')`, enabling native right-click → Copy.
3. `handleContainerPointerDown` (:1171): add one early return **before** the pen guard, narrowly scoped so the touch and pen branches are untouched:
   ```ts
   if (askModeActive && event.pointerType === 'mouse' && !event.ctrlKey &&
       (event.target as HTMLElement)?.closest?.('.leed-text-layer')) return;
   ```
4. `goToPage` and the `askModeActive → false` transition call `window.getSelection()?.removeAllRanges()`.
5. **Leave `touch-action: none` (:3371) and `handleWheel` (:1596) alone.** v1 is mouse/trackpad selection only; `touch-action` does not affect mouse input, and touching it is precisely where the pinch regression would come from.

---

## 2. Durable anchors — `src/lib/utils/textAnchor.ts`

```ts
export interface NormRect { x: number; y: number; w: number; h: number }   // rotation-0, 0..1

export interface TextAnchor {
  pageNumber: number;
  text: string;                    // selected string, whitespace-collapsed
  charStart: number; charEnd: number;   // offsets into the page's canonical text
  itemStart: number; itemEnd: number;   // coarse fallback
  prefix: string; suffix: string;       // <=48 chars of context each
  textHash: string;
}
```

**Testability seam (required, not optional):** jsdom returns all-zero rects from `Range.getClientRects()`, so the geometry maths must not take a live `Range`. Split it:

```ts
export function rangeToClientRects(range: Range): DOMRect[];            // DOM-touching, thin, untested
export function clientRectsToNormRects(                                 // pure, fully unit-tested
  rects: RectLike[], base: RectLike,
  rotation: RotationAngle, basePageWidth: number, basePageHeight: number
): NormRect[];
```

The same applies to `rangeToAnchor` — the offset logic takes `(startItemIdx, startOffset, endItemIdx, endOffset, idx)` as a pure inner function, with a thin DOM wrapper that resolves the endpoints. Nearly all the risk lives in the pure halves.

**Range → rects** (`clientRectsToNormRects`):
1. Take the caller's rects, drop zero-area.
2. Coalesce per line: bucket by `Math.round(top)` ±2px with near-equal height, merge neighbours whose horizontal gap is `< 0.35 * height`. Collapses a 200-span paragraph to 3-5 rects. Cap at 200 rects.
3. Normalise against `layerEl.getBoundingClientRect()` — **not** by dividing by `$pdfState.scale`. The element rect already folds in scale, DPR, the live pinch transform and the pan translate, so there is nothing to drift.
4. De-rotate: convert the two opposite corners to display px using `getRotatedDimensions`, push each through `inverseTransformPoint` ([rotationUtils.ts](src/lib/utils/rotationUtils.ts)), then rebuild an axis-aligned rect from min/max (required because 90/270 swap which edge is which) and normalise by `basePageWidth/Height`.

Rendering is the exact inverse via `transformPoint`. **Write a vitest round-trip across all four rotations and two scales as the first commit** — this is the riskiest maths in the feature.

**Range → offsets** (`buildPageTextIndex` / `rangeToAnchor`): build the index from `layer.textDivs` + `layer.textContentItemsStr` (index-aligned, already DOM-filtered), not from a parallel `getTextContent()` call. Walk each endpoint up to its indexed span; if an endpoint lands on an element node (the `.endOfContent` sentinel, or a gap between spans) snap to the nearest span with a `TreeWalker`. Swap for backwards drags. Return `null` on failure — the caller falls back to `String(selection)` with `charStart = -1`, which still yields a usable geometry-only anchor.

**Selections cannot span pages** (one page rendered at a time, layer destroyed on flip). So `pageNumber` is a scalar everywhere, and no text index is needed at load time since rects are persisted.

**Capture eagerly** on the `pointerup` ending the drag (plus a 150ms `selectionchange` debounce for Shift+arrow), into `pendingSelection`. By the time a zoom commit destroys the DOM, the anchor is already pure data; the floating "Ask about this" chip positions from stored rects, reusing the viewport-collision logic in [Tooltip.svelte](src/lib/components/Tooltip.svelte).

---

## 3. `ChatHighlight` annotation

New interface in `drawingStore.ts`, wired with the **existing generics** — `createAnnotationLoader` (:339), `setupAnnotationAutoSave` (:374), `createAnnotationCRUD` (:404), plus a `currentPageChatHighlights` derived store:

```ts
export interface ChatHighlight {
  id: string; pageNumber: number; sessionId: string;
  rects: NormRect[]; anchor: TextAnchor;
  color: string; createdAt: number; ordinal: number;
  x: number; y: number;                                    // bbox, rotation-0 px
  relativeX: number; relativeY: number;                    // authoritative for export
  relativeWidth: number; relativeHeight: number;
  summaryStatus: 'none'|'pending'|'ready'|'failed';        // denormalised for sync hover
  summary?: string; messageCount?: number;
}
```

Highlights stay in **localStorage** with the other annotations (~400 B each; must load synchronously with the page). Only transcripts go to IndexedDB.

**Overlay pointer-events are `none`, unconditionally.** Hover and dblclick are JS hit-tests (`mousemove` passive + `dblclick` on the page wrapper, normalised the same scale-free way, linear scan over tens of rects, 120ms enter delay mirroring `Tooltip.svelte`). Neither listener calls `preventDefault`/`stopPropagation`, and `MouseEvent` listeners cannot disturb the `PointerEvent` gesture pipeline — so drawing over a highlight, pinching over one, and re-selecting text under one all work with zero special cases.

Visual identity vs the freehand `highlight` ink: tight text-metric rect, `background: rgb(99 102 241 / 0.16)`, `border-bottom: 2px solid`, `mix-blend-mode: multiply` (`screen` in dark), plus a 14px circular `ordinal` chip on the last rect. Underline + chip reads as "linked", not "marked up".

### Call sites touched — additive only

`drawingStore.ts`: `DrawingTool` union `:5` (append `'ask'`); `setCurrentPDF` `:469-475` and the load-on-init block `:497-513` (one extra loader call); `forceSaveAllAnnotations` `:903` (one extra `forceSaveStore`). Every one of these is an append next to six identical siblings.

**Deliberately NOT touched** (see the Isolation section below for why each is safe to leave alone): `clearCurrentPageDrawings` `:731`, `clearAllDrawings` `:776`, `isDrawingTool` in `lpdfExport.ts:28`, `pdfExport.ts`, and the `.lpdf` schema.

**Explicit non-goal for v1: nothing chat-related is exported.** Not to PDF, not to `.lpdf`. Transcripts can contain private prompts and are orders of magnitude larger than annotations, and keeping export untouched means the existing export paths carry zero new risk. Highlights-in-export is a follow-up behind an opt-in flag once the core feature is proven.

---

## 3a. Isolation from existing annotation features

**Requirement: existing annotation behaviour must not change.** Audit of every point of contact, and what keeps it inert:

| Contact point | Why existing behaviour is unchanged |
|---|---|
| `DrawingTool` union gains `'ask'` | Verified: there is **no exhaustive `switch`** on `DrawingTool` anywhere in `src/`. Both dispatch sites are allowlist-based — the reactive block at PDFViewer.svelte:275-287 uses `['text','note','stamp','arrow'].includes(...)` / `['pencil','eraser','highlight'].includes(...)`, and `hasActiveFreehandTool()` (:1167) likewise. An unrecognised tool falls through to a no-op, which is exactly what's wanted. |
| `drawingCanvas` gets `pointer-events: none` | Applied **only** when `tool === 'ask'`. Every existing tool leaves the class off, so the canvas, its `setPointerCapture`, and its `preventDefault` behave bit-for-bit as today. |
| `handleContainerPointerDown` early return | Guarded by `askModeActive && pointerType === 'mouse' && !ctrlKey && target.closest('.leed-text-layer')`. The `'pen'` and `'touch'` branches — the ones `0af3c1f` fixed — are not reached and not edited. |
| `contextmenu` handler | Same `askModeActive` guard; outside ask mode it still calls `preventDefault()` unconditionally. |
| Z-index / overlay stacking | No existing overlay is edited. The text layer is only in the DOM in ask mode; the highlight overlay is `pointer-events: none` always. |
| Six annotation stores | Untouched. `ChatHighlight` is a **seventh, parallel** store using the same generics, in its own localStorage key. It cannot collide with or reorder the others. |
| `clearCurrentPageDrawings` | **Not modified.** Chat highlights deliberately survive "clear page" — a user clearing ink does not expect to lose their conversations. Deleting a highlight is its own explicit action from the chat panel. This also drops the orphaned-session cascade the earlier draft needed. |
| `isDrawingTool` (`lpdfExport.ts:28`) | **Not modified.** Verified: it is used only at `:522-523` to validate `path.tool` on a persisted `DrawingPath`. Only pencil/eraser/highlight ever create a `DrawingPath`, so `'ask'` can never appear in that field. (An earlier draft claimed paths would be silently dropped without this — that was wrong; adding `'ask'` here would be meaningless.) |
| `pdfExport.ts` / `.lpdf` schema | **Not modified at all in v1.** Export output is byte-identical to today. |
| Docked panel shrinks the viewport | Only a viewport-size change, which the existing fit-to-width path already handles. Annotations persist in rotation-0/scale-1 space plus normalised `relative*` fields, so no stored coordinate depends on viewport width. Covered by a test below. |
| Chat storage | A separate IndexedDB (`LeedPDFChat`). The annotations' localStorage keys and the `LeedPDFStorage` file DB are untouched — see §4 for why bumping the latter would have been actively dangerous. |

**Every behavioural change is gated on `tool === 'ask'`.** The one-line rollback for the entire interaction surface is removing `'ask'` from the toolbar.

### Isolation tests (commit 2 and commit 6)

Beyond the per-feature tests: a dedicated `tests/unit/isolation.test.ts` asserting that with `tool` set to each of the seven **existing** tools in turn, the ask-mode predicates are all false; that adding, updating and deleting a `ChatHighlight` leaves all six existing annotation stores and their localStorage keys byte-identical; that `clearCurrentPageDrawings()` empties the six existing stores and **leaves `chatHighlights` intact**; and that an `.lpdf` exported from a document that has chat highlights is byte-identical to one exported from the same document without them.

Plus the Playwright regression spec (commit 4): with the pencil tool, a pointerdown/move/up sequence still produces a path; and with the panel open at two different widths, a text annotation's stored `relativeX/relativeY` are unchanged.

---

## 4. Chat storage — a separate IndexedDB

**Do not bump `LeedPDFStorage` to v2.** `FileStorageManager.initDB()` ([fileStorageUtils.ts:47-75](src/lib/utils/fileStorageUtils.ts#L47-L75)) caches the connection and registers neither `onversionchange` nor `onblocked`, so a version bump lets any other open tab block the upgrade forever — and the failure mode is "the PDF won't load". Different lifecycles too: `tempFiles` is deliberately GC'd on a TTL; transcripts must not be.

New DB `LeedPDFChat` v1 in `chatStorage.ts`:

```
sessions  keyPath 'id'
  by_pdf 'pdfKey' | by_pdf_created ['pdfKey','createdAt'] | by_highlight 'highlightId' (unique)
  | by_summary_state ['pdfKey','summaryState']
messages  keyPath 'id'
  by_session_seq ['sessionId','seq'] (unique) | by_pdf 'pdfKey'
documents keyPath 'pdfKey'          // ParsedDocument cache (§5a), one row per PDF
meta      keyPath 'key'
```

The `documents` rows are the largest thing stored (a 30-page paper's markdown + blocks is a few hundred KB) — another reason chat storage is a separate DB from the TTL-cleaned `tempFiles`.

`ChatSession { id, pdfKey, highlightId, pageNumber, quotedText, title, createdAt, updatedAt, model, messageCount, summaryState, summaryDueAt?, summaryAttempts, summary?, summaryError? }`
`ChatMessage { id, sessionId, pdfKey, seq, role, content, createdAt, status, usage? }`

`pdfKey` is the same `generatePDFKey(fileName, fileSize)` the annotation stores use.

**Load pattern:** `setCurrentPDF` is synchronous and called from four routes plus `lpdfExport` — leave it that way. Add a sibling `setChatPDFKey(pdfKey)` called right after each `setCurrentPDF(...)`, using a `generation` counter to discard out-of-order loads. Sessions load eagerly; **messages load lazily per session** on first activation (a 40-session doc would otherwise pull megabytes on open).

**Write policy:** user messages and completed answers are write-through. Streaming deltas update memory every frame but persist at most once per 1000ms with `status:'streaming'`, flipped to `'complete'` on end. On load, any leftover `'streaming'` row is rewritten to `'complete'` or dropped if empty.

---

## 5. Chat panel + OpenRouter

Docked flex sibling after `<div class="flex-1"><PDFViewer/></div>`, in all four shells: [+page.svelte](src/routes/+page.svelte) (~1047-1265), [pdf/[url]](src/routes/pdf/[url]/+page.svelte) (~860), [shared/[shareId]](src/routes/shared/[shareId]/+page.svelte) (~545), [templates/[templateName]](src/routes/templates/[templateName]/+page.svelte) (~717). Width in a `chatPanelWidth` store persisted to localStorage, drag handle, collapse toggle. Because it's a flex sibling, the existing fit-to-width logic re-fits the page when the panel resizes — debounce the resize before calling back into `pdfViewer.fitToWidth()`.

Toolbar: an `'ask'` tool button plus a panel toggle, following the `export let on…` callback-prop convention at [Toolbar.svelte:91-117](src/lib/components/Toolbar.svelte#L91-L117). Shortcuts: `8` for the ask tool, `c` for the panel (both verified free). **Add each to both [keyboardShortcuts.ts](src/lib/utils/keyboardShortcuts.ts) and the duplicated user-facing list in `KeyboardShortcuts.svelte:14-70`.**

`openRouter.ts`: `POST {endpoint}/chat/completions` with `Authorization: Bearer`, `HTTP-Referer`, `X-Title`, `stream: true`; parse SSE deltas until `data: [DONE]`; `AbortController` for stop. Model list fetched from `/models` and cached, with free-text fallback. Prompt assembly is its own subsystem — see §5a.

Streaming markdown dependency: **`svelte-streamdown`** — it bundles KaTeX, code highlighting and streaming-safe incremental parsing in one package, and LaTeX rendering is non-negotiable for research papers. (Fallback if it proves Svelte-5-runes-only and awkward inside this legacy-idiom codebase: `@humanspeak/svelte-markdown` + `katex` directly.) Verify at install time and note which was used in the commit message.

`settingsStore.ts` + `SettingsModal.svelte` (pattern: [CompressionSettingsModal.svelte](src/lib/components/CompressionSettingsModal.svelte), key-entry UX from [LicenseModal.svelte](src/lib/components/LicenseModal.svelte), focus trap from [trapFocus.ts](src/lib/utils/trapFocus.ts)): API key, endpoint, chat model, summary model, `summaryIdleMs`, auto-summarise toggle. Be plain in the UI that the key is stored in browser localStorage.

---

## 5a. Context assembly — what the model actually knows

This is the quality determinant for a research-paper tool, and it's worth more design than the chat UI. A model told only *"explain: ablation study"* is useless; the same model told *"this appears in §4.2 Experiments of a paper whose abstract is X, two paragraphs after Table 3"* is genuinely good.

### No local PDF parsing — MinerU is the only parser

`getTextContent()` returns glyph runs in **PDF content-stream order**, which for a two-column paper interleaves the columns into garbage — and two-column is most of arXiv. It has no concept of headings, renders equations as mojibake, and flattens tables into unparseable runs. Any heading/abstract detection built on it is font-size heuristics held together with tape, and maintaining that as a second-class fallback means carrying two parsers, two quality bars and two sets of bugs forever.

**Decision: there is no heuristic fallback parser.** MinerU (local or cloud) is the only source of document context. A document that hasn't been parsed cannot be chatted about — see "Gating and first-run" below.

> **Not affected: the pdf.js text layer from §1.** That renders the transparent, selectable spans the user drags over to *make* a selection. It is a DOM rendering concern, not document parsing, and MinerU cannot replace it — MinerU works offline and emits paragraph-level blocks, so it can neither produce an interactive layer nor support selecting a phrase *within* a block. §1 stays exactly as designed. What's removed is only the heuristic **parser** that would have fed context.

### MinerU as the document parser

[MinerU](https://github.com/opendatalab/MinerU) (v4) does layout-aware extraction: reading-order reconstruction for multi-column, formulas → LaTeX, tables → HTML, OCR for scanned pages. Run with `--dump-content-list`, its `content_list.json` gives a flat array of typed blocks:

```jsonc
{ "type": "text" | "table" | "equation" | "image" | "code" | "list",
  "text": "...", "text_level": 1,        // heading depth; absent for body text
  "page_idx": 0,                          // 0-based
  "bbox": [x0, y0, x1, y1],               // normalised to 0-1000
  "table_body": "<table>…</table>", "table_caption": [...], "sub_type": "algorithm" }
```

**`page_idx` + a 0–1000 `bbox` is the detail that makes this fit.** Divide the bbox by 1000 and it lands in exactly the 0..1 `NormRect` space the anchors from §2 already live in, so mapping a selection to its block is a **geometric containment test on the same page**, not fuzzy string matching:

```ts
// src/lib/services/docParser/blockLookup.ts
export function findBlockForAnchor(
  anchor: TextAnchor, rects: NormRect[], doc: ParsedDocument
): number | null;   // index into doc.blocks — max rect∩bbox overlap on page_idx === pageNumber - 1
```

Fuzzy text matching on `anchor.text` stays as the fallback when overlap is ambiguous (rotated pages, bbox origin mismatches).

### MinerU cannot run in the browser — the deployment reality

It's a Python ML pipeline with 0.8–3 GB of model weights. It cannot run in the browser, and it cannot run on Vercel serverless (250 MB bundle cap, no GPU). So it runs out of process, and the user picks one of two backends in Settings:

```ts
// src/lib/services/docParser/types.ts
export type ParserId = 'mineru-local' | 'mineru-cloud';

export interface DocumentParser {
  id: ParserId;
  isAvailable(): Promise<boolean>;                 // health check, surfaced in Settings
  parse(file: Blob, onProgress: (p: number, note: string) => void,
        signal: AbortSignal): Promise<ParsedDocument>;
}
```

| Backend | Setup | Notes |
|---|---|---|
| `mineru-local` (**default**) | `mineru server start`, or the `mineru` service in §7's compose | Best quality, fully private, free, no rate limit. Default target `http://localhost:8000`, configurable. Works in Tauri natively; in the browser `http://localhost` is exempt from mixed-content blocking (Secure Contexts spec), **but the server must send CORS headers** — verify early. Note the Docker deployment sidesteps this entirely by serving MinerU same-origin at `/mineru` behind Caddy (§7). |
| `mineru-cloud` | mineru.net API key | Async submit-then-poll (`/api/v4/extract/task`). No install. **Uploads the PDF to a third party** — explicit opt-in with a warning at the toggle, never a default. Unpublished manuscripts and anything under embargo must not leave the machine silently. |

No fallback chain and no auto-switching: the selected backend is used, and if it fails the error says which one failed and why. Settings shows a live reachability check with a "Test connection" button, so a misconfiguration is diagnosed there rather than as a failed question.

Tauri sidecar bundling is explicitly **out of scope** — 3 GB of weights in an installer is a non-starter. An "install MinerU" helper link with the `uv tool install` one-liner is the pragmatic middle.

### Gating and first-run

Because there's no fallback, chat has a hard prerequisite. Make that a designed state, not an error:

- **No backend configured** → the panel shows a setup card: what MinerU is, the install one-liner, a "Test connection" button, and the cloud alternative with its privacy warning. No chat input.
- **Configured, document not yet parsed** → the background parse is already running (it started on open — see "Background parsing" below). Progress shows in the panel header with a cancel button; the composer is disabled with "Parsing… you can ask questions once this finishes." For the cloud backend, which doesn't auto-parse, this is instead a "Parse this document" button.
- **Parse failed** → the error, a Retry, and a link to the backend's logs. Selecting text still creates a highlight (geometry doesn't need the parser), it just can't be asked about yet.
- **Parsed** → normal operation.

The cost of dropping the fallback is exactly this: a user with no MinerU gets a setup card instead of a degraded answer. That's the deliberate trade — one parser, one quality bar.

### Normalised internal format

Both backends emit the same shape, so nothing downstream knows or cares which produced it:

```ts
export interface ParsedBlock {
  idx: number;                 // reading order
  type: 'text'|'heading'|'table'|'equation'|'figure'|'code'|'list'|'reference';
  level?: number;              // heading depth (MinerU text_level)
  text: string;                // markdown; LaTeX for equations, HTML for tables
  pageNumber: number;          // 1-based, converted from page_idx
  bbox?: NormRect;             // 0..1
  caption?: string;
  tokenEstimate: number;       // cached chars/4
}

export interface ParsedDocument {
  pdfKey: string; parserId: string; parsedAt: number; schemaVersion: 1;
  blocks: ParsedBlock[];
  outline: { idx: number; level: number; text: string; pageNumber: number }[];
  title?: string; abstract?: string;
  references: { marker: string; text: string }[];   // "[12]" → entry
  markdown: string;            // full doc, for export/copy
}
```

### Token budget — tiered, ~8k default

Assembled per turn by `src/lib/services/contextBuilder.ts`, with an explicit budget rather than "stuff it and hope":

| Tier | Contents | Budget | When |
|---|---|---|---|
| 0 | The selected passage + "page N of M", and its section path (`§4.2 Experiments › Ablations`) derived by walking `outline` backwards from the block | ~200 | always |
| 1 | **Paper skeleton**: title, abstract, heading outline, figure/table captions — *not* body text; see "How the skeleton is selected" below | ~1200 | always — highest value per token; this is what makes the model *know the paper* |
| 2 | **Local window**: the containing block ± whole neighbouring blocks in reading order, plus any figure/table it references | ~3000 | always |
| 3 | **Resolved citations**: if the selection contains `[12]` or `(Smith et al., 2020)`, the matching `references` entries | ~400 | conditional |
| 4 | **Whole paper** (`ParsedDocument.markdown`) | rest | user toggle, per session |
| 5 | **Page image** (see below) | — | user toggle, per message |

Every tier is served from the cached `ParsedDocument`, so assembly is pure in-memory slicing — no parsing, no network, no pdf.js involvement at question time.

### What is actually sent — the exact payload

Tiers map onto the wire format as follows. The **system message holds only document-constant material**, so it is byte-identical across every question about the paper and every session — that's what makes OpenRouter's provider-side prompt caching hit. The **first user message holds the session-constant material** (the selection and its surroundings) and is pinned: history truncation drops middle exchanges but never that message. Follow-up turns therefore add *nothing* but the new question.

**Turn 1** — user selects "scaled dot-product attention" on page 4 and asks why the dot product is scaled:

```jsonc
{ "model": "…", "stream": true, "messages": [
  { "role": "system", "content":
"You are a research-paper reading assistant. The user is reading the paper below and \
will ask about passages they select. Prefer the paper itself; when you draw on outside \
knowledge, say so. Be concise. Use LaTeX for math.

<paper>
Title: Attention Is All You Need
Pages: 15

Abstract: The dominant sequence transduction models are based on complex recurrent or
convolutional neural networks… (verbatim, ParsedDocument.abstract)

Outline:
1 Introduction (p1)
2 Background (p2)
3 Model Architecture (p2)
  3.1 Encoder and Decoder Stacks (p3)
  3.2 Attention (p3)
    3.2.1 Scaled Dot-Product Attention (p4)
    3.2.2 Multi-Head Attention (p4)
4 Why Self-Attention (p6)
…
Figures and tables:
  Figure 1: The Transformer — model architecture. (p3)
  Table 2: The Transformer achieves better BLEU scores than previous models… (p8)
</paper>"                                                    // ← TIER 1, ~1.2k tok, cacheable
  },
  { "role": "user", "content":
"<context>
Location: page 4, §3 Model Architecture › §3.2 Attention › §3.2.1 Scaled Dot-Product Attention

[preceding block] The two most commonly used attention functions are additive attention
and dot-product (multiplicative) attention…

[containing block] We call our particular attention \"Scaled Dot-Product Attention\". The
input consists of queries and keys of dimension $d_k$… We compute the dot products of the
query with all keys, divide each by $\\sqrt{d_k}$, and apply a softmax function…

[equation, same block] $$\\mathrm{Attention}(Q,K,V)=\\mathrm{softmax}\\!\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V$$

[following block] While for small values of $d_k$ the two mechanisms perform similarly…

[cited] [12] Bahdanau et al. Neural machine translation by jointly learning to align and
translate. ICLR 2015.
</context>                                        // ← TIER 0 location + TIER 2 window + TIER 3 cites

<selection>scaled dot-product attention</selection>

Why is the dot product scaled by $\\sqrt{d_k}$?"           // ← the user's question
  }
]}
```

**Turn 2** — system message byte-identical (cache hit), turn 1's user + assistant messages retained verbatim, and the new turn is just:

```jsonc
{ "role": "user", "content": "So would layer norm instead of scaling work?" }
```

No context is re-sent. The selection and its surroundings are still present in the pinned first message.

**With the page image** (tier 5), the user message content becomes a parts array instead of a string:

```jsonc
"content": [
  { "type": "text", "text": "<context>…</context>\n\n<selection>…</selection>\n\nWhat does Figure 1 show?" },
  { "type": "image_url", "image_url": { "url": "data:image/webp;base64,…" } }
]
```

**With "whole paper" on** (tier 4), `ParsedDocument.markdown` is appended inside the system message's `<paper>` block as `<full_text>…</full_text>` — kept in the system message precisely so it stays cacheable rather than being re-sent per turn.

Every field above is sliced from the cached `ParsedDocument`. Nothing is parsed, fetched or re-read at question time.

**Typical turn-1 budget:** ~1.2k skeleton + ~3k window + ~0.4k citations + ~0.2k location/selection + question ≈ **4.8k tokens**, of which ~1.2k is cache-eligible. Follow-ups cost the history plus the new question only.

### How the skeleton and window are selected

**The system prompt does not contain the parsed document.** It contains a *derived skeleton* — typically **1–3 % of the paper**. For a 15-page paper MinerU emits ~400 blocks; the skeleton is ~40 headings, ~15 captions and the abstract. The body text of the paper is not in the system prompt at all (unless the user turns tier 4 on).

**Skeleton construction** (`buildSkeleton(doc, budget)`), purely a filter over `ParsedDocument.blocks`:

| Included | Rule |
|---|---|
| Title | `doc.title` |
| Page count | `max(pageNumber)` |
| Abstract | `doc.abstract`, verbatim, clipped to ~300 words at a sentence boundary |
| Outline | every block with `text_level` set — i.e. **headings only, never body text** |
| Captions | `caption` / `table_caption` fields of `figure` and `table` blocks — **the caption string only, never `table_body`** |

Everything else — all `type: 'text'` body blocks, all `table_body` HTML, all equations, the reference list, image data — is **excluded** from the system prompt. That is what keeps a 15-page paper at ~1.2k tokens instead of ~15k.

**When the skeleton itself would blow the budget** (a 60-page thesis with 200 headings), degrade in this order rather than truncating arbitrarily: keep heading levels 1–2 in full; include level 3+ only within the selection's own top-level section; then drop captions from sections far from the selection; then clip the abstract further. Level-1 headings are never dropped — losing them costs the model its map of the paper. If `title` or `abstract` were not detected, omit those lines rather than substituting a guess.

**Local window selection** (`selectWindow(doc, blockIdx, budget)`), the tier-2 ~3k:

1. Start from the containing block found by `findBlockForAnchor`. It is **always included and never truncated** — unless it alone exceeds the budget, in which case clip it around the selection offsets, keeping whole sentences.
2. Expand outward in reading order, alternating backwards and forwards, adding **whole blocks** until the budget is reached. Never emit a half block.
3. Prefer not to cross a `text_level === 1` boundary — material from the next section is usually irrelevant, and the heading chain in tier 0 already tells the model where it sits.
4. **Pull in referenced figures and tables regardless of distance.** If the containing block's text mentions "Figure 3" or "Table 2", include that block's caption — and its `table_body` HTML if it's a table. Papers constantly say "as shown in Table 2", and without this the model is answering blind about the one thing being discussed. This rule earns its tokens more than any neighbouring paragraph.
5. Equations within included blocks are kept whole — never clip LaTeX, since a truncated formula is worse than no formula.
6. `table_body` HTML is included only for a table that is the containing block or is explicitly referenced; otherwise caption only, because table HTML is token-expensive.

So the model's knowledge of the paper is: **complete structural awareness** (it knows every section and every figure exists, and where), **verbatim local detail** around the selection, and **nothing else** — unless the user opts into whole-paper mode, which appends `ParsedDocument.markdown` to the system message.

### What is deliberately never sent

Other chat sessions and their transcripts; other highlights; the user's ink, text boxes, sticky notes or any other annotation; pages outside the local window (unless tier 4 is on); the PDF file itself (only MinerU ever receives that, and only the configured backend); filename or file path. The context chip shows exactly this list so the user can verify it.

### Vision: attach the rendered page

An option worth taking, and cheap here because the app already has the rendered `pdfCanvas` — `toDataURL('image/webp', 0.8)` and send it as an `image_url` content part to any multimodal OpenRouter model. This is the single highest-leverage addition for papers specifically: **equations, figures and plots are exactly what text extraction destroys**, and "what does this figure show?" is a question readers actually ask. Default off (it costs tokens), one-click per message, auto-suggested when the selection's block is `type: 'figure' | 'equation'`. Note that scanned PDFs are no longer a special case for *context* — MinerU OCRs them into the same `ParsedDocument` as any other paper. They remain a special case for **selection**, since a scanned page has no pdf.js text layer to drag over; there the page image is the only way to ask about something, so the panel should offer "ask about this page" without a selection.

### Background parsing — `src/lib/services/parseQueue.ts`

Parsing is slow enough (~30 s–2 min, more on CPU) that it must never be on the critical path of a question. **Parse starts the moment a PDF is opened, in the background, long before the user selects anything or even opens the chat panel.** By the time they highlight their first term, it's usually done.

A module-level singleton, not a component — so it survives panel collapse, tool changes and page navigation:

```ts
export interface ParseJob {
  pdfKey: string; status: 'queued'|'running'|'done'|'failed'|'cancelled';
  progress: number; note: string; error?: TypedParseError; attempts: number;
}
export const parseJobs = writable<Map<string, ParseJob>>(new Map());

export function enqueueParse(pdfKey: string, getBlob: () => Promise<Blob>, opts?: { manual?: boolean }): void;
export function cancelParse(pdfKey: string): void;
export function retryParse(pdfKey: string): void;
```

Rules:

- **Trigger:** called right after each `setCurrentPDF(...)` / `setChatPDFKey(...)`. Cache hit → no-op. Miss → enqueue.
- **Debounce ~2 s** before starting, so flipping through several files doesn't fire a parse per file.
- **Concurrency 1.** A local MinerU server is a single GPU/CPU pipeline; parallel requests thrash it and make everything slower. Queue depth capped at 3, LRU-evicting *queued* (never running) jobs.
- **Do not cancel on document switch.** Results are cached by `pdfKey` and users flip back and forth constantly; killing a 90 %-done parse to start another is the worst outcome. The in-flight job finishes; the newly-opened document goes to the front of the queue. Explicit cancel is available in the UI.
- **Auto-parse defaults: ON for local, OFF for cloud.** Cloud parsing uploads the paper and spends quota, so it must never fire automatically on merely opening a file — for cloud the panel shows "Parse this document" and waits for a click.
- **Retry** twice with backoff on transient network/5xx errors; never on 401, quota, or malformed-response errors, which are surfaced immediately.
- **No queue persistence needed.** If the tab closes mid-parse, the next open is a cache miss and re-enqueues naturally.
- The PDF bytes come from the existing IndexedDB file store — `retrieveUploadedFile()` in [fileStorageUtils.ts](src/lib/utils/fileStorageUtils.ts) — so the blob is already at hand without re-reading from disk.

### Caching

New `documents` object store in the `LeedPDFChat` DB, keyed by `pdfKey`, holding the `ParsedDocument`. Because a cache miss now blocks chat rather than degrading it, the cache is load-bearing: never evict an entry for a PDF the user still has open, and make "clear parsed documents" an explicit action rather than part of the existing TTL cleanup. Re-parse is manual; a `schemaVersion` bump invalidates.

### GPU — detect and adapt, don't assume

**The client cannot choose the device.** GPU selection happens when the user launches the server (`CUDA_VISIBLE_DEVICES=0 mineru server start`); the app just talks HTTP to whatever is running. What it *must* do is adapt, because **MinerU's default backend requires a GPU and a CPU-only server errors unless the request explicitly sends `backend=pipeline`.** Getting this wrong means every parse fails on CPU-only machines.

So, on first connect to an endpoint, probe once and cache the result per endpoint in settings:

1. Try the GPU-capable backend (`hybrid-auto-engine` in current MinerU).
2. On the specific "no GPU / unsupported backend" error, retry with `backend=pipeline` and remember that this endpoint is CPU-only.
3. Surface the detected mode in Settings — *"MinerU at localhost:8000 · GPU (hybrid-auto-engine)"* or *"· CPU (pipeline)"* — with a manual override of **Auto / Force GPU / Force CPU**.

Adapt behaviour to the detected mode: longer timeouts and a "this may take a few minutes on CPU" note in the progress UI; GPU mode can afford a higher queue depth. The setup card offers both install lines (`uv tool install "mineru"` vs `"mineru[full]"` for CUDA) and the `CUDA_VISIBLE_DEVICES=0` launch example.

Two API details that will otherwise look like bugs: the **first** `/file_parse` call on a fresh install triggers a one-time 1–2 GB model download taking 60–120 s — the progress UI must say "downloading models (one-time)" rather than appearing hung. And all form fields are **strings** (`"true"`, not `true`).

> **Verify before coding:** backend names and parameters have moved between MinerU 2.x and 4.x. Read the live Swagger at `http://localhost:8000/docs` against the installed version and pin the adapter to what's actually there. Treat the names above as current-best, not gospel — same "verify first" discipline as the pdf.js CSS variable.

### Transparency

A context chip in the composer — *"≈4.2k tokens · selection + §4.2 + outline + page 5"* — expanding to a popover that shows each tier, its token cost, and a toggle. The user is paying per token and should be able to see and control what's being sent. It's also the fastest way to debug a bad answer.

---

## 6. Summary state machine — `src/lib/services/summaryScheduler.ts`

A **module-level singleton**, not a component — module state survives panel collapse (required) and is torn down explicitly on document switch via `reset()` (required).

States, persisted on `ChatSession.summaryState`: `idle → armed → generating → ready | failed → skipped`.

| from | event | to | effect |
|---|---|---|---|
| any | answer completes | `armed` | `summaryDueAt = now + idleMs`; persist; reschedule |
| `armed` | user activity | `armed` | push deadline out |
| `armed` | timer fires | `generating` | generate |
| `armed` | **another session activated** | `generating` | generate immediately — trigger (b) |
| `generating` | ok / err | `ready` / `failed` | persist; patch the highlight |
| `failed` | reactivated or manual retry | `generating` | retry, max 2 attempts then `skipped` |
| any | `messageCount < 2` or transcript `< 200` chars | `skipped` | show `quotedText` instead — free |

**"Activity" counts:** sending a message, a stream in flight, a non-empty composer draft (500ms debounce). **Does not count:** panel collapse/resize, hovering a highlight, page navigation, zoom/pan, transcript scroll, window blur. Put this list as a comment at the top of the file — it is the requirement most likely to drift.

**One global `setTimeout`**, not one per session: scan the in-memory `armed` map for the minimum deadline, set a single timeout, drain everything past due on fire. O(1) timers for N sessions and makes `reset()` trivially correct. Background tabs clamp timers to ~1/min — firing a minute late is fine; do **not** force-fire on `visibilitychange`, which would summarise every time the user tabs away.

**Reload/close:** no `beforeunload` LLM call (`keepalive` fetch to OpenRouter is unreliable, unobservable, and spends money at a moment the user can't see the result). `armed` + `summaryDueAt` persist. On `attach(pdfKey, sessions)` a **catch-up pass** fires overdue sessions — but only the **3 most recently updated**, the rest go straight to `skipped`, bounding the cost of opening a doc with 20 orphaned sessions. Anything found in `generating` (tab died mid-call) resets to `armed`, due now.

**Idempotency, three layers:** in-memory in-flight promise map; compare-and-set on the `armed → generating` transition (re-read before committing); persisted state so a second tab sees `generating`/`ready`. Two tabs racing within the same second can still double-call — accepted for v1, `BroadcastChannel` is the documented follow-up.

**Cost control:** last 8 messages clipped to 1200 chars each, `quotedText` to 500, `max_tokens: 120`, `temperature: 0.2`, prompt *"In at most 25 words, state what the user wanted to know about the quoted passage and the answer's conclusion. No preamble."* Failures surface as one toast per document open via the existing `toastStore`.

The result writes to **both** `ChatSession.summary` (IDB, source of truth) and `ChatHighlight.summary` + `summaryStatus` (localStorage, denormalised) so the hover card renders with no async read on mousemove.

---

## 7. Docker — dev, test and deployment

**Short answer: yes, and Docker is now the natural way to ship this**, because the feature turns a single-page app into a two-service system (app + MinerU). But it is not deployable as-is — there is one real blocker and several config details that will bite.

### Blocker: the adapter

[svelte.config.js](svelte.config.js) uses `@sveltejs/adapter-vercel`, which emits `.vercel/output` for Vercel's runtime — **not a runnable Node server**, so there is nothing for a container to `CMD`. The app also has genuine server routes (`src/routes/api/{search,proxy-pdf}/+server.ts`, several `+page.server.ts`), so a static adapter won't do either.

Fix, additive and non-breaking — make the adapter switchable, defaulting to today's behaviour so Vercel deploys are untouched:

```js
// svelte.config.js
import vercel from '@sveltejs/adapter-vercel';
import node from '@sveltejs/adapter-node';
const adapter = process.env.ADAPTER === 'node' ? node() : vercel();
```

Adds one devDependency, `@sveltejs/adapter-node`.

### Two more config details that break in containers

1. **[vite.config.ts](vite.config.ts) hardcodes `hmr.host: 'localhost'`** and never sets `server.host`. In a container Vite binds the loopback interface, so the host browser can't reach it and HMR silently fails. Needs `server.host: '0.0.0.0'` and the HMR host from an env var (host-side value, not the container's).
2. **`PUBLIC_*` vars are read via `$env/static/public`** ([+layout.ts:3](src/routes/+layout.ts#L3), [appwrite.ts:4](src/lib/services/appwrite.ts#L4)), which SvelteKit **inlines at build time**. They must be Docker **build args**, not runtime `environment:` entries — a classic gotcha that produces a working container with silently empty config. `BRAVE_SEARCH_API_KEY` uses `$env/dynamic/private` and is correctly a runtime env var.

### Services

| Service | Purpose | Notes |
|---|---|---|
| `app` | SvelteKit | dev: `pnpm dev --host 0.0.0.0` on 5173; prod: `ADAPTER=node` → `node build` on 3000 |
| `mineru` | Document parser | Upstream ships [its own `docker/compose.yaml`](https://github.com/opendatalab/MinerU/blob/master/docker/compose.yaml) with profiles — **reuse their image, don't rebuild it**. Named volume `mineru-models` so the 1–2 GB weight download (§5a) happens once, not per container rebuild. |
| `proxy` | Caddy | Serves the app at `/` and MinerU at `/mineru/*` |
| `unit` / `e2e` | Test runners | `test` profile only |

**No database service.** Chat sessions, parsed documents and annotations all live in the browser (IndexedDB/localStorage), so the compose file stays small.

### The reverse proxy earns its place

Putting Caddy in front makes MinerU **same-origin** with the app, which **eliminates the CORS problem entirely** — the risk flagged in §5a as needing a flag or a hand-rolled proxy. The parser endpoint default becomes the relative path `/mineru` in the Docker build instead of `http://localhost:8000`. This only helps the containerised deployment; bare-metal local MinerU and the Tauri desktop build still need the CORS check.

### Files

`Dockerfile` (multi-stage: `base` → `deps` → `dev` / `build` → `runtime`, Node 24 + pnpm 10.32.1 via corepack, matching [package.json](package.json) `engines` and `packageManager`), `.dockerignore` (**must** exclude `node_modules`, `.svelte-kit`, `.vercel`, `build`, and especially `src-tauri/target`, which is multi-GB), `Caddyfile`, `.env.docker.example`, and:

- `docker-compose.yml` — base definitions, profiles `dev` / `test` / `prod`
- `docker-compose.dev.yml` — bind-mount source, anonymous volume for `node_modules`, Vite dev server
- `docker-compose.test.yml` — unit and e2e runners
- `docker-compose.gpu.yml` — GPU override for `mineru` only

```
docker compose --profile dev up                          # dev, HMR on :5173
docker compose --profile test run --rm unit              # vitest
docker compose --profile test run --rm e2e               # playwright
docker compose --profile prod up -d                      # CPU deployment
docker compose -f docker-compose.yml -f docker-compose.gpu.yml --profile prod up -d   # GPU
```

The GPU override is where §5a's device story lands concretely — `deploy.resources.reservations.devices` with `capabilities: [gpu]` plus `ipc: host`, per MinerU's own compose. The app's device probe still runs and still matters: it's what detects whether the `mineru` service actually came up with a GPU and picks `hybrid-auto-engine` or `pipeline` accordingly.

### E2E in a container

[playwright.config.ts](playwright.config.ts) needs two accommodations: its `webServer` block already runs `pnpm build && pnpm preview` on 4173, so the `e2e` service can keep using it rather than pointing at the `app` service — simpler and hermetic. But the `Google Chrome` project uses `channel: 'chrome'` (real Chrome, not bundled Chromium), which is **not** in `mcr.microsoft.com/playwright` by default and needs an explicit install layer, or that project skipped in-container. Pin the Playwright image tag to the installed `@playwright/test` version or the browsers mismatch.

### Honest limits

- **Tauri desktop builds are not dockerizable** in any useful way — macOS and Windows targets can't cross-compile from a Linux container. Desktop builds stay on host/CI runners (`release.yml`). Docker covers the web app, MinerU and tests.
- **No GPU on macOS.** Docker Desktop cannot pass through a GPU, so Mac users get CPU MinerU (slow) or run MinerU natively on the host and point the app at it. GPU on Linux requires the NVIDIA Container Toolkit.
- **Images are large** — MinerU's CUDA base plus model weights is several GB before the app.

---

## Commit sequence

Each builds, type-checks, **ships its own tests from the Testing table**, and is independently revertable. Format `feat: <message>`, no author trailers.

1. `feat: add durable text anchor geometry utilities` — `textAnchor.ts` split into pure + DOM halves, with the full `textAnchor.test.ts` suite. No UI. *Riskiest maths, landed first and fully covered.*
2. `feat: add ask tool to the drawing tool union` — union, Toolbar button, shortcuts in both registries, + `isolation.test.ts`. Tool is inert; no existing tool's behaviour changes.
3. `feat: render a pdf.js text layer for the ask tool` — `PDFTextLayer.svelte`, vendored CSS, mounted **only in ask mode** at z-index 11. No existing overlay edited. **First: `grep -n "scale-factor" node_modules/pdfjs-dist/web/pdf_viewer.css` to confirm the variable naming.** Verify alignment at scales 0.5/1/3 × rotations 0/90/180/270 with `color: transparent` temporarily red.
4. `feat: enable text selection and selection capture in ask mode` — the three ask-gated pointer edits, `pendingSelection`, the "Ask about this" chip, + the Playwright pencil-still-draws and panel-resize-doesn't-move-annotations regression specs. **Manual regression gate** (see Verification).
5. `feat: add chat session storage in IndexedDB` — `chatStorage.ts`, `chatStore.ts`, `setChatPDFKey` wired into four routes + `lpdfExport`, + `chatStorage.test.ts` and `chatStore.test.ts` (adds the `fake-indexeddb` devDep). No UI.
6. `feat: anchor chat highlights to selected passages` — `ChatHighlight` in `drawingStore.ts`, overlay, hit-test action, hover card shell, + the `drawingStore.test.ts` extensions and `hitTest.test.ts`. Still no LLM.
7. `feat: add settings modal for OpenRouter credentials` — `settingsStore.ts`, `SettingsModal.svelte`, `openRouter.ts`, + `openRouter.test.ts` (SSE chunk-splitting, abort, error mapping).
8. `feat: parse documents with MinerU in the background` — `docParser/` (both backends, no fallback), GPU/CPU probe with backend selection, `parseQueue.ts` triggered on PDF open, `ParsedDocument` cache in the `documents` store, parser settings with "Test connection" and the detected device. + `docParser.test.ts`, `parseQueue.test.ts`, `deviceProbe.test.ts`, all against checked-in fixtures so **CI never needs Python or a live MinerU**. No chat UI yet; verify the cached `ParsedDocument` in DevTools.
9. `feat: add docked chat panel with streaming responses` — panel shell, composer, markdown dep, resize/collapse, all four route shells, the gating states (not configured / parsing / failed / ready), `blockLookup.ts` + `contextBuilder.ts` tiers, the context chip. + `blockLookup.test.ts`, `contextBuilder.test.ts`, and the first three `chat.spec.ts` e2e steps.
10. `feat: jump to a chat session by double-clicking its highlight` — `activeSessionId` wiring, transcript scroll, ordinal chips, + e2e steps 4-5.
11. `feat: attach rendered page images for multimodal models` — `toDataURL` capture, per-message toggle, auto-suggest on figure/equation blocks, scanned-PDF path.
12. `feat: auto-summarise idle chat sessions for hover previews` — `summaryScheduler.ts`, catch-up on attach, settings for idle/model/toggle, hover card populated, + the full `summaryScheduler.test.ts` transition-table suite on fake timers.
13. `feat: clean up orphaned chat sessions and parsed documents` — "Clear chat for this document", "Clear parsed documents", `deleteByPdfKey`, deleting a highlight tombstones its session. Final `pnpm test:coverage` pass against the 80% threshold.

**Docker lands in two pieces, not one.** The first is a prerequisite for developing commit 8 comfortably, so it comes early:

- **After commit 7** — `feat: add docker compose for dev and test` — the adapter switch in `svelte.config.js`, the Vite host/HMR fix, `Dockerfile`, `.dockerignore`, `docker-compose{,.dev,.test}.yml`, and the `mineru` service. From here on, MinerU is one `docker compose up` away, which is what makes commit 8 pleasant to build and test.
- **After commit 13** — `feat: add docker compose deployment with GPU support` — `Caddyfile` and the `proxy` service (switching the parser default to the same-origin `/mineru`), `docker-compose.gpu.yml`, `.env.docker.example`, and README deployment docs.

**Deferred to a follow-up, deliberately:** exporting chat highlights to PDF/`.lpdf`, and retiring `extractTextFromCurrentPage`/`TextSelectionOverlay`. Both mean editing working annotation code, and neither is needed for the feature to be useful.

---

## Testing

Existing infra to reuse: vitest + jsdom, `globals: true`, `include: ['tests/unit/**/*.{test,spec}.{js,ts}']`, setup at [tests/setup.ts](tests/setup.ts) (which already mocks `globalThis.fetch`, Tauri APIs, and exposes `globalThis.testHelpers.localStorageMock`). Follow the idiom in [tests/unit/stores/drawingStore.test.ts](tests/unit/stores/drawingStore.test.ts) — import the store's exported functions, drive them, assert with `get()`, reset in `beforeEach`/`afterEach` to avoid pollution from the module-level auto-save subscriptions. Playwright e2e lives in [tests/e2e/](tests/e2e/).

**`vitest.config.ts` sets an 80% global coverage threshold** (branches/functions/lines/statements), so these tests aren't optional garnish — a thin test pass will fail `pnpm test:coverage`.

**One new devDependency: `fake-indexeddb`** (not currently present), imported as `fake-indexeddb/auto` in the chat-storage spec. jsdom has no IndexedDB.

### Per-commit test deliverables

| Commit | New test file | What it covers |
|---|---|---|
| 1 | `tests/unit/utils/textAnchor.test.ts` | `clientRectsToNormRects` → `normRectToDisplay` round-trip at rotations 0/90/180/270 × scales 0.5/1/3, asserting the rect returns to within 1e-6 of its input; portrait *and* landscape base pages (90/270 swap the axes, so a square page hides bugs); line coalescing merges same-line fragments and does not merge across lines; the 200-rect cap drops the tail without touching the anchor; zero-area and negative-width rects are dropped. |
| 1 | same file | `rangeToAnchor` pure half against a synthetic `PageTextIndex`: forward and backwards drags produce identical anchors; offsets spanning multiple text items; `hasEOL` join rule; `prefix`/`suffix` clipped to 48 chars and clamped at page boundaries; selections under 2 chars rejected with `null`. |
| 1 | same file | `relocate`: identical `textHash` short-circuits; changed hash falls back to prefix+text+suffix search, then item-scoped search, then a unique global match; a non-unique global match returns `null` rather than guessing. |
| 2 | `tests/unit/isolation.test.ts` | With `tool` set to each of the seven existing tools in turn, every ask-mode predicate is false and `hasActiveFreehandTool()` returns exactly what it does today. Guards the "new tool changes nothing" claim in §3a. |
| 5 | `tests/unit/utils/chatStorage.test.ts` | Against `fake-indexeddb`: schema creation and index presence; session CRUD; `by_pdf_created` ordering; `by_highlight` uniqueness violation surfaces as a rejection; `listMessages` returns `seq`-ordered; `deleteSession` cascades its messages; `deleteByPdfKey` removes both stores' rows for one doc and leaves another doc's rows intact; a leftover `status:'streaming'` message is normalised on load; `isAvailable()` resolves `false` (not throws) when `indexedDB` is absent. |
| 5 | `tests/unit/stores/chatStore.test.ts` | `setChatPDFKey` generation counter: a slow load for doc A resolving *after* a switch to doc B does not clobber B's sessions; switching to `null` clears everything; a storage failure sets `chatLoadState` to `'unavailable'` rather than throwing; `ensureMessagesLoaded` is idempotent and fetches once. |
| 6 | `tests/unit/stores/drawingStore.test.ts` (extend) | `ChatHighlight` add/update/delete through the shared CRUD generic; per-page bucketing and the `currentPageChatHighlights` derived store; localStorage persistence under the `_${pdfKey}` suffix using the existing `localStorageMock`; `setCurrentPDF` swaps highlight sets between documents. |
| 6 | `tests/unit/isolation.test.ts` (extend) | Highlight CRUD leaves all six existing stores and their localStorage keys byte-identical; `clearCurrentPageDrawings()` empties the six existing stores and **leaves `chatHighlights` intact**; an `.lpdf` exported from a doc with highlights is byte-identical to one from the same doc without them. |
| 6 | `tests/unit/utils/hitTest.test.ts` | Pure hit-test: a point inside any one rect of a multi-rect highlight hits; points in the inter-line gap miss; overlapping highlights resolve to the topmost/most recent deterministically. |
| 7 | `tests/unit/services/openRouter.test.ts` | Against the already-mocked `globalThis.fetch` with a `ReadableStream` body: SSE deltas accumulate in order; a chunk split mid-`data:` line across two reads is buffered correctly (the classic streaming bug); `data: [DONE]` terminates; a `[DONE]`-less abrupt close is surfaced as an error, not a silent truncation; HTTP 401/429 map to typed errors carrying the provider message; `AbortController` stops cleanly without an unhandled rejection; required headers (`Authorization`, `HTTP-Referer`, `X-Title`) are present. |
| 8 | `tests/unit/services/parseQueue.test.ts` | On fake timers: opening a PDF enqueues a parse; a cache hit does **not**; the 2 s debounce collapses rapid file-flipping into one job; concurrency never exceeds 1; a document switch does **not** cancel the in-flight job but does reprioritise the queue; queue depth caps at 3 evicting queued-not-running jobs; auto-parse fires for local and does **not** for cloud; transient 5xx retries twice with backoff while 401/quota retries zero times; `cancelParse` aborts the fetch and leaves no zombie job. |
| 8 | `tests/unit/services/deviceProbe.test.ts` | GPU probe: a server accepting the GPU backend is recorded as GPU; one rejecting it with the no-GPU error is retried with `backend=pipeline` and recorded CPU-only; the probe runs **once per endpoint** and is cached; Force GPU / Force CPU override the probe; changing the endpoint URL re-probes; form fields are serialised as the strings `"true"`/`"false"`, not booleans. |
| 9 | `tests/unit/services/blockLookup.test.ts` | `findBlockForAnchor` against a fixture `content_list.json`: a rect inside one block resolves to it; a selection spanning two blocks picks the max-overlap one; a rect on page 3 never matches a page-2 block; ambiguous overlap falls back to text matching; rotated pages resolve correctly. |
| 9 | `tests/unit/services/contextBuilder.test.ts` | Pure assembly, asserted against a checked-in expected-payload snapshot so the wire format can't drift silently: the system message contains **only** document-constant material and is byte-identical across two different sessions on the same paper (the prompt-caching guarantee); the first user message carries location + window + citations; **turn 3 adds only the question and re-sends no context**; history truncation drops middle exchanges but never the pinned first user message; each tier is clipped at its budget and the total never exceeds the cap; the section path walks `outline` backwards to the right heading chain; `[12]` in the selection pulls reference 12 and nothing else; tier 4 lands in the system message, not the user message; tier 5 converts content to a parts array; **`buildSkeleton` emits headings and captions but no body text and no `table_body`**, and degrades a 200-heading document by dropping level 3+ outside the selection's section while never dropping level 1; **`selectWindow` emits only whole blocks**, always includes the containing block, stops at the budget, and **pulls in a figure/table caption when the containing block references it by name even if it is 20 blocks away**; a containing block larger than the whole budget is clipped around the selection at sentence boundaries; LaTeX is never clipped mid-formula; and a negative test asserting **no annotation, no other session's transcript, and no out-of-window page text ever appears in the payload**; an empty selection is rejected before any network call. |
| 8 | `tests/unit/services/docParser.test.ts` | MinerU `content_list.json` → `ParsedDocument`: `page_idx` 0-based → `pageNumber` 1-based; `bbox` /1000 → `NormRect`; `text_level` → outline hierarchy; tables keep `table_body` HTML and equations keep LaTeX. Both backends produce an identical `ParsedDocument` from equivalent fixtures. Error paths, which matter more now that there's no fallback: unreachable local server, 401/quota from cloud, a cloud task that polls to `failed`, a mid-parse `AbortSignal`, and a malformed or truncated `content_list.json` — each must surface a typed, named error rather than throwing raw or silently producing an empty document. |
| 12 | `tests/unit/services/summaryScheduler.test.ts` | The full transition table with `vi.useFakeTimers()`: `armed` fires at exactly `idleMs`; activity before the deadline pushes it out and does *not* fire early; **activating a second session fires the first one's summary immediately** (trigger b); whichever of the two fires first cancels the other; `reset()` cancels the timer and aborts an in-flight call while leaving `summaryState: 'armed'` persisted; the catch-up pass fires only the 3 most recent overdue sessions and marks the rest `'skipped'`; a session found in `'generating'` on load is re-armed; **idempotency — concurrent `onAnswerComplete` + `onSessionActivated` for the same session produce exactly one LLM call**; `messageCount < 2` short-circuits to `'skipped'` with zero calls; the auto-summarise toggle off short-circuits; two failures then `'skipped'`; one global timer is used regardless of session count. |

### E2E

`tests/e2e/chat.spec.ts`, following the existing specs' style. With the OpenRouter call stubbed via `page.route()` returning a canned SSE stream (never a live key in CI):

1. Load a fixture PDF → switch to the ask tool → drag-select text → the "Ask about this" chip appears.
2. Send a question → the stubbed answer streams into the panel → a highlight appears on the page.
3. Reload → the highlight and transcript are both still there.
4. Double-click the highlight → the panel opens on that session.
5. Toggle the panel and drag-resize it → the page re-fits and no horizontal scrollbar appears.

Plus one **regression spec** asserting that with the pencil tool active, a pointerdown/move/up sequence on the drawing canvas still produces a path — this is the automated half of the commit-4 gate.

### What stays manual

Real stylus hardware, real two-finger pinch, and visual glyph alignment of the text layer can't be meaningfully asserted in jsdom or Playwright. Those are the manual gate below.

---

## Verification

`pnpm test:run` and `pnpm check` (svelte-check) must be clean after **every** commit; `pnpm test:coverage` must clear the configured 80% threshold before the final commit; `pnpm lint` before pushing.

**Manual regression gate after commit 4** — the previous release specifically fixed stylus and pinch, so run each of these **in ask mode and in pencil mode**: stylus draw on a tablet (or `pointerType: 'pen'` emulation), two-finger pinch-zoom, trackpad Ctrl+wheel zoom, single-finger touch pan, right-click, eraser, text box creation, sticky note drag. Nothing may change outside ask mode.

**Manual end-to-end after commit 10:** open a research paper → select a term → ask a question → watch it stream → wait 60s → hover the highlight and see the summary → make a second selection and confirm the first session's summary was generated immediately → reload the page and confirm the highlight, transcript and summary all return → double-click the highlight and confirm the panel jumps to that session → rotate the page 90°/180°/270° and zoom to 300% and confirm the highlight still sits exactly on the text.

**Parser verification (after commit 8):** read the live Swagger at `http://localhost:8000/docs` and pin the adapter's parameter names to it. Run `mineru server start`, confirm the browser build can reach it (CORS!), then open a real two-column arXiv paper and confirm **the parse starts on open without touching the chat panel**, and that reading order is correct, equations arrive as LaTeX, tables keep their structure, and the outline matches the paper's real sections. Confirm reopening the same paper is instant (cache hit) and enqueues nothing.

Then the device path, which is the likeliest field failure: launch with `CUDA_VISIBLE_DEVICES=0` and confirm Settings reports GPU; relaunch with `CUDA_VISIBLE_DEVICES=""` and confirm the probe detects CPU-only, switches to `backend=pipeline`, and still parses successfully.

Then each failure path deliberately — stop the server mid-parse, point at a wrong port, use a bad cloud key — and confirm each gives a named error and a working Retry rather than a hang. Also open three PDFs in quick succession and confirm the debounce and concurrency-1 rules hold (one parse at a time, no thrash). After commit 9, inspect the context chip to confirm what was sent matches the tier budget.

**Docker verification:** `docker compose --profile dev up` → HMR works from the host browser (this is what proves the Vite host/HMR fix). `docker compose --profile test run --rm unit` and `… e2e` → both suites pass in-container. `docker compose --profile prod up -d` → the app serves, and MinerU is reachable **same-origin at `/mineru`** with no CORS configuration anywhere. Confirm `mineru-models` persists across `docker compose down && up` (no repeat 1–2 GB download). On an NVIDIA host, bring up the GPU override and confirm the device probe reports GPU rather than falling back to `pipeline`. Then confirm a plain `pnpm build` on the host still emits `.vercel/output`, proving the adapter switch didn't break Vercel.

**Cross-target:** run the Tauri desktop build (`pnpm tauri dev`) once after commit 8 and confirm the OpenRouter fetch succeeds — `"csp": null` in `src-tauri/tauri.conf.json` says it should, but verify rather than assume.

---

## Known risks

- **pdf.js CSS variable naming** (`--scale-factor` vs `--total-scale-factor`, renamed in the 4.x line). Set both; verify against the installed `pdf_viewer.css` in commit 3. A misalignment is instantly visible with the red-text debug toggle. `node_modules` is not currently installed, so this is the one genuine unknown.
- **Stylus/pinch regression.** Mitigated by scope: `touch-action` untouched, touch and pen branches untouched, the only new early-return guarded by `pointerType === 'mouse' && askModeActive`, and the drawing canvas disabled only via `pointer-events` (instantly reversible). Commit 4's manual gate is the check.
- ~~Z-index reshuffle breaking an existing overlay~~ — **eliminated.** The text layer only exists in the DOM in ask mode and the highlight overlay is `pointer-events: none`, so no existing overlay is edited. See §3a.
- **Scanned/image-only PDFs** have no pdf.js text layer to select from. MinerU still OCRs them for context, so detect `textContentItemsStr.length === 0` and offer "ask about this page" with the page image instead of silently doing nothing.
- **Text layer rebuild cost** on dense pages. Only mounted in ask mode, `cancel()` on supersede; if profiling shows a hitch, defer the rebuild behind `requestIdleCallback`.
- **Session/highlight divergence.** `highlightId` is a unique index; deleting a highlight tombstones the session; on attach, drop sessions whose `highlightId` is absent after a grace period. Note that because `clearCurrentPageDrawings` is deliberately left alone, the main orphaning path no longer exists.
- **Ask mode covers the sticky notes and text boxes** while active, so they can't be clicked until you switch tools. Accepted: it's modal-tool behaviour, it's reversible in one click, and the alternative was editing six working overlay components.
- **MinerU is a hard dependency — this is now the feature's biggest risk, by choice.** No MinerU means no chat at all, so a user who won't install Python tooling and won't upload to the cloud gets nothing. Accepted deliberately in exchange for one parser and one quality bar. Mitigations are UX, not fallback: a default-on local backend, a clear setup card with the install one-liner, "Test connection" in Settings, and the cloud option for users who can't install. CI uses checked-in fixtures, never a live MinerU.
- **MinerU licensing.** It's the "MinerU Open Source License, based on Apache 2.0 with additional conditions" — **read the additional conditions before shipping**, since this is a public fork. Calling a user-run local server or a user-keyed cloud API (rather than vendoring code or weights) is the lowest-risk integration, but confirm attribution requirements.
- **Cloud parsing uploads the paper to a third party.** Opt-in only, explicit warning at the toggle, never a default, and never auto-triggered on document open.
- **Local server CORS / mixed content.** `http://localhost` is exempt from mixed-content blocking, but the MinerU FastAPI server must still send `Access-Control-Allow-Origin`. Verify early; if it doesn't, document a flag or a one-line reverse proxy. Tauri is unaffected (`"csp": null`).
- **Parse latency** (~30 s–2 min) **blocks the first question**, where previously a fallback would have covered it. Mitigated by starting the parse on document open — it usually completes before the user selects anything — plus visible progress and a permanent cache.
- **CPU-only servers fail on the default backend.** MinerU's default requires a GPU; without the probe-and-fall-back-to-`pipeline` logic, every parse fails for CPU-only users with an opaque error. This is the single most likely "it doesn't work for me" bug, and it's why the device probe is in the same commit as the adapter.
- **First-parse model download** (1–2 GB, 60–120 s) looks exactly like a hang. The progress UI must name it explicitly.
- **Auto-parse on open could surprise cloud users** with uploads and quota spend. Hence auto-parse defaults ON for local, OFF for cloud, with parsing there behind an explicit button.
- **MinerU backend names have moved between 2.x and 4.x.** Pin the adapter against the live Swagger at `/docs` for the installed version rather than the names in this plan.
- **`PUBLIC_*` as runtime env instead of build args** yields a container that starts fine with silently empty analytics/Appwrite config. `$env/static/public` is inlined at build time — they must be build args.
- **Adding `adapter-node` must not change Vercel deploys.** The switch defaults to `vercel`; verify a normal `pnpm build` still emits `.vercel/output` before merging.
- **Docker does not cover the desktop app.** Tauri release builds stay on host/CI runners; don't let the compose file create the impression that `docker compose up` builds everything.
- **`ParsedDocument` cache size.** Hundreds of KB per paper in IndexedDB. Add an LRU cap and a "clear parsed documents" action alongside the existing storage cleanup.
- **Two tabs on the same document** race on writes. Accepted (last-write-wins) — the existing annotation stores already behave this way, so it is not a new class of bug.

---

## Status and next steps for testing

This is the plan as agreed before implementation. It was all built on `feature/chat-interface`, but a few parts changed once the real tools were tried:

- **MinerU 4 `/v1` API.** The API is upload → job → poll → download, with quality tiers (`flash` / `basic` / `standard`). The server doesn't send CORS headers, and inline uploads are capped at 1 MiB. There is one client (`docParser/mineruClient.ts`) instead of separate local and cloud backends, and no GPU probe. The tier is set on the server (`--tier`), and the client asks for that tier.
- **SvelteKit relay, not Caddy.** `/api/mineru/[...path]` makes MinerU same-origin in every deployment, so there's no `proxy` service. `BODY_SIZE_LIMIT=110M` is required on adapter-node, whose 512K default rejects real papers with a 413.
- **Markdown:** `@humanspeak/svelte-markdown` + `katex` (the fallback), not `svelte-streamdown`.
- **Compose:** one `docker-compose.yml` with `dev` / `test` / `prod` profiles, plus the `docker-compose.gpu.yml` override.

### What is covered today

- **Unit (vitest, 382 passing):** anchors, isolation, chat storage/stores/highlights/settings, OpenRouter SSE, MinerU content mapping and client, parse queue, context assembly, chat controller, summary scheduler, MinerU relay. Run with `docker compose --profile test run --rm unit`.
- **Typecheck:** `docker compose --profile test run --rm typecheck`. Currently clean.
- **E2E (Playwright, 134 passing on the desktop projects):** `text-layer`, `ask-selection`, `chat-highlights` and `chat` specs, plus the existing suites. OpenRouter is always stubbed with `page.route()`. MinerU output comes from the fixtures in `tests/fixtures/mineru/`. Run with `docker compose --profile test run --rm e2e --project=firefox --project=webkit --project="Mobile Chrome" --project="Mobile Safari"`.
- **Live MinerU:** the `flash` tier on CPU, through the relay, against the synthetic fixture paper and a real multi-page PDF.

### Known pre-existing failures (not regressions)

These fail the same way on the untouched base commit `f768c50`:

- `[Mobile Safari] app.spec.ts "should display error states gracefully"`: the `locator.click` times out.
- Keyboard/button `zoomIn()` / `zoomOut()` can commit a new scale while the render is still in flight. The canvas stays stale and the overlays move to the new scale. This is intermittent on WebKit and Firefox. Wheel zoom is not affected.

### Next steps, roughly in priority order

1. **Real OpenRouter round trip.** Every automated test stubs the API. With a real key, check streaming, stopping mid-answer, 401 (bad key), 402 (no credits), 429, and the model list. Also check that answers render LaTeX. Look at the OpenRouter activity log to confirm follow-ups resend only the question and that prompt caching hits on the system message.
2. **Real papers, end to end.** Try several two-column arXiv papers, a long thesis (60+ pages), a scanned or image-only PDF, and a non-English paper. For each, check:
   - reading order and headings in the parsed outline
   - that the selection maps to the correct block
   - the section path shown in the context chip
   - how the skeleton degrades on the long document (level-1 headings never dropped)
   - that figure/table references are pulled into the window
   - the "ask about this page" path for the scanned PDF
3. **MinerU tiers and hosts.** Only `flash` on CPU has been tested live. Test `basic` and `standard`, the GPU override (`docker compose -f docker-compose.yml -f docker-compose.gpu.yml --profile prod up -d`) on an NVIDIA host with the Container Toolkit, the one-time model download on a fresh volume (the progress text must not look like a hang), and a remote or hosted MinerU endpoint set through `MINERU_URL`.
4. **Manual regression gate on real hardware.** Automated tests can't cover this. On a tablet with a stylus and on a trackpad, in both ask mode and pencil mode, check stylus drawing, two-finger pinch-zoom, Ctrl+wheel zoom, one-finger pan, right-click, the eraser, creating text boxes, and dragging sticky notes. Nothing may change outside ask mode.
5. **Highlight fidelity.** Rotate 90/180/270°, zoom to 50% and 300%, resize the chat panel, and reload. Each time, the highlights must still sit on the text. Double-click must jump to the right conversation, and the hover card must show the summary.
6. **Summary timing and cost.** Use the default 60 s idle and the "second selection triggers the summary right away" path. Reload with overdue sessions; only the 3 most recent should be summarised on catch-up. Check the per-summary token cost on OpenRouter, and confirm that typing in the composer postpones the summary.
7. **Deployment targets.**
   - `docker compose --profile prod up -d --build` behind a real domain: set `ORIGIN` correctly and put TLS in front.
   - A plain Vercel deploy: the adapter switch defaults to Vercel. Vercel's request body limit (~4.5 MB) may block uploads through `/api/mineru` for large PDFs, so this needs checking.
   - The Tauri desktop build: there is no relay there, so parsing is currently unsupported. Confirm this fails with a clear message and that OpenRouter calls still work.
8. **CI.** Run the unit, typecheck and e2e compose services in CI. The `Google Chrome` Playwright project (`channel: 'chrome'`) can't run in the container image, so run it on a host runner or install Chrome in the image.
9. **Multiple tabs and storage.** Open the same paper in two tabs; last write wins, and the IndexedDB schema upgrade must not block. Also check quota behaviour with many parsed documents cached, and that "Clear chats for this paper" leaves other papers alone.
10. **Coverage.** Run `pnpm test:coverage` in the unit container against the 80% threshold in `vitest.config.ts`. It hasn't been run as a gate yet.
