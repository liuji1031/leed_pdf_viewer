import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
	CHAT_SETTINGS_KEY,
	chatSettings,
	DEFAULT_CHAT_SETTINGS,
	parseChatSettings,
	updateChatSettings
} from '../../../src/lib/stores/chatSettingsStore';

const storage = () => (globalThis as any).testHelpers.localStorageMock;

describe('parseChatSettings', () => {
	it('returns the defaults when nothing is stored or the JSON is corrupt', () => {
		expect(parseChatSettings(null)).toEqual(DEFAULT_CHAT_SETTINGS);
		expect(parseChatSettings('{oops')).toEqual(DEFAULT_CHAT_SETTINGS);
	});

	it('merges stored values over the defaults', () => {
		const parsed = parseChatSettings(JSON.stringify({ parserTier: 'standard', summaryIdleMs: 120_000 }));
		expect(parsed).toEqual({ ...DEFAULT_CHAT_SETTINGS, parserTier: 'standard', summaryIdleMs: 120_000 });
	});

	it('drops an API key, endpoint and models saved by an older version', () => {
		const parsed = parseChatSettings(
			JSON.stringify({
				apiKey: 'sk-or-1',
				endpoint: 'https://openrouter.ai/api/v1',
				chatModel: 'a/b',
				summaryModel: 'c/d'
			})
		);
		expect(parsed).toEqual(DEFAULT_CHAT_SETTINGS);
		expect(parsed).not.toHaveProperty('apiKey');
		expect(parsed).not.toHaveProperty('summaryModel');
	});

	it('falls back field by field for invalid values instead of discarding everything', () => {
		const parsed = parseChatSettings(
			JSON.stringify({
				parserTier: 'standard',
				summaryIdleMs: 10, // below the 5s floor
				autoSummarize: 'yes'
			})
		);
		expect(parsed.parserTier).toBe('standard');
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
		updateChatSettings({ summaryIdleMs: 120_000 });
		expect(get(chatSettings).summaryIdleMs).toBe(120_000);
		const [key, value] = storage().setItem.mock.calls.at(-1);
		expect(key).toBe(CHAT_SETTINGS_KEY);
		expect(JSON.parse(value).summaryIdleMs).toBe(120_000);
	});
});
