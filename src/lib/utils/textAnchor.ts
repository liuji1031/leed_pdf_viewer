/**
 * Durable anchors for text selected on a PDF page.
 *
 * A selection is captured as two independent pieces of data:
 *  - geometry: NormRects in rotation-0 storage space, normalised to 0..1 of the
 *    unrotated page, so they survive zoom, rotation, re-render and reload;
 *  - text: character offsets into the page's canonical text plus prefix/suffix
 *    context, so the passage can be re-located if the text is re-extracted.
 *
 * Everything here is pure. The DOM-touching wrappers (rangeToClientRects,
 * resolving Range endpoints to text items) are deliberately thin, because jsdom
 * returns all-zero rects and cannot exercise the geometry — the pure halves carry
 * the risk and the tests.
 */

import {
	getRotatedDimensions,
	inverseTransformPoint,
	transformPoint,
	type RotationAngle
} from './rotationUtils';

/** Rect in rotation-0 storage space, normalised to 0..1 of the unrotated page. */
export interface NormRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Structural subset of DOMRect, so tests can pass plain objects. */
export interface RectLike {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface TextItemLike {
	str: string;
	hasEOL?: boolean;
}

/** A page's text flattened into one string, with per-item offsets. */
export interface PageTextIndex {
	pageNumber: number;
	/** Items joined by joinItems' rule. */
	text: string;
	/** itemOffsets[i] is where item i starts in `text`; index-aligned with the items. */
	itemOffsets: number[];
	itemLengths: number[];
	/** Hash of `text`; a cheap check that offsets still refer to the same text. */
	textHash: string;
}

export interface TextAnchor {
	pageNumber: number;
	/** The selected string, whitespace-collapsed and trimmed. */
	text: string;
	/** Offsets into PageTextIndex.text, trimmed of surrounding whitespace. -1 if unknown. */
	charStart: number;
	charEnd: number;
	itemStart: number;
	itemEnd: number;
	/** Up to CONTEXT_CHARS of whitespace-collapsed text either side, for re-location. */
	prefix: string;
	suffix: string;
	textHash: string;
}

/** A point inside the page text: an item index and a character offset within it. */
export interface TextPosition {
	item: number;
	offset: number;
}

export const CONTEXT_CHARS = 48;
export const MAX_RECTS = 200;
const MIN_SELECTION_CHARS = 2;
const DECIMALS = 5;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function round(n: number): number {
	const f = 10 ** DECIMALS;
	return Math.round(n * f) / f;
}

/**
 * Merge per-span client rects into one rect per line fragment.
 *
 * A selection over a paragraph yields a rect per text span — often hundreds.
 * Rects whose vertical centres are within half the shorter height are treated as
 * the same line, and neighbours on a line merge when the horizontal gap between
 * them is under 0.35 of the line height. Both thresholds are relative to the rect
 * height, so the result doesn't depend on the zoom level or a live pinch transform.
 */
export function coalesceLineRects(rects: RectLike[]): RectLike[] {
	const valid = rects.filter(
		(r) =>
			Number.isFinite(r.left) &&
			Number.isFinite(r.top) &&
			Number.isFinite(r.width) &&
			Number.isFinite(r.height) &&
			r.width > 0 &&
			r.height > 0
	);

	const lines: RectLike[][] = [];
	for (const r of [...valid].sort((a, b) => a.top - b.top || a.left - b.left)) {
		const centre = r.top + r.height / 2;
		const line = lines.find((l) => {
			const ref = l[0];
			const refCentre = ref.top + ref.height / 2;
			return Math.abs(centre - refCentre) < Math.min(ref.height, r.height) / 2;
		});
		if (line) line.push(r);
		else lines.push([r]);
	}

	const merged: RectLike[] = [];
	for (const line of lines) {
		line.sort((a, b) => a.left - b.left);
		let cur = { ...line[0] };
		for (const r of line.slice(1)) {
			const gap = r.left - (cur.left + cur.width);
			if (gap < 0.35 * Math.max(cur.height, r.height)) {
				const top = Math.min(cur.top, r.top);
				const right = Math.max(cur.left + cur.width, r.left + r.width);
				const bottom = Math.max(cur.top + cur.height, r.top + r.height);
				cur = { left: cur.left, top, width: right - cur.left, height: bottom - top };
			} else {
				merged.push(cur);
				cur = { ...r };
			}
		}
		merged.push(cur);
	}

	return merged.sort((a, b) => a.top - b.top || a.left - b.left);
}

/**
 * Convert selection client rects into storage-space NormRects.
 *
 * `base` is the text layer's own bounding rect. Normalising against it — rather
 * than dividing by the viewer's scale — folds in the zoom, device pixel ratio, a
 * live pinch transform and the pan offset all at once, so nothing can drift
 * mid-gesture.
 */
export function clientRectsToNormRects(
	rects: RectLike[],
	base: RectLike,
	rotation: RotationAngle,
	basePageWidth: number,
	basePageHeight: number
): NormRect[] {
	if (base.width <= 0 || base.height <= 0 || basePageWidth <= 0 || basePageHeight <= 0) {
		return [];
	}

	const [dispW, dispH] = getRotatedDimensions(basePageWidth, basePageHeight, rotation);

	// A drag that overshoots the page yields rects for whatever else the range
	// covers; keep only the part of each rect that lies on the page.
	const onPage = rects
		.map((r) => {
			const left = Math.max(r.left, base.left);
			const top = Math.max(r.top, base.top);
			const right = Math.min(r.left + r.width, base.left + base.width);
			const bottom = Math.min(r.top + r.height, base.top + base.height);
			return { left, top, width: right - left, height: bottom - top };
		})
		.filter((r) => r.width > 0 && r.height > 0);

	return coalesceLineRects(onPage)
		.slice(0, MAX_RECTS)
		.map((r) => {
			// Client px -> display-space page units (rotated, scale 1).
			const x0 = ((r.left - base.left) / base.width) * dispW;
			const y0 = ((r.top - base.top) / base.height) * dispH;
			const x1 = ((r.left + r.width - base.left) / base.width) * dispW;
			const y1 = ((r.top + r.height - base.top) / base.height) * dispH;

			// De-rotate opposite corners. At 90/270 the axes swap, so rebuild the
			// axis-aligned rect from min/max rather than trusting corner order.
			const a = inverseTransformPoint(x0, y0, rotation, basePageWidth, basePageHeight);
			const b = inverseTransformPoint(x1, y1, rotation, basePageWidth, basePageHeight);

			const left = Math.min(a.x, b.x);
			const top = Math.min(a.y, b.y);
			return {
				x: round(left / basePageWidth),
				y: round(top / basePageHeight),
				w: round((Math.max(a.x, b.x) - left) / basePageWidth),
				h: round((Math.max(a.y, b.y) - top) / basePageHeight)
			};
		});
}

/** Inverse of clientRectsToNormRects: storage NormRect -> CSS px within the page layer. */
export function normRectToDisplay(
	rect: NormRect,
	rotation: RotationAngle,
	basePageWidth: number,
	basePageHeight: number,
	scale: number
): RectLike {
	const a = transformPoint(
		rect.x * basePageWidth,
		rect.y * basePageHeight,
		rotation,
		basePageWidth,
		basePageHeight
	);
	const b = transformPoint(
		(rect.x + rect.w) * basePageWidth,
		(rect.y + rect.h) * basePageHeight,
		rotation,
		basePageWidth,
		basePageHeight
	);
	const left = Math.min(a.x, b.x);
	const top = Math.min(a.y, b.y);
	return {
		left: left * scale,
		top: top * scale,
		width: (Math.max(a.x, b.x) - left) * scale,
		height: (Math.max(a.y, b.y) - top) * scale
	};
}

/** DOM wrapper — untestable in jsdom (all-zero rects), so it does nothing else. */
export function rangeToClientRects(range: Range): RectLike[] {
	return Array.from(range.getClientRects());
}

// ---------------------------------------------------------------------------
// DOM endpoints -> text positions
// ---------------------------------------------------------------------------

/** The text layer's spans, in item order, with a reverse lookup. */
export interface SpanIndex {
	spans: readonly Element[];
	itemOf: Map<Node, number>;
}

export function createSpanIndex(spans: readonly Element[]): SpanIndex {
	return { spans, itemOf: new Map(spans.map((span, i) => [span, i])) };
}

/**
 * Resolve a Range boundary point to a position in the page text.
 *
 * Inside a span, the offset is the number of characters before the point. A
 * point between spans — on the layer container, a marked-content wrapper, a
 * <br>, or outside the layer altogether — snaps to the nearest span edge: the
 * start of the next span for a range start, the end of the previous span for a
 * range end. Returns null when no span lies on the relevant side.
 */
export function domPointToTextPosition(
	node: Node,
	offset: number,
	index: SpanIndex,
	edge: 'start' | 'end'
): TextPosition | null {
	const doc = node.ownerDocument ?? (node as Document);

	for (let el: Node | null = node; el; el = el.parentNode) {
		const item = index.itemOf.get(el);
		if (item === undefined) continue;
		const before = doc.createRange();
		before.setStart(el, 0);
		before.setEnd(node, offset);
		return { item, offset: before.toString().length };
	}

	const point = doc.createRange();
	point.setStart(node, offset);
	point.collapse(true);
	const { spans } = index;

	if (edge === 'start') {
		// First span starting at or after the point.
		for (let i = 0; i < spans.length; i++) {
			if (point.comparePoint(spans[i], 0) >= 0) return { item: i, offset: 0 };
		}
		return null;
	}
	// Last span starting before the point.
	for (let i = spans.length - 1; i >= 0; i--) {
		if (point.comparePoint(spans[i], 0) < 0) {
			return { item: i, offset: spans[i].textContent?.length ?? 0 };
		}
	}
	return null;
}

/** Both ends of a Range as text positions, or null if either can't be resolved. */
export function rangeToTextPositions(
	range: Range,
	index: SpanIndex
): [TextPosition, TextPosition] | null {
	const start = domPointToTextPosition(range.startContainer, range.startOffset, index, 'start');
	const end = domPointToTextPosition(range.endContainer, range.endOffset, index, 'end');
	return start && end ? [start, end] : null;
}

// ---------------------------------------------------------------------------
// Text offsets
// ---------------------------------------------------------------------------

/** FNV-1a, 32-bit. Deterministic and dependency-free; collision resistance isn't needed. */
export function hashText(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

function collapseWhitespace(s: string): string {
	return s.replace(/\s+/g, ' ');
}

/**
 * Separator placed before item `i`: a newline after an end-of-line item, a space
 * where two items would otherwise run together, nothing where either side
 * already supplies whitespace.
 */
function separatorBefore(prev: TextItemLike, next: TextItemLike): string {
	if (prev.hasEOL) return '\n';
	if (!prev.str || !next.str) return '';
	if (/\s$/.test(prev.str) || /^\s/.test(next.str)) return '';
	return ' ';
}

export function buildPageTextIndex(pageNumber: number, items: TextItemLike[]): PageTextIndex {
	let text = '';
	const itemOffsets: number[] = [];
	const itemLengths: number[] = [];

	items.forEach((item, i) => {
		if (i > 0) text += separatorBefore(items[i - 1], item);
		itemOffsets.push(text.length);
		itemLengths.push(item.str.length);
		text += item.str;
	});

	return { pageNumber, text, itemOffsets, itemLengths, textHash: hashText(text) };
}

function toGlobalOffset(idx: PageTextIndex, pos: TextPosition): number | null {
	if (!Number.isInteger(pos.item) || pos.item < 0 || pos.item >= idx.itemOffsets.length) {
		return null;
	}
	const offset = Math.max(0, Math.min(pos.offset, idx.itemLengths[pos.item]));
	return idx.itemOffsets[pos.item] + offset;
}

/**
 * Build an anchor from two positions in the page text. Order doesn't matter, so a
 * backwards drag produces the same anchor as a forwards one. Returns null for a
 * selection too short to be meaningful or positions outside the index.
 */
export function offsetsToAnchor(
	idx: PageTextIndex,
	a: TextPosition,
	b: TextPosition
): TextAnchor | null {
	const ga = toGlobalOffset(idx, a);
	const gb = toGlobalOffset(idx, b);
	if (ga === null || gb === null) return null;

	const [first, last] = ga <= gb ? [a, b] : [b, a];
	let start = Math.min(ga, gb);
	let end = Math.max(ga, gb);

	// Trim whitespace off the range itself, not just the extracted string, so the
	// prefix/suffix boundaries line up with the text when re-locating.
	while (start < end && /\s/.test(idx.text[start])) start++;
	while (end > start && /\s/.test(idx.text[end - 1])) end--;

	const text = collapseWhitespace(idx.text.slice(start, end));
	if (text.length < MIN_SELECTION_CHARS) return null;

	return {
		pageNumber: idx.pageNumber,
		text,
		charStart: start,
		charEnd: end,
		itemStart: first.item,
		itemEnd: last.item,
		prefix: collapseWhitespace(idx.text.slice(Math.max(0, start - CONTEXT_CHARS), start)),
		suffix: collapseWhitespace(idx.text.slice(end, end + CONTEXT_CHARS)),
		textHash: idx.textHash
	};
}

/**
 * idx.text with whitespace runs collapsed, plus a map from each collapsed index
 * back to its raw index. map[collapsed.length] is the raw length, so a match
 * ending at the end of the text maps cleanly.
 */
function collapsedView(raw: string): { text: string; map: number[] } {
	let text = '';
	const map: number[] = [];
	for (let i = 0; i < raw.length; i++) {
		if (/\s/.test(raw[i])) {
			if (text.endsWith(' ')) continue;
			map.push(i);
			text += ' ';
		} else {
			map.push(i);
			text += raw[i];
		}
	}
	map.push(raw.length);
	return { text, map };
}

function occurrences(haystack: string, needle: string): number[] {
	const found: number[] = [];
	if (!needle) return found;
	for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
		found.push(i);
	}
	return found;
}

/**
 * Find an anchor's passage in (possibly re-extracted) page text.
 *
 * Tries, in order: the stored offsets if the text is unchanged; the full
 * prefix+text+suffix context; the text near its original item; the text anywhere,
 * but only if it occurs exactly once. Returns null rather than guess between
 * several equally plausible matches.
 */
export function relocate(anchor: TextAnchor, idx: PageTextIndex): { start: number; end: number } | null {
	if (
		anchor.textHash === idx.textHash &&
		anchor.charStart >= 0 &&
		anchor.charEnd <= idx.text.length &&
		anchor.charStart < anchor.charEnd
	) {
		return { start: anchor.charStart, end: anchor.charEnd };
	}

	const view = collapsedView(idx.text);
	const toRaw = (collapsedStart: number) => {
		const start = view.map[collapsedStart];
		const end = view.map[collapsedStart + anchor.text.length];
		return { start, end };
	};

	const withContext = occurrences(view.text, anchor.prefix + anchor.text + anchor.suffix);
	if (withContext.length === 1) return toRaw(withContext[0] + anchor.prefix.length);

	const matches = occurrences(view.text, anchor.text);
	if (matches.length === 0) return null;

	const itemRaw = idx.itemOffsets[anchor.itemStart];
	if (itemRaw !== undefined) {
		const from = view.map.findIndex((raw) => raw >= itemRaw);
		const near = matches.find((m) => m >= from && m - from <= 500);
		if (near !== undefined) return toRaw(near);
	}

	return matches.length === 1 ? toRaw(matches[0]) : null;
}
