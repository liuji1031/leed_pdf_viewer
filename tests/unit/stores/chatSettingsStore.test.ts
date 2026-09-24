import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
	CHAT_SETTINGS_KEY,
	chatSettings,
	DEFAULT_CHAT_SETTINGS,
	parseChatSettings,
	summaryModelOf,
	updateChatSettings
} from '../../../src/lib/stores/chatSettingsStore';

const storage = () => (globalThis as any).testHelpers.localStorageMock;

describe('parseChatSettings', () => {
	it('returns the defaults when nothing is stored or the JSON is corrupt', () => {
		expect(parseChatSettings(null)).toEqual(DEFAULT_CHAT_SETTINGS);
		expect(parseChatSettings('{oops')).toEqual(DEFAULT_CHAT_SETTINGS);
	});

	it('merges stored values over the defaults', () => {
		const parsed = parseChatSettings(JSON.stringify({ apiKey: 'sk-or-1', summaryIdleMs: 120_000 }));
		expect(parsed).toEqual({ ...DEFAULT_CHAT_SETTINGS, apiKey: 'sk-or-1', summaryIdleMs: 120_000 });
	});

	it('falls back field by field for invalid values instead of discarding everything', () => {
		const parsed = parseChatSettings(
			JSON.stringify({
				apiKey: 'sk-or-1',
				endpoint: '   ',
				chatModel: 42,
				summaryIdleMs: 10, // below the 5s floor
				autoSummarize: 'yes'
			})
		);
		expect(parsed.apiKey).toBe('sk-or-1');
		expect(parsed.endpoint).toBe(DEFAULT_CHAT_SETTINGS.endpoint);
		expect(parsed.chatModel).toBe(DEFAULT_CHAT_SETTINGS.chatModel);
		expect(parsed.summaryIdleMs).toBe(DEFAULT_CHAT_SETTINGS.summaryIdleMs);
		expect(parsed.autoSummarize).toBe(DEFAULT_CHAT_SETTINGS.autoSummarize);
	});
});

describe('chatSettings store', () => {
	beforeEach(() => {
		chatSettings.set({ ...DEFAULT_CHAT_SETTINGS });
		storage().setItem.mockClear();
	});

	it('persists every update under its key', () => {
		updateChatSettings({ apiKey: 'sk-or-2' });
		expect(get(chatSettings).apiKey).toBe('sk-or-2');
		const [key, value] = storage().setItem.mock.calls.at(-1);
		expect(key).toBe(CHAT_SETTINGS_KEY);
		expect(JSON.parse(value).apiKey).toBe('sk-or-2');
	});

	it('summarises with the chat model unless a summary model is set', () => {
		expect(summaryModelOf({ ...DEFAULT_CHAT_SETTINGS, summaryModel: '  ' })).toBe(DEFAULT_CHAT_SETTINGS.chatModel);
		expect(summaryModelOf({ ...DEFAULT_CHAT_SETTINGS, summaryModel: 'anthropic/claude-haiku-4.5' })).toBe(
			'anthropic/claude-haiku-4.5'
		);
	});
});
