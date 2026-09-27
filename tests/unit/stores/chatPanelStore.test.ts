import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { chatPanelOpen } from '../../../src/lib/stores/chatPanelStore';
import { drawingState, setTool } from '../../../src/lib/stores/drawingStore';

beforeEach(() => {
	setTool('pencil');
	chatPanelOpen.set(false);
});

describe('chat panel follows the ask tool', () => {
	it('opens when the ask tool is chosen and closes when another tool is', () => {
		setTool('ask');
		expect(get(chatPanelOpen)).toBe(true);
		setTool('highlight');
		expect(get(chatPanelOpen)).toBe(false);
	});

	it('leaves a panel the user closed alone while other drawing settings change', () => {
		setTool('ask');
		chatPanelOpen.set(false);
		drawingState.update((s) => ({ ...s, color: '#ff0000' }));
		expect(get(chatPanelOpen)).toBe(false);
	});

	it('leaves a panel opened from another tool open until the tool changes', () => {
		chatPanelOpen.set(true);
		drawingState.update((s) => ({ ...s, lineWidth: 4 }));
		expect(get(chatPanelOpen)).toBe(true);
		setTool('eraser');
		expect(get(chatPanelOpen)).toBe(true);
	});
});
