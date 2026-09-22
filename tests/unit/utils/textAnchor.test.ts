import { describe, expect, it } from 'vitest';
import {
	buildPageTextIndex,
	clientRectsToNormRects,
	coalesceLineRects,
	CONTEXT_CHARS,
	hashText,
	MAX_RECTS,
	normRectToDisplay,
	offsetsToAnchor,
	relocate,
	type NormRect,
	type RectLike,
	type TextAnchor
} from '../../../src/lib/utils/textAnchor';
import { getRotatedDimensions, type RotationAngle } from '../../../src/lib/utils/rotationUtils';

const ROTATIONS: RotationAngle[] = [0, 90, 180, 270];
const SCALES = [0.5, 1, 3];
// Portrait and landscape: at 90/270 the axes swap, which a square page would hide.
const PAGES: Array<[string, number, number]> = [
	['portrait', 612, 792],
	['landscape', 792, 612]
];

/** Render a NormRect as the text layer would, then express it as a client rect. */
function toClient(
	rect: NormRect,
	rotation: RotationAngle,
	pageW: number,
	pageH: number,
	scale: number,
	origin = { left: 37, top: 91 }
): { client: RectLike; base: RectLike } {
	const d = normRectToDisplay(rect, rotation, pageW, pageH, scale);
	const [dispW, dispH] = getRotatedDimensions(pageW, pageH, rotation);
	return {
		client: { left: origin.left + d.left, top: origin.top + d.top, width: d.width, height: d.height },
		base: { left: origin.left, top: origin.top, width: dispW * scale, height: dispH * scale }
	};
}

function expectRectClose(actual: NormRect, expected: NormRect) {
	// Output is rounded to 5 decimals.
	expect(Math.abs(actual.x - expected.x)).toBeLessThan(1e-5);
	expect(Math.abs(actual.y - expected.y)).toBeLessThan(1e-5);
	expect(Math.abs(actual.w - expected.w)).toBeLessThan(1e-5);
	expect(Math.abs(actual.h - expected.h)).toBeLessThan(1e-5);
}

describe('textAnchor geometry', () => {
	const samples: NormRect[] = [
		{ x: 0.1, y: 0.2, w: 0.3, h: 0.015 },
		{ x: 0.62, y: 0.81, w: 0.25, h: 0.02 },
		{ x: 0, y: 0, w: 0.05, h: 0.01 }
	];

	describe('round-trip through display space', () => {
		for (const [label, pageW, pageH] of PAGES) {
			for (const rotation of ROTATIONS) {
				for (const scale of SCALES) {
					it(`${label} page, ${rotation}°, scale ${scale}`, () => {
						for (const rect of samples) {
							const { client, base } = toClient(rect, rotation, pageW, pageH, scale);
							const [back] = clientRectsToNormRects([client], base, rotation, pageW, pageH);
							expectRectClose(back, rect);
						}
					});
				}
			}
		}
	});

	it('is invariant to a live pinch transform scaling the whole layer', () => {
		const rect = samples[0];
		const { client, base } = toClient(rect, 90, 612, 792, 1);
		const k = 1.73;
		const pinch = (r: RectLike): RectLike => ({
			left: r.left * k,
			top: r.top * k,
			width: r.width * k,
			height: r.height * k
		});
		const [back] = clientRectsToNormRects([pinch(client)], pinch(base), 90, 612, 792);
		expectRectClose(back, rect);
	});

	it('returns nothing for a degenerate base or page', () => {
		const client = { left: 10, top: 10, width: 50, height: 10 };
		expect(clientRectsToNormRects([client], { left: 0, top: 0, width: 0, height: 100 }, 0, 612, 792)).toEqual([]);
		expect(clientRectsToNormRects([client], { left: 0, top: 0, width: 100, height: 100 }, 0, 0, 792)).toEqual([]);
	});

	describe('coalesceLineRects', () => {
		it('merges adjacent span fragments on the same line', () => {
			const merged = coalesceLineRects([
				{ left: 10, top: 100, width: 40, height: 12 },
				{ left: 52, top: 100.5, width: 30, height: 12 },
				{ left: 83, top: 99.8, width: 60, height: 12 }
			]);
			expect(merged).toHaveLength(1);
			expect(merged[0].left).toBe(10);
			expect(merged[0].left + merged[0].width).toBe(143);
		});

		it('keeps separate lines separate', () => {
			const merged = coalesceLineRects([
				{ left: 10, top: 100, width: 200, height: 12 },
				{ left: 10, top: 115, width: 200, height: 12 },
				{ left: 10, top: 130, width: 90, height: 12 }
			]);
			expect(merged).toHaveLength(3);
		});

		it('does not bridge a wide gap on one line (e.g. across columns)', () => {
			const merged = coalesceLineRects([
				{ left: 10, top: 100, width: 200, height: 12 },
				{ left: 320, top: 100, width: 200, height: 12 }
			]);
			expect(merged).toHaveLength(2);
		});

		it('drops zero-area, negative and non-finite rects', () => {
			const merged = coalesceLineRects([
				{ left: 10, top: 100, width: 0, height: 12 },
				{ left: 10, top: 100, width: 40, height: 0 },
				{ left: 10, top: 100, width: -5, height: 12 },
				{ left: NaN, top: 100, width: 40, height: 12 },
				{ left: 10, top: 200, width: 40, height: 12 }
			]);
			expect(merged).toEqual([{ left: 10, top: 200, width: 40, height: 12 }]);
		});

		it('is order-independent', () => {
			const rects = [
				{ left: 52, top: 100, width: 30, height: 12 },
				{ left: 10, top: 115, width: 30, height: 12 },
				{ left: 10, top: 100, width: 40, height: 12 }
			];
			expect(coalesceLineRects(rects)).toEqual(coalesceLineRects([...rects].reverse()));
		});
	});

	it(`caps output at ${MAX_RECTS} rects`, () => {
		const lines = Array.from({ length: MAX_RECTS + 100 }, (_, i) => ({
			left: 0,
			top: i * 3,
			width: 50,
			height: 2
		}));
		const base = { left: 0, top: 0, width: 612, height: 1000 };
		expect(clientRectsToNormRects(lines, base, 0, 612, 1000)).toHaveLength(MAX_RECTS);
	});
});

describe('textAnchor text offsets', () => {
	const items = [
		{ str: 'We call our particular attention' },
		{ str: '"Scaled Dot-Product Attention".', hasEOL: true },
		{ str: 'The input consists of queries' },
		{ str: ' and keys of dimension dk.' }
	];
	const idx = buildPageTextIndex(4, items);

	describe('buildPageTextIndex', () => {
		it('joins with a space, a newline after EOL, and nothing where whitespace exists', () => {
			expect(idx.text).toBe(
				'We call our particular attention "Scaled Dot-Product Attention".\n' +
					'The input consists of queries and keys of dimension dk.'
			);
		});

		it('records offsets that index back to each item', () => {
			items.forEach((item, i) => {
				expect(idx.text.slice(idx.itemOffsets[i], idx.itemOffsets[i] + idx.itemLengths[i])).toBe(item.str);
			});
		});

		it('hashes deterministically', () => {
			expect(idx.textHash).toBe(hashText(idx.text));
			expect(buildPageTextIndex(4, items).textHash).toBe(idx.textHash);
			expect(hashText('a')).not.toBe(hashText('b'));
		});

		it('handles an empty page', () => {
			const empty = buildPageTextIndex(1, []);
			expect(empty.text).toBe('');
			expect(empty.itemOffsets).toEqual([]);
		});
	});

	describe('offsetsToAnchor', () => {
		// "Scaled Dot-Product Attention" inside item 1, after the opening quote.
		const start = { item: 1, offset: 1 };
		const end = { item: 1, offset: 29 };

		it('captures the selected text and its offsets', () => {
			const a = offsetsToAnchor(idx, start, end)!;
			expect(a.text).toBe('Scaled Dot-Product Attention');
			expect(idx.text.slice(a.charStart, a.charEnd)).toBe('Scaled Dot-Product Attention');
			expect(a.pageNumber).toBe(4);
			expect(a.textHash).toBe(idx.textHash);
		});

		it('produces the same anchor for a backwards drag', () => {
			expect(offsetsToAnchor(idx, end, start)).toEqual(offsetsToAnchor(idx, start, end));
		});

		it('spans multiple items and collapses the line break', () => {
			const a = offsetsToAnchor(idx, { item: 1, offset: 20 }, { item: 2, offset: 9 })!;
			expect(a.text).toBe('Attention". The input');
			expect(a.itemStart).toBe(1);
			expect(a.itemEnd).toBe(2);
		});

		it('trims surrounding whitespace off the range itself', () => {
			// Item 3 starts with a space; select " and keys".
			const a = offsetsToAnchor(idx, { item: 3, offset: 0 }, { item: 3, offset: 9 })!;
			expect(a.text).toBe('and keys');
			expect(idx.text[a.charStart]).toBe('a');
			expect(a.prefix.endsWith('queries ')).toBe(true);
		});

		it(`clips prefix and suffix to ${CONTEXT_CHARS} chars`, () => {
			const a = offsetsToAnchor(idx, { item: 2, offset: 4 }, { item: 2, offset: 9 })!;
			expect(a.prefix.length).toBeLessThanOrEqual(CONTEXT_CHARS);
			expect(a.suffix.length).toBeLessThanOrEqual(CONTEXT_CHARS);
			expect(a.prefix.length).toBeGreaterThan(0);
		});

		it('clamps context at the page boundaries', () => {
			const first = offsetsToAnchor(idx, { item: 0, offset: 0 }, { item: 0, offset: 7 })!;
			expect(first.prefix).toBe('');
			const lastItem = items.length - 1;
			const last = offsetsToAnchor(
				idx,
				{ item: lastItem, offset: 15 },
				{ item: lastItem, offset: items[lastItem].str.length }
			)!;
			expect(last.suffix).toBe('');
		});

		it('rejects selections shorter than two characters, including whitespace-only', () => {
			expect(offsetsToAnchor(idx, { item: 0, offset: 0 }, { item: 0, offset: 1 })).toBeNull();
			expect(offsetsToAnchor(idx, { item: 0, offset: 2 }, { item: 0, offset: 2 })).toBeNull();
			expect(offsetsToAnchor(idx, { item: 3, offset: 0 }, { item: 3, offset: 1 })).toBeNull();
		});

		it('rejects positions outside the index and clamps offsets within an item', () => {
			expect(offsetsToAnchor(idx, { item: -1, offset: 0 }, start)).toBeNull();
			expect(offsetsToAnchor(idx, start, { item: 99, offset: 0 })).toBeNull();
			const clamped = offsetsToAnchor(idx, { item: 0, offset: 12 }, { item: 0, offset: 10_000 })!;
			expect(clamped.text).toBe('particular attention');
		});
	});
});

describe('textAnchor relocate', () => {
	const items = [
		{ str: 'Attention is computed as softmax of scaled scores.', hasEOL: true },
		{ str: 'We use scaled dot-product attention in every layer.', hasEOL: true },
		{ str: 'Unlike additive attention, scaled dot-product attention is fast.' }
	];
	const idx = buildPageTextIndex(4, items);

	const anchorFor = (item: number, from: number, to: number): TextAnchor =>
		offsetsToAnchor(idx, { item, offset: from }, { item, offset: to })!;

	it('trusts stored offsets when the page text is unchanged', () => {
		const a = anchorFor(1, 7, 35);
		expect(a.text).toBe('scaled dot-product attention');
		expect(relocate(a, idx)).toEqual({ start: a.charStart, end: a.charEnd });
	});

	it('finds the passage by context after the text shifted', () => {
		const a = anchorFor(1, 7, 35); // "scaled dot-product attention" in item 1
		const shifted = buildPageTextIndex(4, [{ str: 'Running header — page 4', hasEOL: true }, ...items]);
		expect(shifted.textHash).not.toBe(idx.textHash);
		const loc = relocate(a, shifted)!;
		expect(shifted.text.slice(loc.start, loc.end)).toBe('scaled dot-product attention');
		// The occurrence in item 1, not the identical phrase in item 2.
		expect(loc.start).toBeLessThan(shifted.itemOffsets[3]);
	});

	it('falls back to the occurrence nearest the original item when context changed', () => {
		const a = { ...anchorFor(2, 27, 55), prefix: 'no longer present', textHash: 'stale' };
		expect(a.text).toBe('scaled dot-product attention');
		const loc = relocate(a, idx)!;
		expect(idx.text.slice(loc.start, loc.end)).toBe('scaled dot-product attention');
		expect(loc.start).toBeGreaterThanOrEqual(idx.itemOffsets[2]);
	});

	it('refuses to guess between several matches with no context or item hint', () => {
		const a = { ...anchorFor(1, 7, 35), prefix: 'gone', textHash: 'stale', itemStart: 9999 };
		expect(relocate(a, idx)).toBeNull();
	});

	it('accepts a unique match anywhere', () => {
		const a = { ...anchorFor(0, 25, 32), prefix: 'gone', textHash: 'stale', itemStart: 9999 };
		expect(a.text).toBe('softmax');
		const loc = relocate(a, idx)!;
		expect(idx.text.slice(loc.start, loc.end)).toBe('softmax');
	});

	it('returns null when the text is gone', () => {
		const a = { ...anchorFor(0, 25, 32), text: 'nowhere to be found', textHash: 'stale' };
		expect(relocate(a, idx)).toBeNull();
	});

	it('ignores stored offsets for a geometry-only anchor', () => {
		const a = { ...anchorFor(0, 25, 32), charStart: -1, charEnd: -1 };
		const loc = relocate(a, idx)!;
		expect(idx.text.slice(loc.start, loc.end)).toBe('softmax');
	});
});
