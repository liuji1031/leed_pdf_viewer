import { derived, get } from 'svelte/store';
import { activePDFKey, pdfState } from '$lib/stores/drawingStore';
import { chatSettings } from '$lib/stores/chatSettingsStore';
import { chatStorage } from '$lib/utils/chatStorage';
import { MinerUClient, ParseError, pickTier } from './docParser/mineruClient';
import { structuredContentToDocument } from './docParser/mineruContent';
import { createParseQueue, type ParseRequest } from './parseQueue';

/**
 * The app's parse queue, backed by MinerU through the /api/mineru relay and
 * cached in IndexedDB. Documents are parsed in the background as soon as they
 * are opened (unless auto-parse is off), so the paper is usually ready by the
 * time the user asks a question.
 */
export const parseQueue = createParseQueue({
	cache: {
		get: (pdfKey) => chatStorage.getDocument(pdfKey),
		put: (doc) => chatStorage.putDocument(doc)
	},
	async parse(req, { signal, onStage }) {
		const settings = get(chatSettings);
		const client = new MinerUClient({ endpoint: settings.parserEndpoint, apiKey: settings.parserApiKey });
		// Always name the tier: a server without a model-based tier rejects
		// untiered jobs. Ask the server what it runs rather than guess.
		const tier = pickTier(await client.tiers(signal), settings.parserTier);
		if (!tier) throw new ParseError('tier_unavailable', 'The document parser offers no parsing tiers');
		const raw = await client.parse(await req.getBytes(), req.filename, { tier, signal, onStage });
		return { ...structuredContentToDocument(raw, req.pdfKey), sourceFingerprint: req.fingerprint };
	}
});

/** The open document as a parse request, or null. */
export const openDocument = derived([activePDFKey, pdfState], ([$key, $state]): ParseRequest | null => {
	const doc = $state.document;
	if (!$key || !doc) return null;
	return {
		pdfKey: $key,
		fingerprint: doc.fingerprints[0] ?? '',
		filename: `${$key}.pdf`,
		getBytes: () => doc.getData()
	};
});

/** Parse status of the open document. */
export const openDocumentParse = derived([parseQueue.jobs, openDocument], ([$jobs, $open]) =>
	$open ? ($jobs.get($open.pdfKey) ?? null) : null
);

/** The open document's parsed content, only if it was parsed from this very file. */
export const openParsedDocument = derived([parseQueue.documents, openDocument], ([$docs, $open]) => {
	const doc = $open ? $docs.get($open.pdfKey) : undefined;
	return doc && $open && doc.sourceFingerprint === $open.fingerprint ? doc : null;
});

// pdfState changes on every zoom and page turn; only a new document/file pair
// is a new request, or the debounce would keep restarting and never fire.
if (typeof window !== 'undefined') {
	let last = '';
	openDocument.subscribe((open) => {
		if (!open) return;
		const id = `${open.pdfKey}|${open.fingerprint}`;
		if (id === last) return;
		last = id;
		parseQueue.request(open, { cacheOnly: !get(chatSettings).autoParse });
	});
}
