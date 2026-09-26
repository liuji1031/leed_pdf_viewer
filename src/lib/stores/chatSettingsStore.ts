import { writable } from 'svelte/store';

/**
 * Chat assistant settings, kept in this browser's localStorage. The OpenRouter
 * key and models are not here: the /api/openrouter relay takes them from the
 * server's OPENROUTER_API_KEY, OPENROUTER_MODEL and OPENROUTER_SUMMARY_MODEL.
 */
export interface ChatSettings {
	/** Idle time after an answer before its conversation is summarised. */
	summaryIdleMs: number;
	autoSummarize: boolean;
	/** The app's MinerU relay; change only to point at another relay. */
	parserEndpoint: string;
	/** Optional MinerU key (e.g. for mineru.net), sent through the relay. */
	parserApiKey: string;
	/** 'auto' picks the best tier the server runs. */
	parserTier: 'auto' | 'flash' | 'basic' | 'standard' | 'advanced';
	/** Start parsing as soon as a document is opened. */
	autoParse: boolean;
}

const PARSER_TIERS = ['auto', 'flash', 'basic', 'standard', 'advanced'];

export const CHAT_SETTINGS_KEY = 'leedpdf_chat_settings';

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
	summaryIdleMs: 60_000,
	autoSummarize: true,
	parserEndpoint: '/api/mineru',
	parserApiKey: '',
	parserTier: 'auto',
	autoParse: true
};

/**
 * Merge stored values over the defaults, ignoring anything malformed. Keys
 * this version no longer has (an old browser-side apiKey or summaryModel) are dropped, and
 * disappear from storage on the next save.
 */
export function parseChatSettings(raw: string | null): ChatSettings {
	if (!raw) return { ...DEFAULT_CHAT_SETTINGS };
	try {
		const stored = JSON.parse(raw) as Partial<Record<keyof ChatSettings, unknown>>;
		const pick = <K extends keyof ChatSettings>(key: K, valid: (v: unknown) => boolean) =>
			(valid(stored[key]) ? stored[key] : DEFAULT_CHAT_SETTINGS[key]) as ChatSettings[K];
		const isString = (v: unknown) => typeof v === 'string';
		return {
			summaryIdleMs: pick('summaryIdleMs', (v) => typeof v === 'number' && v >= 5_000),
			autoSummarize: pick('autoSummarize', (v) => typeof v === 'boolean'),
			parserEndpoint: pick('parserEndpoint', (v) => isString(v) && (v as string).trim() !== ''),
			parserApiKey: pick('parserApiKey', isString),
			parserTier: pick('parserTier', (v) => PARSER_TIERS.includes(v as string)),
			autoParse: pick('autoParse', (v) => typeof v === 'boolean')
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