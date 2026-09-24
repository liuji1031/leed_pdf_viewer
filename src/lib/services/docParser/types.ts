import type { NormRect } from '$lib/utils/textAnchor';

/**
 * The app's own representation of a parsed paper, independent of the parser's
 * wire format. Everything the chat context needs is sliced from this.
 */

export type ParsedBlockType =
	| 'heading'
	| 'text'
	| 'table'
	| 'figure'
	| 'equation'
	/** A figure/table caption that the parser didn't attach to a figure or table. */
	| 'caption'
	| 'footnote'
	| 'list'
	| 'code';

export interface ParsedBlock {
	/** Position in reading order across the whole document, 0-based. */
	idx: number;
	type: ParsedBlockType;
	/** Headings only: 1 = document title, 2 = section, 3 = subsection, … */
	level?: number;
	/** Markdown. Tables are Markdown tables; equations are LaTeX, or empty when
	 * the parser only recognised them as images. */
	text: string;
	caption?: string;
	pageNumber: number;
	/** Rotation-0, normalised to the page — the same space as highlight rects. */
	bbox?: NormRect;
	/** Continues the previous text block, across a column or page break. */
	continuesPrev?: boolean;
}

export interface OutlineEntry {
	idx: number;
	level: number;
	text: string;
	pageNumber: number;
}

export interface Reference {
	/** As cited in the text, e.g. "[12]". */
	marker: string;
	text: string;
}

export const PARSED_DOCUMENT_SCHEMA_VERSION = 1;

export interface ParsedDocument {
	schemaVersion: typeof PARSED_DOCUMENT_SCHEMA_VERSION;
	pdfKey: string;
	parsedAt: number;
	parser: { name: 'mineru'; version?: string; tier?: string };
	pageCount: number;
	title?: string;
	abstract?: string;
	blocks: ParsedBlock[];
	outline: OutlineEntry[];
	references: Reference[];
}
