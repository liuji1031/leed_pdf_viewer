import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	MinerUFormatError,
	structuredContentToDocument
} from '../../../src/lib/services/docParser/mineruContent';

// Real MinerU 4.0.7 output — see tests/fixtures/mineru/README.md.
const fixture = (name: string) =>
	JSON.parse(readFileSync(resolve(__dirname, '../../fixtures/mineru', name), 'utf8'));

const paper = structuredContentToDocument(
	fixture('synthetic-paper.structured_content.json'),
	'synthetic-paper.pdf_3762',
	1234
);

describe('structuredContentToDocument — probe page', () => {
	const doc = structuredContentToDocument(fixture('probes.structured_content.json'), 'probes.pdf_1', 1);

	it('returns blocks in reading order, not drawing order', () => {
		// The probe PDF draws title, bottom-right, centre; MinerU reorders top to bottom.
		expect(doc.blocks.map((b) => b.text)).toEqual([
			'Scaled Dot-Product Attention',
			'centre probe text',
			'bottom-right probe'
		]);
	});

	it('keeps bboxes in the same normalised, top-left space as highlight rects', () => {
		const title = doc.blocks[0].bbox!;
		// Drawn at x=72pt on a 612pt page, 232pt wide.
		expect(title.x).toBeCloseTo(72 / 612, 2);
		expect(title.x + title.w).toBeCloseTo((72 + 232.11) / 612, 2);
		expect(title.y).toBeLessThan(0.15); // near the top, so y grows downward
		expect(doc.blocks.every((b) => b.pageNumber === 1)).toBe(true);
	});

	it('records the parser version and tier', () => {
		expect(doc.parser).toEqual({ name: 'mineru', version: '4.0.7', tier: 'flash' });
		expect(doc.pageCount).toBe(1);
		expect(doc.schemaVersion).toBe(1);
	});
});

describe('structuredContentToDocument — two-column paper', () => {
	const indexOf = (text: string) => paper.blocks.findIndex((b) => b.text.startsWith(text));

	it('finds the title and the abstract', () => {
		expect(paper.title).toBe('Attention Mechanisms for Document Reading');
		expect(paper.abstract).toMatch(/^We study scaled dot-product attention/);
	});

	it('reads the left column before the right one', () => {
		const intro = indexOf('1 Introduction');
		const introBody = indexOf('This paragraph discusses the motivation');
		const background = indexOf('2 Background');
		expect(intro).toBeLessThan(introBody);
		expect(introBody).toBeLessThan(background);
	});

	it('builds an outline with depth taken from section numbering', () => {
		expect(paper.outline.map((o) => [o.level, o.text])).toEqual([
			[1, 'Attention Mechanisms for Document Reading'],
			[2, 'Abstract'],
			[2, '1 Introduction'],
			[2, '2 Background'],
			[2, '3 Model'],
			[3, '3.1 Scaled Dot-Product Attention'],
			[2, 'References']
		]);
		expect(paper.outline.find((o) => o.text === '3 Model')?.pageNumber).toBe(2);
	});

	it('keeps tables as Markdown with their caption', () => {
		const table = paper.blocks.find((b) => b.type === 'table')!;
		expect(table.caption).toBe('Table 1: Comparison of layer types.');
		expect(table.text).toContain('| Self-attention |');
	});

	it('recognises a caption the parser left as plain text', () => {
		const caption = paper.blocks.find((b) => b.text.startsWith('Figure 1:'))!;
		expect(caption.type).toBe('caption');
	});

	it('parses the reference list into citation markers', () => {
		expect(paper.references).toEqual([
			{ marker: '[1]', text: 'A. Author. Learning with recurrent networks. Journal of Examples, 2020.' },
			{ marker: '[2]', text: 'B. Author. Attention is a useful inductive bias. Proceedings of Samples, 2021.' }
		]);
	});

	it('numbers blocks consecutively in reading order and drops base64 crops', () => {
		expect(paper.blocks.map((b) => b.idx)).toEqual(paper.blocks.map((_, i) => i));
		expect(JSON.stringify(paper)).not.toContain('base64');
	});
});

describe('structuredContentToDocument — edge cases', () => {
	const page = (blocks: unknown[]) => ({ pages: [{ page_idx: 0, blocks }] });

	it('demotes flash-tier "headings" that are really equations or email addresses', () => {
		const doc = structuredContentToDocument(
			page([
				{ type: 'paragraph_title', level: 2, content: '3.2.2 Multi-Head Attention' },
				{ type: 'paragraph_title', level: 2, content: 'MultiHead(Q, K, V) = Concat(head<sub>1</sub>, ..., head<sub>h</sub>)W<sup>O</sup>' },
				{ type: 'paragraph_title', level: 2, content: 'illia.polosukhin@gmail.com' }
			]),
			'k'
		);
		expect(doc.blocks.map((b) => b.type)).toEqual(['heading', 'equation', 'text']);
		expect(doc.outline.map((o) => o.text)).toEqual(['3.2.2 Multi-Head Attention']);
	});

	it('drops page furniture but keeps footnotes', () => {
		const doc = structuredContentToDocument(
			page([
				{ type: 'page_number', bbox: [0.5, 0.95, 0.52, 0.97], content: '3' },
				{ type: 'aside_text', bbox: [0.02, 0.3, 0.05, 0.7], content: 'arXiv:0000.00000v1' },
				{ type: 'page_footnote', bbox: [0.1, 0.9, 0.9, 0.93], content: '* Equal contribution.' },
				{ type: 'text', bbox: [0.1, 0.1, 0.9, 0.2], content: 'Body text.' }
			]),
			'k'
		);
		expect(doc.blocks.map((b) => b.type)).toEqual(['footnote', 'text']);
	});

	it('rescales legacy 0-1000 bboxes and treats an all-zero bbox as unknown', () => {
		const doc = structuredContentToDocument(
			page([
				{ type: 'text', bbox: [100, 200, 900, 250], content: 'legacy' },
				{ type: 'text', bbox: [0, 0, 0, 0], content: 'unknown' }
			]),
			'k'
		);
		expect(doc.blocks[0].bbox).toEqual({ x: 0.1, y: 0.2, w: 0.8, h: expect.closeTo(0.05, 6) });
		expect(doc.blocks[1].bbox).toBeUndefined();
	});

	it('keeps an equation the parser saw only as an image, with empty text', () => {
		const doc = structuredContentToDocument(
			page([{ type: 'equation', bbox: [0.3, 0.5, 0.8, 0.55], content: '', image_source: 'data:image/jpeg;base64,xyz' }]),
			'k'
		);
		expect(doc.blocks).toEqual([
			{ idx: 0, type: 'equation', text: '', pageNumber: 1, bbox: { x: 0.3, y: 0.5, w: expect.closeTo(0.5, 6), h: expect.closeTo(0.05, 6) } }
		]);
	});

	it('flattens structured list content and keeps unknown text-bearing types', () => {
		const doc = structuredContentToDocument(
			page([
				{ type: 'list', content: [{ content: 'first' }, { content: 'second' }] },
				{ type: 'some_future_type', content: 'still useful' },
				{ type: 'some_future_type', content: '' }
			]),
			'k'
		);
		expect(doc.blocks.map((b) => [b.type, b.text])).toEqual([
			['list', 'first\nsecond'],
			['text', 'still useful']
		]);
	});

	it('uses an inline "Abstract —" paragraph when there is no heading', () => {
		const doc = structuredContentToDocument(
			page([{ type: 'text', content: 'Abstract — We propose a thing.' }]),
			'k'
		);
		expect(doc.abstract).toBe('We propose a thing.');
	});

	it('rejects output that is not a parse result', () => {
		expect(() => structuredContentToDocument(null, 'k')).toThrow(MinerUFormatError);
		expect(() => structuredContentToDocument({ blocks: [] }, 'k')).toThrow(MinerUFormatError);
		expect(() => structuredContentToDocument({ pages: {} }, 'k')).toThrow(MinerUFormatError);
	});

	it('accepts an empty document', () => {
		const doc = structuredContentToDocument({ pages: [] }, 'k', 5);
		expect(doc).toMatchObject({ blocks: [], outline: [], references: [], pageCount: 0, parsedAt: 5 });
	});
});
