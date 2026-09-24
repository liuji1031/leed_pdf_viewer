import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
	addChatHighlight,
	chatHighlights,
	currentPageChatHighlights,
	deleteChatHighlight,
	pdfState,
	setCurrentPDF,
	updateChatHighlight,
	type ChatHighlight
} from '../../../src/lib/stores/drawingStore';

const storage = () => (globalThis as any).testHelpers.localStorageMock;

function highlight(id: string, pageNumber: number, overrides: Partial<ChatHighlight> = {}): ChatHighlight {
	return {
		id,
		pageNumber,
		sessionId: `session-${id}`,
		rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.02 }],
		anchor: {
			pageNumber,
			text: 'scaled dot-product attention',
			charStart: 10,
			charEnd: 38,
			itemStart: 1,
			itemEnd: 1,
			prefix: 'We call it ',
			suffix: '. The input',
			textHash: 'abc12345'
		},
		createdAt: 1,
		ordinal: 1,
		summaryStatus: 'none',
		...overrides
	};
}

beforeEach(() => {
	storage().getItem.mockReset();
	storage().setItem.mockReset();
	chatHighlights.set(new Map());
	pdfState.update((s) => ({ ...s, currentPage: 1 }));
});

afterEach(() => {
	chatHighlights.set(new Map());
});

describe('chat highlights store', () => {
	it('adds, updates and deletes per page', () => {
		addChatHighlight(highlight('a', 1));
		addChatHighlight(highlight('b', 2));
		expect(get(chatHighlights).get(1)?.map((h) => h.id)).toEqual(['a']);
		expect(get(chatHighlights).get(2)?.map((h) => h.id)).toEqual(['b']);

		updateChatHighlight(highlight('a', 1, { summaryStatus: 'ready', summary: 'Scales logits.' }));
		expect(get(chatHighlights).get(1)?.[0].summary).toBe('Scales logits.');

		deleteChatHighlight('a', 1);
		expect(get(chatHighlights).get(1) ?? []).toEqual([]);
		expect(get(chatHighlights).get(2)?.map((h) => h.id)).toEqual(['b']);
	});

	it('exposes the current page’s highlights', () => {
		addChatHighlight(highlight('p1', 1));
		addChatHighlight(highlight('p3', 3));
		expect(get(currentPageChatHighlights).map((h) => h.id)).toEqual(['p1']);
		pdfState.update((s) => ({ ...s, currentPage: 3 }));
		expect(get(currentPageChatHighlights).map((h) => h.id)).toEqual(['p3']);
	});

	it('persists under its own key for the current document', () => {
		setCurrentPDF('paper.pdf', 100);
		storage().setItem.mockClear();

		addChatHighlight(highlight('a', 2));

		const writes = storage().setItem.mock.calls.filter(([key]: [string]) =>
			key.startsWith('leedpdf_chat_highlights_')
		);
		expect(writes.at(-1)?.[0]).toBe('leedpdf_chat_highlights_paper.pdf_100');
		expect(JSON.parse(writes.at(-1)?.[1])).toEqual({ '2': [highlight('a', 2)] });
	});

	it('loads each document’s own highlights when switching documents', () => {
		const saved = { '1': [highlight('from-disk', 1)] };
		storage().getItem.mockImplementation((key: string) =>
			key === 'leedpdf_chat_highlights_paper.pdf_100' ? JSON.stringify(saved) : null
		);

		setCurrentPDF('paper.pdf', 100);
		expect(get(chatHighlights).get(1)?.map((h) => h.id)).toEqual(['from-disk']);

		setCurrentPDF('other.pdf', 7);
		expect(get(chatHighlights).size).toBe(0);
	});
});
