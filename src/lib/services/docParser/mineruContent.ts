/**
 * MinerU `structured_content` → ParsedDocument.
 *
 * Written against real MinerU 4.0.7 output (see tests/fixtures/mineru), not its
 * docs — the published schema documents describe a legacy format and a draft
 * of the next one, and match neither:
 *
 *   { pages: [{ page_idx, blocks: [{ type, bbox: [x0,y0,x1,y1], content, … }] }],
 *     metadata: { producer: { version }, document: { page_count } },
 *     extensions: { mineru: { tier } } }
 *
 * bbox is normalised 0..1 with a top-left origin — the same space as highlight
 * rects. Headings are doc_title / paragraph_title with a `level`; tables are
 * Markdown with `captions`; images and equations carry a base64 `image_source`
 * crop, which is discarded (it's ~90% of the payload and the app has the page).
 */

import type { NormRect } from '$lib/utils/textAnchor';
import {
	PARSED_DOCUMENT_SCHEMA_VERSION,
	type OutlineEntry,
	type ParsedBlock,
	type ParsedBlockType,
	type ParsedDocument,
	type Reference
} from './types';

export class MinerUFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MinerUFormatError';
	}
}

// Page furniture: repeated on every page and useless as context.
const FURNITURE = new Set(['page_number', 'page_header', 'page_footer', 'aside_text', 'header', 'footer']);

const CAPTION = /^(figure|fig\.|table)\s*\d+[a-z]?\s*[:.]/i;
const NUMBERED_HEADING = /^(\d+(?:\.\d+)*)\.?\s+\S/;
const ABSTRACT_HEADING = /^abstract$/i;
const REFERENCES_HEADING = /^(references|bibliography|works cited)$/i;
const INLINE_ABSTRACT = /^abstract\s*[.:—–-]\s*/i;

type RawBlock = Record<string, unknown>;

function flattenContent(content: unknown): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => (typeof c === 'string' ? c : flattenContent((c as RawBlock)?.content)))
			.filter(Boolean)
			.join('\n');
	}
	if (content && typeof content === 'object') {
		const inner = (content as RawBlock).content ?? (content as RawBlock).text;
		return inner !== undefined ? flattenContent(inner) : '';
	}
	return '';
}

function toNormRect(raw: unknown): NormRect | undefined {
	if (!Array.isArray(raw) || raw.length !== 4 || !raw.every((n) => typeof n === 'number' && Number.isFinite(n))) {
		return undefined;
	}
	let [x0, y0, x1, y1] = raw as number[];
	if (x0 === 0 && y0 === 0 && x1 === 0 && y1 === 0) return undefined; // "unknown" bbox
	// Older servers normalise to 0..1000 instead of 0..1.
	if (Math.max(x0, y0, x1, y1) > 1.5) [x0, y0, x1, y1] = [x0, y0, x1, y1].map((n) => n / 1000);
	const clamp = (n: number) => Math.min(1, Math.max(0, n));
	[x0, y0, x1, y1] = [x0, y0, x1, y1].map(clamp);
	if (x1 <= x0 || y1 <= y0) return undefined;
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function captionOf(block: RawBlock): string | undefined {
	const captions = block.captions;
	if (!Array.isArray(captions)) return undefined;
	const text = captions
		.map((c) => flattenContent((c as RawBlock)?.content))
		.filter(Boolean)
		.join(' ');
	return text || undefined;
}

/**
 * Section depth from the heading's own numbering, when it has any: "3" → 2,
 * "3.1" → 3. Flash-tier parsing reports every section heading at the same
 * level, so the numbering is the more reliable signal.
 */
function headingLevel(text: string, reported: unknown): number {
	const numbered = NUMBERED_HEADING.exec(text);
	if (numbered) return numbered[1].split('.').length + 1;
	return typeof reported === 'number' && reported >= 1 ? Math.min(Math.round(reported), 6) : 2;
}

// Flash-tier parsing labels some display equations and author emails as
// headings ("MultiHead(Q, K, V) = Concat(…)"); they'd pollute the outline that
// goes into every prompt. Real headings essentially never contain either.
const LOOKS_LIKE_EQUATION = /=/;
const LOOKS_LIKE_EMAIL = /^\S+@\S+\.\S+$/;

function classify(type: string, text: string): ParsedBlockType | null {
	switch (type) {
		case 'doc_title':
		case 'paragraph_title':
		case 'title':
			if (type !== 'doc_title' && LOOKS_LIKE_EQUATION.test(text)) return 'equation';
			if (LOOKS_LIKE_EMAIL.test(text.trim())) return 'text';
			return 'heading';
		case 'table':
		case 'simple_table':
		case 'complex_table':
			return 'table';
		case 'image':
		case 'chart':
		case 'figure':
			return 'figure';
		case 'equation':
		case 'equation_interline':
		case 'interline_equation':
			return 'equation';
		case 'page_footnote':
		case 'footnote':
			return 'footnote';
		case 'list':
		case 'text_list':
		case 'reference_list':
		case 'index':
			return 'list';
		case 'code':
		case 'algorithm':
			return 'code';
		default:
			// 'text', and any type a newer server adds: keep it if it has text.
			if (!text.trim()) return null;
			return CAPTION.test(text.trim()) ? 'caption' : 'text';
	}
}

/** Split reference-list text into "[n] …" entries. */
function parseReferences(text: string): Reference[] {
	const refs: Reference[] = [];
	const pattern = /\[(\d+)\]\s*([\s\S]*?)(?=\s*\[\d+\]\s|$)/g;
	for (const m of text.matchAll(pattern)) {
		const body = m[2].replace(/\s+/g, ' ').trim();
		if (body) refs.push({ marker: `[${m[1]}]`, text: body });
	}
	return refs;
}

export function structuredContentToDocument(
	raw: unknown,
	pdfKey: string,
	parsedAt = Date.now()
): ParsedDocument {
	if (!raw || typeof raw !== 'object') throw new MinerUFormatError('Parser output is not an object');
	const sc = raw as RawBlock;
	if (!Array.isArray(sc.pages)) throw new MinerUFormatError('Parser output has no pages');

	const blocks: ParsedBlock[] = [];
	let title: string | undefined;

	sc.pages.forEach((page: unknown, pageIndex: number) => {
		const p = (page ?? {}) as RawBlock;
		const pageIdx = typeof p.page_idx === 'number' ? p.page_idx : pageIndex;
		const rawBlocks = Array.isArray(p.blocks) ? p.blocks : [];
		for (const item of rawBlocks as RawBlock[]) {
			if (!item || typeof item !== 'object') continue;
			const type = typeof item.type === 'string' ? item.type : 'text';
			if (FURNITURE.has(type)) continue;

			const text = flattenContent(item.content).trim();
			const kind = classify(type, text);
			if (!kind) continue;

			const block: ParsedBlock = {
				idx: blocks.length,
				type: kind,
				text,
				pageNumber: pageIdx + 1
			};
			const bbox = toNormRect(item.bbox);
			if (bbox) block.bbox = bbox;
			const caption = captionOf(item);
			if (caption) block.caption = caption;
			if (item.continues_prev === true) block.continuesPrev = true;
			if (kind === 'heading') {
				if (!text) continue;
				block.level = type === 'doc_title' ? 1 : headingLevel(text, item.level);
				if (type === 'doc_title' && !title) title = text;
			}
			blocks.push(block);
		}
	});

	const outline: OutlineEntry[] = blocks
		.filter((b) => b.type === 'heading')
		.map((b) => ({ idx: b.idx, level: b.level ?? 2, text: b.text, pageNumber: b.pageNumber }));

	// Abstract: the text under an "Abstract" heading, or a paragraph that opens
	// with "Abstract —" when there's no heading for it.
	let abstract: string | undefined;
	const absHeading = blocks.findIndex((b) => b.type === 'heading' && ABSTRACT_HEADING.test(b.text));
	if (absHeading !== -1) {
		const parts: string[] = [];
		for (const b of blocks.slice(absHeading + 1)) {
			if (b.type === 'heading') break;
			if (b.type === 'text') parts.push(b.text);
		}
		abstract = parts.join('\n\n') || undefined;
	} else {
		const inline = blocks.find((b) => b.type === 'text' && INLINE_ABSTRACT.test(b.text));
		if (inline) abstract = inline.text.replace(INLINE_ABSTRACT, '');
	}

	// References: everything under the references heading, up to the next heading.
	const refHeading = blocks.findIndex((b) => b.type === 'heading' && REFERENCES_HEADING.test(b.text));
	let references: Reference[] = [];
	if (refHeading !== -1) {
		const refText: string[] = [];
		for (const b of blocks.slice(refHeading + 1)) {
			if (b.type === 'heading') break;
			if (b.type === 'text' || b.type === 'list') refText.push(b.text);
		}
		references = parseReferences(refText.join('\n'));
	}

	const metadata = (sc.metadata ?? {}) as RawBlock;
	const documentMeta = (metadata.document ?? {}) as RawBlock;
	const producer = (metadata.producer ?? {}) as RawBlock;
	const mineruExt = ((sc.extensions as RawBlock | undefined)?.mineru ?? {}) as RawBlock;

	return {
		schemaVersion: PARSED_DOCUMENT_SCHEMA_VERSION,
		pdfKey,
		parsedAt,
		parser: {
			name: 'mineru',
			...(typeof producer.version === 'string' && { version: producer.version }),
			...(typeof mineruExt.tier === 'string' && { tier: mineruExt.tier })
		},
		pageCount:
			typeof documentMeta.page_count === 'number' ? documentMeta.page_count : sc.pages.length,
		...(title && { title }),
		...(abstract && { abstract }),
		blocks,
		outline,
		references
	};
}
