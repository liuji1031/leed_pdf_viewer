/**
 * The chat feature must not change existing annotation behaviour. These tests pin
 * that down as each piece lands, rather than leaving it as a claim in the plan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get, type Readable } from 'svelte/store';
import {
	arrowAnnotations,
	drawingPaths,
	drawingState,
	imageAnnotations,
	setTool,
	stampAnnotations,
	stickyNoteAnnotations,
	textAnnotations,
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
