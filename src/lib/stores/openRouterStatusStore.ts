import { writable } from 'svelte/store';
import { fetchRelayStatus } from '$lib/services/openRouter';

/** Whether the server's chat relay has an API key and model (OPENROUTER_* in .env). */
export type OpenRouterStatus =
	| { state: 'checking' }
	| { state: 'ready'; model: string; summaryModel: string }
	| { state: 'missing'; missing: string[] }
	| { state: 'unavailable' }; // no relay (e.g. the desktop build) or unreachable

export const openRouterStatus = writable<OpenRouterStatus>({ state: 'checking' });

let inFlight: Promise<void> | null = null;

export function refreshOpenRouterStatus(fetchImpl?: typeof fetch): Promise<void> {
	inFlight ??= fetchRelayStatus(undefined, fetchImpl)
		.then((s) =>
			openRouterStatus.set(
				s.configured && s.model
					? { state: 'ready', model: s.model, summaryModel: s.summaryModel ?? s.model }
					: { state: 'missing', missing: s.missing }
			)
		)
		.catch(() => openRouterStatus.set({ state: 'unavailable' }))
		.finally(() => (inFlight = null));
	return inFlight;
}
