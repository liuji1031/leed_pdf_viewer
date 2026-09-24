/**
 * What the model is told about the paper.
 *
 * Wire format (see the plan, §5a):
 *   system        instructions + the paper skeleton — title, abstract, outline,
 *                 captions. Document-constant, so provider prompt caching hits.
 *   first user    a context snapshot for the selected passage — where it sits,
 *                 the surrounding blocks, referenced figures/tables, resolved
 *                 citations — then the selection and the question. Frozen when
 *                 the conversation starts, so follow-ups reuse it verbatim.
 *   follow-ups    the question alone.
 *
 * Budgets are in characters (≈4 per token). Whole blocks only: a half-sentence
 * or half a formula is worse than none.
 */

import type { OpenRouterMessage } from './openRouter';
import type { OutlineEntry, ParsedBlock, ParsedDocument } from './docParser/types';
import type { NormRect, TextAnchor } from '$lib/utils/textAnchor';

export const SYSTEM_PROMPT =
	'You are a research-paper reading assistant. The user is reading the paper below and asks ' +
	'about passages they select. Ground answers in the paper and say when you draw on outside ' +
	'knowledge instead. Be concise and concrete. Use LaTeX for math ($…$ inline, $$…$$ display).';

export const BUDGET = {
	skeleton: 4800,
	abstract: 1800,
	window: 12000,
	citations: 1600,
	wholePaper: 120_000
} as const;

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export interface SelectionContext {
	pageNumber: number;
	anchor: TextAnchor;
	rects: NormRect[];
}

// ---------------------------------------------------------------------------
// Locating the selection in the parsed document
// ---------------------------------------------------------------------------

function overlap(a: NormRect, b: NormRect): number {
	const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
	const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
	return w > 0 && h > 0 ? w * h : 0;
}

const normalise = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();

/**
 * The block the selection sits in. Geometry first — both sides use the same
 * normalised page space — then the selected text, then the first text block on
 * the page. Null only if the page has no blocks at all.
 */
export function findBlockForSelection(doc: ParsedDocument, sel: SelectionContext): ParsedBlock | null {
	const onPage = doc.blocks.filter((b) => b.pageNumber === sel.pageNumber);
	let best: ParsedBlock | null = null;
	let bestArea = 0;
	for (const block of onPage) {
		if (!block.bbox) continue;
		const area = sel.rects.reduce((sum, r) => sum + overlap(r, block.bbox!), 0);
		if (area > bestArea) {
			best = block;
			bestArea = area;
		}
	}
	if (best) return best;

	const needle = normalise(sel.anchor.text).slice(0, 80);
	return (
		(needle && onPage.find((b) => normalise(b.text).includes(needle))) ||
		onPage.find((b) => b.type === 'text') ||
		onPage[0] ||
		null
	);
}

/** Headings enclosing a block, outermost first (excluding the document title). */
export function sectionPath(doc: ParsedDocument, blockIdx: number): OutlineEntry[] {
	const path: OutlineEntry[] = [];
	let depth = Infinity;
	for (let i = doc.outline.length - 1; i >= 0; i--) {
		const h = doc.outline[i];
		if (h.idx > blockIdx || h.level <= 1) continue;
		if (h.level < depth) {
			path.unshift(h);
			depth = h.level;
		}
	}
	return path;
}

// ---------------------------------------------------------------------------
// Skeleton (system message)
// ---------------------------------------------------------------------------

function clipAtSentence(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
	return (end > max * 0.5 ? cut.slice(0, end + 1) : cut.trimEnd()) + ' …';
}

function captionsOf(doc: ParsedDocument): { text: string; pageNumber: number; idx: number }[] {
	return doc.blocks
		.map((b) => ({ text: b.type === 'caption' ? b.text : (b.caption ?? ''), pageNumber: b.pageNumber, idx: b.idx }))
		.filter((c) => c.text);
}

/**
 * Title, abstract, outline and captions — headings only, never body text. Too
 * big? Keep levels 1–2 everywhere, deeper levels only in the focused section,
 * then drop far-away captions, then clip the abstract. Top-level headings are
 * never dropped: they're the model's map of the paper.
 */
export function buildSkeleton(doc: ParsedDocument, focusIdx?: number, budget: number = BUDGET.skeleton): string {
	const focusSection = focusIdx === undefined ? undefined : sectionPath(doc, focusIdx)[0];
	const focusEnd = focusSection
		? (doc.outline.find((h) => h.idx > focusSection.idx && h.level <= focusSection.level)?.idx ?? Infinity)
		: -1;
	const inFocus = (h: OutlineEntry) => !!focusSection && h.idx >= focusSection.idx && h.idx < focusEnd;

	const render = (outline: OutlineEntry[], captions: ReturnType<typeof captionsOf>, abstractMax: number) => {
		const lines = ['<paper>'];
		if (doc.title) lines.push(`Title: ${doc.title}`);
		lines.push(`Pages: ${doc.pageCount}`);
		if (doc.abstract) lines.push('', `Abstract: ${clipAtSentence(doc.abstract, abstractMax)}`);
		const headings = outline.filter((h) => h.level > 1);
		if (headings.length) {
			lines.push('', 'Outline:');
			for (const h of headings) lines.push(`${'  '.repeat(h.level - 2)}${h.text} (p${h.pageNumber})`);
		}
		if (captions.length) {
			lines.push('', 'Figures and tables:');
			for (const c of captions) lines.push(`  ${c.text} (p${c.pageNumber})`);
		}
		lines.push('</paper>');
		return lines.join('\n');
	};

	const allCaptions = captionsOf(doc);
	let text = render(doc.outline, allCaptions, BUDGET.abstract);
	if (text.length <= budget) return text;

	const trimmedOutline = doc.outline.filter((h) => h.level <= 2 || inFocus(h));
	text = render(trimmedOutline, allCaptions, BUDGET.abstract);
	if (text.length <= budget) return text;

	const near = focusIdx === undefined ? [] : allCaptions.filter((c) => Math.abs(c.idx - focusIdx) < 40);
	text = render(trimmedOutline, near, BUDGET.abstract);
	if (text.length <= budget) return text;

	return render(trimmedOutline, near, Math.max(300, BUDGET.abstract - (text.length - budget)));
}

// ---------------------------------------------------------------------------
// Local window (first user message)
// ---------------------------------------------------------------------------

function renderBlock(b: ParsedBlock): string {
	switch (b.type) {
		case 'table':
			return `[table${b.caption ? `: ${b.caption}` : ''}]\n${b.text}`;
		case 'figure':
			return `[figure${b.caption ? `: ${b.caption}` : ''}]`;
		case 'equation':
			// Parsed only as an image (flash tier): say so rather than send nothing.
			return b.text ? `[equation] $$${b.text}$$` : '[equation — not transcribed; it is visible on the page]';
		case 'heading':
			return `[heading] ${b.text}`;
		default:
			return b.text;
	}
}

const LABEL_REF = /\b(fig(?:ure)?\.?|table)\s*(\d+[a-z]?)/gi;

/** Figures and tables the passage refers to by number, wherever they are. */
function referencedFloats(doc: ParsedDocument, text: string, exclude: Set<number>): ParsedBlock[] {
	const wanted = new Set<string>();
	for (const m of text.matchAll(LABEL_REF)) {
		wanted.add(`${m[1].toLowerCase().startsWith('t') ? 'table' : 'figure'} ${m[2].toLowerCase()}`);
	}
	if (!wanted.size) return [];
	const labelOf = (b: ParsedBlock) => {
		const m = /^(fig(?:ure)?\.?|table)\s*(\d+[a-z]?)/i.exec(b.caption ?? (b.type === 'caption' ? b.text : ''));
		return m ? `${m[1].toLowerCase().startsWith('t') ? 'table' : 'figure'} ${m[2].toLowerCase()}` : null;
	};
	return doc.blocks.filter((b) => !exclude.has(b.idx) && wanted.has(labelOf(b) ?? ''));
}

/**
 * The containing block plus whole neighbours in reading order, alternating
 * outward, within the budget and within the current section. The containing
 * block is always included; if it alone is too big it's clipped at a sentence.
 */
export function selectWindow(doc: ParsedDocument, blockIdx: number, budget: number = BUDGET.window): ParsedBlock[] {
	const home = doc.blocks[blockIdx];
	if (!home) return [];
	const section = sectionPath(doc, blockIdx).at(-1);
	const leavesSection = (b: ParsedBlock) =>
		b.type === 'heading' && (b.level ?? 2) <= (section?.level ?? 2) && b.idx !== section?.idx;

	const picked = new Map<number, ParsedBlock>([[home.idx, home]]);
	let used = renderBlock(home).length;
	let before = blockIdx - 1;
	let after = blockIdx + 1;
	let canBefore = true;
	let canAfter = true;

	while (canBefore || canAfter) {
		for (const dir of ['before', 'after'] as const) {
			if (dir === 'before' ? !canBefore : !canAfter) continue;
			const b = doc.blocks[dir === 'before' ? before : after];
			// Stop at the section's own heading: the location line already names it.
			if (!b || (dir === 'after' && leavesSection(b)) || (dir === 'before' && b.idx <= (section?.idx ?? -1))) {
				if (dir === 'before') canBefore = false;
				else canAfter = false;
				continue;
			}
			const cost = renderBlock(b).length + 2;
			if (used + cost > budget) {
				if (dir === 'before') canBefore = false;
				else canAfter = false;
				continue;
			}
			picked.set(b.idx, b);
			used += cost;
			if (dir === 'before') before--;
			else after++;
		}
	}

	// Referenced figures/tables earn their place even far away.
	for (const f of referencedFloats(doc, home.text, new Set(picked.keys()))) {
		const cost = renderBlock(f).length + 2;
		if (used + cost <= budget * 1.25) {
			picked.set(f.idx, f);
			used += cost;
		}
	}
	return [...picked.values()].sort((a, b) => a.idx - b.idx);
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

/** Numbers cited as [3], [3, 7] or [3–5] in the text. */
export function citedNumbers(text: string): number[] {
	const found = new Set<number>();
	for (const m of text.matchAll(/\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g)) {
		for (const part of m[1].split(/\s*,\s*/)) {
			const range = part.split(/\s*[–-]\s*/).map(Number);
			if (range.length === 2 && range[1] >= range[0] && range[1] - range[0] < 20) {
				for (let n = range[0]; n <= range[1]; n++) found.add(n);
			} else found.add(range[0]);
		}
	}
	return [...found];
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface ContextTier {
	name: 'paper outline' | 'passage location' | 'surrounding text' | 'citations' | 'whole paper';
	tokens: number;
}

export interface SessionContext {
	/** Everything the first user message carries before the selection and question. */
	snapshot: string;
	/** Block the selection sits in, if the document has one there. */
	blockIdx: number | null;
	tiers: ContextTier[];
}

/** The per-conversation context: location, surrounding text, citations. */
export function buildSessionContext(doc: ParsedDocument, sel: SelectionContext): SessionContext {
	const home = findBlockForSelection(doc, sel);
	const lines: string[] = ['<context>'];
	const tiers: ContextTier[] = [];

	const path = home ? sectionPath(doc, home.idx) : [];
	const location = `Location: page ${sel.pageNumber} of ${doc.pageCount}${
		path.length ? `, ${path.map((h) => h.text).join(' › ')}` : ''
	}`;
	lines.push(location, '');
	tiers.push({ name: 'passage location', tokens: estimateTokens(location) });

	if (home) {
		const window = selectWindow(doc, home.idx);
		const text = window
			.map((b) => (b.idx === home.idx ? `[passage block]\n${renderBlock(b)}` : renderBlock(b)))
			.join('\n\n');
		lines.push(text);
		tiers.push({ name: 'surrounding text', tokens: estimateTokens(text) });

		const cited = citedNumbers(`${sel.anchor.text}\n${home.text}`);
		const refs: string[] = [];
		let used = 0;
		for (const n of cited) {
			const ref = doc.references.find((r) => r.marker === `[${n}]`);
			if (!ref) continue;
			const line = `${ref.marker} ${ref.text}`;
			if (used + line.length > BUDGET.citations) break;
			refs.push(line);
			used += line.length;
		}
		if (refs.length) {
			lines.push('', 'Cited works:', ...refs);
			tiers.push({ name: 'citations', tokens: estimateTokens(refs.join('\n')) });
		}
	}
	lines.push('</context>');
	return { snapshot: lines.join('\n'), blockIdx: home?.idx ?? null, tiers };
}

/** The paper as Markdown, for "whole paper" mode. */
export function documentMarkdown(doc: ParsedDocument, budget: number = BUDGET.wholePaper): string {
	const parts: string[] = [];
	let used = 0;
	for (const b of doc.blocks) {
		const text = b.type === 'heading' ? `${'#'.repeat(Math.min(b.level ?? 2, 6))} ${b.text}` : renderBlock(b);
		if (used + text.length > budget) {
			parts.push('[… truncated]');
			break;
		}
		parts.push(text);
		used += text.length + 2;
	}
	return parts.join('\n\n');
}

export interface MessagesInput {
	doc: ParsedDocument;
	/** Frozen when the conversation started. */
	session: { snapshot: string; quotedText: string; focusBlockIdx: number | null };
	/** Earlier turns, oldest first, excluding the question being asked now. */
	history: { role: 'user' | 'assistant'; content: string }[];
	question: string;
	wholePaper?: boolean;
	/** data: URL of the rendered page, for multimodal models. */
	pageImage?: string;
	/** Most recent turns kept besides the pinned first question. */
	maxHistoryTurns?: number;
}

export function buildMessages(input: MessagesInput): OpenRouterMessage[] {
	const { doc, session, history, question } = input;
	let system = `${SYSTEM_PROMPT}\n\n${buildSkeleton(doc, session.focusBlockIdx ?? undefined)}`;
	if (input.wholePaper) system += `\n\n<full_text>\n${documentMarkdown(doc)}\n</full_text>`;

	const opening = (q: string) => `${session.snapshot}\n\n<selection>${session.quotedText}</selection>\n\n${q}`;

	// The first user turn is pinned: it carries the conversation's context.
	const turns = [...history, { role: 'user' as const, content: question }];
	const first = turns[0];
	const keep = (input.maxHistoryTurns ?? 12) * 2;
	const rest = turns.slice(1);
	const kept = rest.length > keep ? rest.slice(rest.length - keep) : rest;

	const messages: OpenRouterMessage[] = [
		{ role: 'system', content: system },
		{ role: 'user', content: opening(first.content) },
		...kept.map((t) => ({ role: t.role, content: t.content }))
	];

	if (input.pageImage) {
		const last = messages[messages.length - 1];
		messages[messages.length - 1] = {
			role: 'user',
			content: [
				{ type: 'text', text: last.content as string },
				{ type: 'image_url', image_url: { url: input.pageImage } }
			]
		};
	}
	return messages;
}
