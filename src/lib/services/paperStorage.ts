import { chatStorage as localChatStorage, type ChatStorage, type ChatStorageManager } from '$lib/utils/chatStorage';
import { collectStoredAnnotations } from '$lib/stores/drawingStore';
import { paperApi, ServerChatStorage, type PaperApi, type PaperImport } from './paperApi';

/**
 * Chat and parse storage for the app: the server's paper database when it has
 * one, so a paper's chats and parse follow it into any browser; otherwise this
 * browser's IndexedDB, as before.
 *
 * The first time a browser meets a server with storage, it copies what it had
 * kept locally into it. The copy only adds: anything already on the server
 * (say, from another browser) wins.
 */

export const IMPORTED_FLAG = 'leedpdf_paper_db_imported';

export interface PaperStorageDeps {
	api: PaperApi;
	local: Pick<ChatStorageManager, keyof ChatStorage | 'exportAll'>;
	/** Annotations kept in this browser's localStorage, for the one-time copy. */
	localAnnotations: () => NonNullable<PaperImport['annotations']>;
	/** Where the one-time copy is recorded; null skips recording. */
	flags: Pick<Storage, 'getItem' | 'setItem'> | null;
}

export function createPaperStorage(deps: PaperStorageDeps): ChatStorage {
	const server = new ServerChatStorage(deps.api);
	let chosen: Promise<ChatStorage> | null = null;

	async function importLocal() {
		if (deps.flags?.getItem(IMPORTED_FLAG)) return;
		try {
			const local = await deps.local.exportAll().catch(() => ({ sessions: [], messages: [], documents: [] }));
			const { added } = await deps.api.importMissing({ ...local, annotations: deps.localAnnotations() });
			deps.flags?.setItem(IMPORTED_FLAG, String(Date.now()));
			if (added) console.log(`Copied ${added} locally stored records to the paper database`);
		} catch (error) {
			// try again on the next page load; the server is still used meanwhile.
			console.warn('Could not copy local chats and annotations to the paper database:', error);
		}
	}

	const backend = (): Promise<ChatStorage> =>
		(chosen ??= deps.api.enabled().then(async (enabled) => {
			if (!enabled) return deps.local;
			await importLocal();
			return server;
		}));

	return {
		isAvailable: async () => (await backend()).isAvailable(),
		listSessions: async (pdfKey) => (await backend()).listSessions(pdfKey),
		getSession: async (id) => (await backend()).getSession(id),
		putSession: async (session) => (await backend()).putSession(session),
		deleteSession: async (id) => (await backend()).deleteSession(id),
		listMessages: async (sessionId) => (await backend()).listMessages(sessionId),
		putMessage: async (message) => (await backend()).putMessage(message),
		deleteByPdfKey: async (pdfKey) => (await backend()).deleteByPdfKey(pdfKey),
		getDocument: async (pdfKey) => (await backend()).getDocument(pdfKey),
		putDocument: async (doc) => (await backend()).putDocument(doc),
		deleteDocument: async (pdfKey) => (await backend()).deleteDocument(pdfKey)
	};
}

function browserFlags(): Pick<Storage, 'getItem' | 'setItem'> | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

export const paperStorage = createPaperStorage({
	api: paperApi,
	local: localChatStorage,
	localAnnotations: collectStoredAnnotations,
	flags: browserFlags()
});
