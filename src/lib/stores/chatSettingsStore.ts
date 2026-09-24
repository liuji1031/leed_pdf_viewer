import { writable } from 'svelte/store';

/**
 * Chat assistant settings, kept in this browser's localStorage. The API key is
 * the user's own and is sent only to the configured endpoint — there is no
 * server-side proxy, so it works the same in the web and desktop builds.
 */
export interface ChatSettings {
	apiKey: string;
	endpoint: string;
	chatModel: string;
	/** Defaults to the chat model when empty; a cheaper model saves money. */
	summaryModel: string;
	/** Idle time after an answer before its conversation is summarised. */
	summaryIdleMs: number;
	autoSummarize: boolean;
}

export const CHAT_SETTINGS_KEY = 'leedpdf_chat_settings';

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
	apiKey: '',
	endpoint: 'https://openrouter.ai/api/v1',
	chatModel: 'anthropic/claude-sonnet-5',
	summaryModel: '',
	summaryIdleMs: 60_000,
	autoSummarize: true
};

/** Merge stored values over the defaults, ignoring anything malformed. */
export function parseChatSettings(raw: string | null): ChatSettings {
	if (!raw) return { ...DEFAULT_CHAT_SETTINGS };
	try {
		const stored = JSON.parse(raw) as Partial<Record<keyof ChatSettings, unknown>>;
		const pick = <K extends keyof ChatSettings>(key: K, valid: (v: unknown) => boolean) =>
			(valid(stored[key]) ? stored[key] : DEFAULT_CHAT_SETTINGS[key]) as ChatSettings[K];
		const isString = (v: unknown) => typeof v === 'string';
		return {
			apiKey: pick('apiKey', isString),
			endpoint: pick('endpoint', (v) => isString(v) && (v as string).trim() !== ''),
			chatModel: pick('chatModel', (v) => isString(v) && (v as string).trim() !== ''),
			summaryModel: pick('summaryModel', isString),
			summaryIdleMs: pick('summaryIdleMs', (v) => typeof v === 'number' && v >= 5_000),
			autoSummarize: pick('autoSummarize', (v) => typeof v === 'boolean')
		};
	} catch {
		return { ...DEFAULT_CHAT_SETTINGS };
	}
}

function readStored(): ChatSettings {
	if (typeof window === 'undefined') return { ...DEFAULT_CHAT_SETTINGS };
	try {
		return parseChatSettings(localStorage.getItem(CHAT_SETTINGS_KEY));
	} catch {
		return { ...DEFAULT_CHAT_SETTINGS };
	}
}

export const chatSettings = writable<ChatSettings>(readStored());

chatSettings.subscribe((settings) => {
	if (typeof window === 'undefined') return;
	try {
		localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(settings));
	} catch (error) {
		console.warn('Could not save chat settings:', error);
	}
});

export function updateChatSettings(patch: Partial<ChatSettings>) {
	chatSettings.update((s) => ({ ...s, ...patch }));
}

/** The model to summarise with: the summary model if set, else the chat model. */
export function summaryModelOf(settings: ChatSettings): string {
	return settings.summaryModel.trim() || settings.chatModel;
}
