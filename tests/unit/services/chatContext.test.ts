import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { structuredContentToDocument } from '../../../src/lib/services/docParser/mineruContent';
import type { ParsedBlock, ParsedDocument } from '../../../src/lib/services/docParser/types';
import {
	buildMessages,
	buildSessionContext,
	buildSkeleton,
	citedNumbers,
	documentMarkdown,
	findBlockForSelection,
	sectionPath,
	selectWindow,
	SYSTEM_PROMPT,
	type SelectionContext
} from '../../../src/lib/services/chatContext';

const paper = structuredContentToDocument(
	JSON.parse(readFileSync(resolve(__dirname, '../../fixtures/mineru/synthetic-paper.structured_content.json'), 'utf8')),
	'synthetic.pdf_1'
);
const block = (startsWith: string) => paper.blocks.find((b) => b.text.startsWith(startsWith))!;

/** A selection over the middle of a parsed block, as the text layer would capture it. */
function selectionIn(b: ParsedBlock, text = b.text.slice(0, 40)): SelectionContext {
	const r = b.bbox!;
	return {
		pageNumber: b.pageNumber,
		rects: [{ x: r.x + r.w * 0.1, y: r.y + r.h * 0.3, w: r.w * 0.5, h: r.h * 0.2 }],
		anchor: {
			pageNumber: b.pageNumber,
			text,
			charStart: 0,
			charEnd: text.length,
			itemStart: 0,
			itemEnd: 0,
			prefix: '',
			suffix: '',
			textHash: 'x'
		}
	};
}

const scaled = block('Scaled dot-product attention divides'); // in 3.1, cites [2]

describe('locating the selection', () => {
	it('finds the block under the selection by geometry', () => {
		expect(findBlockForSelection(paper, selectionIn(scaled))?.idx).toBe(scaled.idx);
	});

	it('falls back to the selected text when there is no geometry to go on', () => {
		const sel = { ...selectionIn(scaled, 'divides the logits by the square root'), rects: [] };
		expect(findBlockForSelection(paper, sel)?.idx).toBe(scaled.idx);
	});

	it('gives the section path, outermost first, without the document title', () => {
		expect(sectionPath(paper, scaled.idx).map((h) => h.text)).toEqual([
			'3 Model',
			'3.1 Scaled Dot-Product Attention'
		]);
	});
});

describe('buildSkeleton', () => {
	const skeleton = buildSkeleton(paper);

	it('has the title, abstract, outline and captions', () => {
		expect(skeleton).toContain('Title: Attention Mechanisms for Document Reading');
		expect(skeleton).toContain('Abstract: We study scaled dot-product attention');
		expect(skeleton).toContain('1 Introduction (p1)');
		expect(skeleton).toContain('  3.1 Scaled Dot-Product Attention (p2)'); // nested
		expect(skeleton).toContain('Table 1: Comparison of layer types. (p2)');
		expect(skeleton).toContain('Figure 1: An illustration of attention weights. (p2)');
	});

	it('contains no body text and no table contents', () => {
		// (The abstract is included on purpose; these are body paragraphs.)
		expect(skeleton).not.toContain('This paragraph discusses the motivation');
		expect(skeleton).not.toContain('divides the logits');
		expect(skeleton).not.toContain('| Self-attention |');
	});

	it('degrades a huge outline: top-level sections everywhere, subsections only near the focus', () => {
		const blocks: ParsedBlock[] = [];
		for (let s = 1; s <= 8; s++) {
			blocks.push({ idx: blocks.length, type: 'heading', level: 2, text: `${s} Section ${s}`, pageNumber: s });
			for (let k = 1; k <= 25; k++) {
				blocks.push({ idx: blocks.length, type: 'heading', level: 3, text: `${s}.${k} A fairly long subsection title number ${k}`, pageNumber: s });
				blocks.push({ idx: blocks.length, type: 'text', text: 'body', pageNumber: s });
			}
		}
		const big: ParsedDocument = {
			...paper,
			blocks,
			outline: blocks.filter((b) => b.type === 'heading').map((b) => ({ idx: b.idx, level: b.level!, text: b.text, pageNumber: b.pageNumber }))
		};
		const focus = blocks.find((b) => b.text === '5.3 A fairly long subsection title number 3')!.idx + 1;
		const s = buildSkeleton(big, focus, 4800);
		expect(s.length).toBeLessThanOrEqual(4800);
		for (let n = 1; n <= 8; n++) expect(s).toContain(`${n} Section ${n}`);
		expect(s).toContain('5.25 A fairly long');
		expect(s).not.toContain('2.1 A fairly long');
	});
});

describe('selectWindow', () => {
	it('always includes the passage and grows with whole neighbours inside its section', () => {
		const window = selectWindow(paper, scaled.idx);
		const texts = window.map((b) => b.text);
		expect(window.map((b) => b.idx)).toContain(scaled.idx);
		expect(texts.some((t) => t.startsWith('This paragraph discusses the attention function'))).toBe(true);
		// Not the introduction, a different top-level section.
		expect(texts.some((t) => t.startsWith('This paragraph discusses the motivation'))).toBe(false);
		// In reading order.
		expect(window.map((b) => b.idx)).toEqual([...window.map((b) => b.idx)].sort((a, b) => a - b));
	});

	it('keeps just the passage when the budget allows nothing else', () => {
		expect(selectWindow(paper, scaled.idx, 10).map((b) => b.idx)).toEqual([scaled.idx]);
	});

	it('pulls in a table the passage refers to, however far away', () => {
		const doc: ParsedDocument = {
			...paper,
			blocks: [
				{ idx: 0, type: 'heading', level: 2, text: '1 Results', pageNumber: 1 },
				{ idx: 1, type: 'text', text: 'As Table 3 shows, attention wins.', pageNumber: 1 },
				...Array.from({ length: 30 }, (_, i): ParsedBlock => ({ idx: i + 2, type: 'heading', level: 2, text: `${i + 2} Other`, pageNumber: 2 })),
				{ idx: 32, type: 'table', text: '| a | b |', caption: 'Table 3: The results.', pageNumber: 9 }
			],
			outline: []
		};
		doc.outline = doc.blocks.filter((b) => b.type === 'heading').map((b) => ({ idx: b.idx, level: 2, text: b.text, pageNumber: b.pageNumber }));
		expect(selectWindow(doc, 1).map((b) => b.idx)).toEqual([1, 32]);
	});
});

describe('citedNumbers', () => {
	it.each([
		['as in [2]', [2]],
		['see [3, 7] and [12]', [3, 7, 12]],
		['surveyed in [4–6]', [4, 5, 6]],
		['no citations here', []]
	])('%s → %j', (text, expected) => {
		expect(citedNumbers(text).sort((a, b) => a - b)).toEqual(expected);
	});
});

describe('buildSessionContext', () => {
	const ctx = buildSessionContext(paper, selectionIn(scaled));

	it('says where the passage is', () => {
		expect(ctx.snapshot).toContain('Location: page 2 of 2, 3 Model › 3.1 Scaled Dot-Product Attention');
		expect(ctx.blockIdx).toBe(scaled.idx);
	});

	it('includes the passage block and its surroundings', () => {
		expect(ctx.snapshot).toContain('[passage block]\nScaled dot-product attention divides');
	});

	it('resolves only the references the passage cites', () => {
		expect(ctx.snapshot).toContain('[2] B. Author. Attention is a useful inductive bias.');
		expect(ctx.snapshot).not.toContain('[1] A. Author');
		expect(ctx.tiers.map((t) => t.name)).toEqual(['passage location', 'surrounding text', 'citations']);
	});

	it('marks equations the parser could not transcribe instead of sending nothing', () => {
		const doc: ParsedDocument = {
			...paper,
			blocks: [
				{ idx: 0, type: 'text', text: 'We define attention as', pageNumber: 1, bbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.05 } },
				{ idx: 1, type: 'equation', text: '', pageNumber: 1, bbox: { x: 0.3, y: 0.16, w: 0.4, h: 0.04 } }
			],
			outline: [],
			references: []
		};
		const c = buildSessionContext(doc, selectionIn(doc.blocks[0]));
		expect(c.snapshot).toContain('[equation — not transcribed; it is visible on the page]');
	});
});

describe('buildMessages', () => {
	const ctx = buildSessionContext(paper, selectionIn(scaled));
	const session = { snapshot: ctx.snapshot, quotedText: 'divides the logits', focusBlockIdx: ctx.blockIdx };

	it('puts instructions and the paper skeleton, and only those, in the system message', () => {
		const [system] = buildMessages({ doc: paper, session, history: [], question: 'Why?' });
		expect(system.role).toBe('system');
		expect(system.content).toContain(SYSTEM_PROMPT);
		expect(system.content).toContain('<paper>');
		expect(system.content).not.toContain('<context>');
		expect(system.content).not.toContain('divides the logits');
	});

	it('keeps the system message identical across conversations on the same paper', () => {
		const other = buildSessionContext(paper, selectionIn(block('This paragraph discusses the motivation')));
		const a = buildMessages({ doc: paper, session, history: [], question: 'Q1' })[0];
		const b = buildMessages({
			doc: paper,
			session: { snapshot: other.snapshot, quotedText: 'x', focusBlockIdx: other.blockIdx },
			history: [],
			question: 'Q2'
		})[0];
		expect(a.content).toBe(b.content);
	});

	it('sends context with the first question, and only the question afterwards', () => {
		const first = buildMessages({ doc: paper, session, history: [], question: 'Why scale?' });
		expect(first).toHaveLength(2);
		expect(first[1].content).toBe(`${ctx.snapshot}\n\n<selection>divides the logits</selection>\n\nWhy scale?`);

		const third = buildMessages({
			doc: paper,
			session,
			history: [
				{ role: 'user', content: 'Why scale?' },
				{ role: 'assistant', content: 'To keep gradients healthy.' },
				{ role: 'user', content: 'By how much?' },
				{ role: 'assistant', content: 'By sqrt(dk).' }
			],
			question: 'Would layer norm work instead?'
		});
		expect(third.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user']);
		expect(third[1].content).toBe(first[1].content); // pinned, byte-identical
		expect(third.at(-1)!.content).toBe('Would layer norm work instead?');
		expect(third.filter((m) => String(m.content).includes('<context>'))).toHaveLength(1);
	});

	it('drops middle turns of a long conversation but never the pinned first one', () => {
		const history = Array.from({ length: 30 }, (_, i) => ({
			role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
			content: `turn ${i}`
		}));
		const msgs = buildMessages({ doc: paper, session, history, question: 'latest', maxHistoryTurns: 2 });
		expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user']);
		expect(msgs[1].content).toContain('turn 0');
		expect(msgs.at(-1)!.content).toBe('latest');
	});

	it('adds the whole paper to the system message when asked', () => {
		const [system] = buildMessages({ doc: paper, session, history: [], question: 'q', wholePaper: true });
		expect(system.content).toContain('<full_text>');
		expect(system.content).toContain('### 3.1 Scaled Dot-Product Attention');
		expect(system.content).toContain('This paragraph discusses the motivation');
	});

	it('attaches the page image to the question being asked', () => {
		const msgs = buildMessages({ doc: paper, session, history: [], question: 'What does this show?', pageImage: 'data:image/webp;base64,AAA' });
		expect(msgs.at(-1)!.content).toEqual([
			{ type: 'text', text: expect.stringContaining('What does this show?') },
			{ type: 'image_url', image_url: { url: 'data:image/webp;base64,AAA' } }
		]);
	});
});

describe('documentMarkdown', () => {
	it('renders headings by level and stops at the budget', () => {
		expect(documentMarkdown(paper)).toContain('## 1 Introduction');
		expect(documentMarkdown(paper, 200)).toMatch(/\[… truncated\]$/);
	});
});
