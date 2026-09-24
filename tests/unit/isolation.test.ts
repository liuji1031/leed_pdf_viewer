/**
 * The chat feature must not change existing annotation behaviour. These tests pin
 * that down as each piece lands, rather than leaving it as a claim in the plan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get, type Readable } from 'svelte/store';
import {
	addChatHighlight,
	arrowAnnotations,
	chatHighlights,
	clearCurrentPageDrawings,
	deleteChatHighlight,
	drawingPaths,
	drawingState,
	imageAnnotations,
	pdfState,
	setCurrentPDF,
	setTool,
	stampAnnotations,
	stickyNoteAnnotations,
	textAnnotations,
	updateChatHighlight,
	type ChatHighlight,
	type DrawingTool
} from '../../src/lib/stores/drawingStore';
import {
	keyboardShortcuts,
	type KeyboardShortcutsParams
} from '../../src/lib/utils/keyboardShortcuts';

const EXISTING_TOOL_KEYS: Array<[string, DrawingTool]> = [
	['1', 'pencil'],
	['2', 'eraser'],
	['3', 'text'],
	['4', 'arrow'],
	['5', 'highlight'],
	['6', 'note'],
	['7', 'select']
];

const annotationStores: Record<string, Readable<unknown>> = {
	drawingPaths,
	textAnnotations,
	stickyNoteAnnotations,
	stampAnnotations,
	arrowAnnotations,
	imageAnnotations
};

function params(): KeyboardShortcutsParams {
	return {
		pdfViewer: null,
		showShortcuts: false,
		showThumbnails: false,
		focusMode: false,
		presentationMode: false,
		onShowShortcutsChange: vi.fn(),
		onShowThumbnailsChange: vi.fn(),
		onFocusModeChange: vi.fn(),
		onPresentationModeChange: vi.fn(),
		onFileUploadClick: vi.fn(),
		onStampToolClick: vi.fn()
	};
}

function press(target: EventTarget, key: string) {
	target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('isolation: ask tool', () => {
	let node: HTMLDivElement;
	let action: ReturnType<typeof keyboardShortcuts>;

	beforeEach(() => {
		setTool('pencil');
		node = document.createElement('div');
		document.body.appendChild(node);
		action = keyboardShortcuts(node, params());
	});

	afterEach(() => {
		action.destroy();
		node.remove();
		setTool('pencil');
	});

	describe('keyboard shortcuts', () => {
		it.each(EXISTING_TOOL_KEYS)('key %s still selects %s', (key, tool) => {
			setTool('ask');
			press(node, key);
			expect(get(drawingState).tool).toBe(tool);
		});

		it('key 8 selects the ask tool', () => {
			press(node, '8');
			expect(get(drawingState).tool).toBe('ask');
		});

		it('does not switch to ask while typing in a field', () => {
			const input = document.createElement('input');
			node.appendChild(input);
			press(input, '8');
			expect(get(drawingState).tool).toBe('pencil');
		});
	});

	describe('annotation stores', () => {
		it('are untouched by switching into and out of the ask tool', () => {
			const before = Object.fromEntries(
				Object.entries(annotationStores).map(([name, store]) => [name, get(store)])
			);

			setTool('ask');
			setTool('pencil');
			setTool('ask');

			for (const [name, store] of Object.entries(annotationStores)) {
				// Same Map instance: no update() was issued, not merely equal contents.
				expect(get(store), name).toBe(before[name]);
			}
		});

		it('leaves the rest of the drawing state alone', () => {
			const before = get(drawingState);
			setTool('ask');
			const after = get(drawingState);
			expect({ ...after, tool: before.tool }).toEqual(before);
		});
	});
});

describe('isolation: chat highlights', () => {
	const storage = () => (globalThis as any).testHelpers.localStorageMock;
	const highlight: ChatHighlight = {
		id: 'h1',
		pageNumber: 1,
		sessionId: 's1',
		rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.02 }],
		anchor: {
			pageNumber: 1,
			text: 'attention',
			charStart: 0,
			charEnd: 9,
			itemStart: 0,
			itemEnd: 0,
			prefix: '',
			suffix: '',
			textHash: '00000000'
		},
		createdAt: 1,
		ordinal: 1,
		summaryStatus: 'none'
	};

	beforeEach(() => {
		setCurrentPDF('isolation.pdf', 1);
		pdfState.update((s) => ({ ...s, currentPage: 1 }));
		chatHighlights.set(new Map());
		storage().setItem.mockClear();
	});

	it('editing highlights leaves the six existing annotation stores untouched', () => {
		const before = Object.fromEntries(
			Object.entries(annotationStores).map(([name, store]) => [name, get(store)])
		);

		addChatHighlight(highlight);
		updateChatHighlight({ ...highlight, summaryStatus: 'ready', summary: 'x' });
		deleteChatHighlight(highlight.id, highlight.pageNumber);

		for (const [name, store] of Object.entries(annotationStores)) {
			expect(get(store), name).toBe(before[name]);
		}
	});

	it('writes only its own localStorage key', () => {
		addChatHighlight(highlight);
		const keys = storage().setItem.mock.calls.map(([key]: [string]) => key);
		expect(keys.length).toBeGreaterThan(0);
		for (const key of keys) expect(key).toMatch(/^leedpdf_chat_highlights_/);
	});

	it('survives "clear page", which still empties the existing stores', () => {
		addChatHighlight(highlight);
		drawingPaths.set(new Map([[1, [{ tool: 'pencil', color: '#000', lineWidth: 2, points: [], pageNumber: 1 }]]]));

		clearCurrentPageDrawings();

		expect(get(drawingPaths).get(1)).toBeUndefined();
		expect(get(chatHighlights).get(1)?.map((h) => h.id)).toEqual(['h1']);
	});
});
