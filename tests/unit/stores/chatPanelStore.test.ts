import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { chatPanelOpen, toggleChatPanel } from '../../../src/lib/stores/chatPanelStore';
import { drawingState, setTool } from '../../../src/lib/stores/drawingStore';

beforeEach(() => {
	setTool('pencil');
	chatPanelOpen.set(false);
});

describe('chat panel', () => {
	it('starts open when nothing is remembered, and remembers being closed', async () => {
		const getItem = vi.mocked(localStorage.getItem);
		const load = async (stored: string | null) => {
			getItem.mockImplementation((key: string) => (key === 'leedpdf_chat_panel_open' ? stored : null));
			vi.resetModules();
			return (await import('../../../src/lib/stores/chatPanelStore')).chatPanelOpen;
		};
		const fresh = await load(null);
		expect(get(fresh)).toBe(true);
		fresh.set(false);
		expect(localStorage.setItem).toHaveBeenCalledWith('leedpdf_chat_panel_open', 'false');
		expect(get(await load('false'))).toBe(false);
		getItem.mockReset();
	});

	it('opens when the ask tool is chosen and stays open on other tools', () => {
		setTool('ask');
		expect(get(chatPanelOpen)).toBe(true);
		setTool('highlight');
		expect(get(chatPanelOpen)).toBe(true);
	});

	it('leaves a panel the user closed alone while drawing settings or tools change', () => {
		setTool('ask');
		chatPanelOpen.set(false);
		drawingState.update((s) => ({ ...s, color: '#ff0000' }));
		setTool('eraser');
		expect(get(chatPanelOpen)).toBe(false);
	});

	it('toggles', () => {
		toggleChatPanel();
		expect(get(chatPanelOpen)).toBe(true);
		toggleChatPanel();
		expect(get(chatPanelOpen)).toBe(false);
	});
});
