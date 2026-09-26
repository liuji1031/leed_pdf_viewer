<!--
	Docked to the right of the viewer. z-30 lifts it over the page's ambient
	bottom-right items (promo card, footer credit), which are positioned without
	a z-index and would otherwise sit on top of the composer; it stays below the
	toolbar (z-50), the drag-and-drop overlay (z-40) and toasts.
-->
<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import {
		AlertTriangle,
		ArrowLeft,
		CheckCircle2,
		Loader2,
		MessagesSquare,
		RefreshCw,
		Settings,
		Trash2,
		X
	} from 'lucide-svelte';
	import {
		chatPanelOpen,
		chatPanelWidth,
		chatSettingsOpen,
		clampPanelWidth
	} from '$lib/stores/chatPanelStore';
	import { openRouterStatus, refreshOpenRouterStatus } from '$lib/stores/openRouterStatusStore';
	import {
		activeSessionId,
		askRequest,
		chatLoadState,
		chatMessages,
		chatSessions,
		ensureMessagesLoaded
	} from '$lib/stores/chatStore';
	import { chatHighlights, pdfState } from '$lib/stores/drawingStore';
	import { renderPageImage } from '$lib/utils/pageImage';
	import {
		openDocument,
		openDocumentParse,
		openParsedDocument,
		parseQueue
	} from '$lib/services/documentParsing';
	import { chat } from '$lib/services/chatService';
	import { ChatError } from '$lib/services/chatController';
	import { buildMessages, buildSessionContext } from '$lib/services/chatContext';
	import type { ParseErrorKind } from '$lib/services/docParser/mineruClient';
	import ChatComposer from './ChatComposer.svelte';
	import ChatMessageView from './ChatMessageView.svelte';
	import ChatSettingsModal from './ChatSettingsModal.svelte';

	/** Navigate the viewer; routes pass their PDFViewer's goToPage. */
	export let onGoToPage: (page: number) => void = () => {};

	const generating = chat.generating;

	let composer: ChatComposer;
	let transcript: HTMLDivElement;
	let sendError: string | null = null;
	let wholePaper = false;
	let attachPage = false;

	$: activeSession = $chatSessions.find((s) => s.id === $activeSessionId) ?? null;
	$: messages = activeSession ? ($chatMessages.get(activeSession.id) ?? []) : [];
	$: busy = activeSession ? $generating.has(activeSession.id) : false;
	$: pendingAsk = !activeSession ? $askRequest : null;
	// Re-checked whenever the panel opens, so an edited .env shows up after a restart.
	$: if ($chatPanelOpen) void refreshOpenRouterStatus();
	$: modelReady = $openRouterStatus.state === 'ready';
	$: parse = $openDocumentParse;
	$: parsed = $openParsedDocument;
	$: highlightById = new Map([...$chatHighlights.values()].flat().map((h) => [h.id, h]));

	$: blockedReason = !$openDocument
		? 'Open a PDF first'
		: !modelReady
			? $openRouterStatus.state === 'checking'
				? 'Connecting to the chat service'
				: 'Chat isn’t set up on the server'
			: !parsed
				? parse?.status === 'failed'
					? 'The paper could not be parsed'
					: 'Waiting for the paper to be parsed'
				: null;

	// Opening a conversation loads its messages; new messages scroll into view.
	$: if ($activeSessionId) ensureMessagesLoaded($activeSessionId).catch(() => {});
	$: if (messages) scrollToEnd();
	$: if (pendingAsk) composer?.focus();

	// Suggest the page image when the passage involves something text can't
	// carry: an equation the parser couldn't transcribe, or a figure.
	$: if (pendingAsk && parsed) attachPage = needsPageImage(parsed, pendingAsk);
	function needsPageImage(doc: NonNullable<typeof parsed>, ask: NonNullable<typeof pendingAsk>): boolean {
		try {
			const snapshot = buildSessionContext(doc, ask).snapshot;
			return snapshot.includes('[equation — not transcribed') || /\[passage block\]\n\[figure/.test(snapshot);
		} catch {
			return false;
		}
	}

	async function pageImageFor(pageNumber: number): Promise<string | undefined> {
		if (!attachPage || !$pdfState.document) return undefined;
		try {
			return await renderPageImage($pdfState.document, pageNumber);
		} catch (error) {
			console.warn('Could not render the page image:', error);
			return undefined;
		}
	}

	async function scrollToEnd() {
		await tick();
		transcript?.scrollTo({ top: transcript.scrollHeight });
	}

	// ---- Size of what will be sent -------------------------------------------
	$: contextNote = estimate(parsed, pendingAsk, activeSession, messages, wholePaper);

	function estimate(
		doc: typeof parsed,
		ask: typeof pendingAsk,
		session: typeof activeSession,
		msgs: typeof messages,
		whole: boolean
	): string {
		if (!doc || (!ask && !session)) return '';
		try {
			const snapshot = ask ? buildSessionContext(doc, ask) : null;
			const built = buildMessages({
				doc,
				session: snapshot
					? { snapshot: snapshot.snapshot, quotedText: ask!.anchor.text, focusBlockIdx: snapshot.blockIdx }
					: {
							snapshot: session!.contextSnapshot ?? '',
							quotedText: session!.quotedText,
							focusBlockIdx: session!.focusBlockIdx ?? null
						},
				history: msgs
					.filter((m) => m.status === 'complete' && m.role !== 'system')
					.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
				question: '',
				wholePaper: whole
			});
			const chars = built.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
			const tokens = Math.ceil(chars / 4);
			return `≈${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens sent`;
		} catch {
			return '';
		}
	}

	// ---- Actions -----------------------------------------------------------
	async function send(text: string) {
		sendError = null;
		if (pendingAsk) {
			const request = pendingAsk;
			askRequest.set(null);
			try {
				const pageImage = await pageImageFor(request.pageNumber);
				await chat.startConversation(request, text, { wholePaper, pageImage });
			} catch (error) {
				askRequest.set(request); // keep the quote so nothing is lost
				sendError = error instanceof ChatError ? error.message : String(error);
			}
		} else if (activeSession) {
			try {
				const pageImage = await pageImageFor(activeSession.pageNumber);
				await chat.sendMessage(activeSession.id, text, { wholePaper, pageImage });
			} catch (error) {
				sendError = error instanceof ChatError ? error.message : String(error);
			}
		}
	}

	function openSession(id: string, page: number) {
		askRequest.set(null);
		activeSessionId.set(id);
		onGoToPage(page);
	}

	function backToList() {
		activeSessionId.set(null);
		askRequest.set(null);
	}

	// Deleting takes two clicks: the first arms it for a few seconds.
	let confirming: 'session' | 'all' | null = null;
	let confirmTimer: ReturnType<typeof setTimeout> | undefined;
	function confirmThen(kind: 'session' | 'all', action: () => Promise<void>) {
		clearTimeout(confirmTimer);
		if (confirming === kind) {
			confirming = null;
			void action();
			return;
		}
		confirming = kind;
		confirmTimer = setTimeout(() => (confirming = null), 3000);
	}
	onDestroy(() => clearTimeout(confirmTimer));

	function parseNow() {
		if ($openDocument) parseQueue.request($openDocument, { manual: true });
	}

	// ---- Parse progress ------------------------------------------------------
	let now = Date.now();
	const clock = setInterval(() => (now = Date.now()), 1000);
	onDestroy(() => clearInterval(clock));
	$: elapsed = parse?.status === 'running' && parse.startedAt ? Math.max(0, Math.round((now - parse.startedAt) / 1000)) : 0;

	const STAGE_LABEL: Record<string, string> = {
		uploading: 'Sending the paper to the parser',
		queued: 'Waiting for the parser',
		parsing: 'Reading the paper',
		downloading: 'Almost done'
	};

	function failureText(kind: ParseErrorKind | 'unknown', message: string): string {
		switch (kind) {
			case 'not_configured':
				return 'Document parsing isn’t set up on this server (MINERU_URL).';
			case 'unreachable':
			case 'timeout':
				return 'Couldn’t reach the document parser.';
			case 'auth':
				return 'The parser rejected its API key.';
			case 'tier_unavailable':
				return 'The parser has no parsing tier available.';
			case 'too_large':
				return 'This PDF is too large to parse.';
			default:
				return message;
		}
	}

	// ---- Resizing ----------------------------------------------------------
	function startResize(event: PointerEvent) {
		const handle = event.currentTarget as HTMLElement;
		const startX = event.clientX;
		const startWidth = $chatPanelWidth;
		handle.setPointerCapture(event.pointerId);
		const move = (e: PointerEvent) =>
			chatPanelWidth.set(clampPanelWidth(startWidth + (startX - e.clientX), window.innerWidth));
		const end = () => {
			handle.removeEventListener('pointermove', move);
			handle.removeEventListener('pointerup', end);
			handle.removeEventListener('pointercancel', end);
		};
		handle.addEventListener('pointermove', move);
		handle.addEventListener('pointerup', end);
		handle.addEventListener('pointercancel', end);
	}

	function resizeByKey(event: KeyboardEvent) {
		const step = event.shiftKey ? 80 : 20;
		if (event.key === 'ArrowLeft') chatPanelWidth.update((w) => clampPanelWidth(w + step, window.innerWidth));
		else if (event.key === 'ArrowRight') chatPanelWidth.update((w) => clampPanelWidth(w - step, window.innerWidth));
		else return;
		event.preventDefault();
	}

	$: width = typeof window === 'undefined' ? $chatPanelWidth : clampPanelWidth($chatPanelWidth, window.innerWidth);
</script>

{#if $chatPanelOpen}
	<aside
		class="chat-panel relative z-30 flex h-full shrink-0 flex-col border-l border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 max-md:fixed max-md:inset-0 max-md:z-50 max-md:!w-full"
		style="width: {width}px"
		aria-label="Paper chat"
		data-testid="chat-panel"
	>
		<!-- svelte-ignore a11y-no-noninteractive-tabindex a11y-no-noninteractive-element-interactions -->
		<div
			class="resize-handle absolute left-0 top-0 z-10 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-sage/40 focus:bg-sage/40 focus:outline-none max-md:hidden"
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize chat panel"
			aria-valuenow={width}
			tabindex="0"
			on:pointerdown={startResize}
			on:keydown={resizeByKey}
		></div>

		<!-- Header -->
		<header class="flex items-center gap-2 border-b border-gray-200 px-3 py-2.5 dark:border-gray-700">
			{#if activeSession || pendingAsk}
				<button class="rounded-lg p-1 text-slate hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700" on:click={backToList} aria-label="All conversations">
					<ArrowLeft size={16} />
				</button>
			{:else}
				<MessagesSquare size={16} class="text-sage" />
			{/if}
			<h2 class="flex-1 truncate text-sm font-semibold text-charcoal dark:text-gray-100">
				{activeSession ? activeSession.title : pendingAsk ? 'New question' : 'Paper chat'}
			</h2>
			{#if activeSession}
				<button
					class="flex items-center gap-1 rounded-lg p-1 text-xs hover:bg-gray-100 dark:hover:bg-gray-700 {confirming === 'session' ? 'text-red-600 dark:text-red-400' : 'text-slate dark:text-gray-300'}"
					on:click={() => activeSession && confirmThen('session', () => chat.deleteConversation(activeSession.id))}
					aria-label={confirming === 'session' ? 'Confirm: delete this conversation and its highlight' : 'Delete conversation'}
					data-testid="chat-delete-session"
				>
					<Trash2 size={16} />
					{#if confirming === 'session'}<span>Delete?</span>{/if}
				</button>
			{/if}
			<button class="rounded-lg p-1 text-slate hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700" on:click={() => chatSettingsOpen.set(true)} aria-label="Chat settings" data-testid="chat-settings-button">
				<Settings size={16} />
			</button>
			<button class="rounded-lg p-1 text-slate hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700" on:click={() => chatPanelOpen.set(false)} aria-label="Close chat">
				<X size={16} />
			</button>
		</header>

		<!-- Parse status -->
		{#if $openDocument}
			<div class="border-b border-gray-100 px-3 py-2 text-xs dark:border-gray-700" data-testid="parse-status" data-status={parse?.status ?? (parsed ? 'done' : 'none')}>
				{#if parsed}
					<span class="flex items-center gap-1.5 text-sage">
						<CheckCircle2 size={13} />
						Paper ready · {parsed.pageCount} page{parsed.pageCount === 1 ? '' : 's'}{parsed.parser.tier ? ` · ${parsed.parser.tier} tier` : ''}
					</span>
				{:else if parse?.status === 'running' || parse?.status === 'queued'}
					<span class="flex items-center gap-1.5 text-slate dark:text-gray-300">
						<Loader2 size={13} class="animate-spin" />
						{parse.status === 'queued' && parse.error ? 'Retrying shortly' : STAGE_LABEL[parse.stage ?? 'queued']}…
						{#if elapsed}<span class="text-gray-400">{elapsed}s</span>{/if}
						<button class="ml-auto text-gray-400 hover:text-gray-600" on:click={() => $openDocument && parseQueue.cancel($openDocument.pdfKey)}>Cancel</button>
					</span>
				{:else if parse?.status === 'failed' && parse.error}
					<span class="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
						<AlertTriangle size={13} class="mt-px shrink-0" />
						<span class="flex-1">{failureText(parse.error.kind, parse.error.message)}</span>
						<button class="flex items-center gap-1 font-medium hover:underline" on:click={() => $openDocument && parseQueue.retry($openDocument.pdfKey)}>
							<RefreshCw size={12} /> Retry
						</button>
					</span>
				{:else}
					<span class="flex items-center gap-2 text-slate dark:text-gray-300">
						Answers use the parsed paper.
						<button class="font-medium text-sage hover:underline" on:click={parseNow}>Parse this paper</button>
					</span>
				{/if}
			</div>
		{/if}

		<!-- Body -->
		<div class="flex min-h-0 flex-1 flex-col">
			{#if $openRouterStatus.state === 'missing' || $openRouterStatus.state === 'unavailable'}
				<div class="m-3 rounded-xl border border-dashed border-gray-300 p-4 text-sm text-slate dark:border-gray-600 dark:text-gray-300" data-testid="chat-needs-key">
					<p class="mb-2 font-medium text-charcoal dark:text-gray-100">Connect a model</p>
					{#if $openRouterStatus.state === 'missing'}
						<p class="mb-3">
							Set <code class="rounded bg-gray-100 px-1 text-xs dark:bg-gray-700">{$openRouterStatus.missing.join(' and ')}</code>
							in <code class="rounded bg-gray-100 px-1 text-xs dark:bg-gray-700">.env</code>, then restart the app.
						</p>
					{:else}
						<p class="mb-3">The chat service on this server can’t be reached.</p>
					{/if}
					<button class="rounded-lg border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700" on:click={() => refreshOpenRouterStatus()}>
						Check again
					</button>
				</div>
			{/if}

			{#if pendingAsk || activeSession}
				<!-- Conversation (new or existing) -->
				<div bind:this={transcript} class="flex-1 space-y-4 overflow-y-auto p-3" data-testid="chat-transcript">
					<button
						class="block w-full rounded-lg border-l-4 border-indigo-400 bg-indigo-50/60 px-3 py-2 text-left text-xs italic text-charcoal hover:bg-indigo-50 dark:bg-indigo-500/10 dark:text-gray-200"
						on:click={() => onGoToPage((pendingAsk ?? activeSession)?.pageNumber ?? 1)}
						title="Go to this passage"
						data-testid="chat-quote"
					>
						“{pendingAsk ? pendingAsk.anchor.text : activeSession?.quotedText}”
						<span class="not-italic text-gray-400"> · p{(pendingAsk ?? activeSession)?.pageNumber}</span>
					</button>
					{#each messages as message (message.id)}
						<ChatMessageView {message} />
					{/each}
					{#if sendError}
						<p class="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{sendError}</p>
					{/if}
				</div>
				<ChatComposer
					bind:this={composer}
					bind:wholePaper
					bind:attachPage
					placeholder={pendingAsk ? 'Ask about this passage…' : 'Ask a follow-up…'}
					{blockedReason}
					{busy}
					{contextNote}
					onSend={send}
					onStop={() => activeSession && chat.stop(activeSession.id)}
				/>
			{:else}
				<!-- Conversation list -->
				<div class="flex-1 overflow-y-auto p-2" data-testid="chat-session-list">
					{#if $chatLoadState === 'unavailable'}
						<p class="p-3 text-xs text-amber-700 dark:text-amber-400">Chat history can’t be saved in this browser.</p>
					{/if}
					{#each $chatSessions as session (session.id)}
						{@const highlight = highlightById.get(session.highlightId)}
						<button
							class="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50"
							on:click={() => openSession(session.id, session.pageNumber)}
							data-testid="chat-session-item"
						>
							<span class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-[9px] font-bold text-white">
								{highlight?.ordinal ?? '•'}
							</span>
							<span class="min-w-0 flex-1">
								<span class="block truncate text-sm text-charcoal dark:text-gray-100">{session.title}</span>
								<span class="block text-[11px] text-slate dark:text-gray-400">
									p{session.pageNumber} · {session.messageCount} message{session.messageCount === 1 ? '' : 's'}
								</span>
								{#if session.summary}
									<span class="mt-0.5 block text-xs text-slate line-clamp-2 dark:text-gray-400">{session.summary}</span>
								{/if}
							</span>
						</button>
					{:else}
						<div class="p-4 text-sm text-slate dark:text-gray-400" data-testid="chat-empty">
							<p class="mb-1 font-medium text-charcoal dark:text-gray-200">No conversations yet</p>
							<p>Choose the ask tool (<kbd class="rounded bg-gray-100 px-1 dark:bg-gray-700">8</kbd>), select a passage, and click <em>Ask about…</em>.</p>
						</div>
					{/each}
				</div>
				{#if $chatSessions.length}
					<div class="border-t border-gray-100 px-3 py-2 text-right dark:border-gray-700">
						<button
							class="text-xs hover:underline {confirming === 'all' ? 'font-medium text-red-600 dark:text-red-400' : 'text-slate dark:text-gray-400'}"
							on:click={() => confirmThen('all', () => chat.clearDocument())}
							data-testid="chat-clear-all"
						>
							{confirming === 'all'
								? `Click again to delete ${$chatSessions.length} conversation${$chatSessions.length === 1 ? '' : 's'} and their highlights`
								: 'Clear all chats for this paper'}
						</button>
					</div>
				{/if}
			{/if}
		</div>
	</aside>

	<ChatSettingsModal bind:isOpen={$chatSettingsOpen} />
{/if}
