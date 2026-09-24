<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import { Check, Eye, EyeOff, Loader2, X } from 'lucide-svelte';
	import { chatSettings, DEFAULT_CHAT_SETTINGS, type ChatSettings } from '$lib/stores/chatSettingsStore';
	import { checkApiKey, listModels, type ModelInfo } from '$lib/services/openRouter';
	import { MinerUClient } from '$lib/services/docParser/mineruClient';
	import { trapFocus } from '$lib/utils/trapFocus';

	export let isOpen = false;

	const SUGGESTED_SUMMARY_MODEL = 'anthropic/claude-haiku-4.5';

	let draft: ChatSettings = { ...$chatSettings };
	let showKey = false;
	let models: ModelInfo[] = [];
	let keyCheck: { state: 'idle' | 'checking' | 'ok' | 'error'; message?: string } = { state: 'idle' };
	let parserCheck: { state: 'idle' | 'checking' | 'ok' | 'error'; message?: string } = { state: 'idle' };

	// Fresh draft each time the dialog opens; the model list is loaded once.
	// (A function, not two reactive statements: Svelte would run the one that
	// records the previous state first, and the reset would never fire.)
	let lastOpen = false;
	$: onOpenChange(isOpen);
	function onOpenChange(open: boolean) {
		if (open && !lastOpen) {
			draft = { ...$chatSettings };
			keyCheck = { state: 'idle' };
			parserCheck = { state: 'idle' };
			if (!models.length) {
				listModels(draft.endpoint)
					.then((list) => (models = list.sort((a, b) => a.id.localeCompare(b.id))))
					.catch(() => (models = []));
			}
		}
		lastOpen = open;
	}

	$: chosenModel = models.find((m) => m.id === draft.chatModel);
	$: idleMinutes = Math.round(draft.summaryIdleMs / 60_000);

	function close() {
		isOpen = false;
	}

	function save() {
		chatSettings.set({ ...draft, apiKey: draft.apiKey.trim(), parserApiKey: draft.parserApiKey.trim() });
		close();
	}

	async function testKey() {
		keyCheck = { state: 'checking' };
		try {
			const { label } = await checkApiKey(draft.endpoint, draft.apiKey.trim());
			keyCheck = { state: 'ok', message: `Key works (${label})` };
		} catch (error) {
			keyCheck = { state: 'error', message: error instanceof Error ? error.message : String(error) };
		}
	}

	async function testParser() {
		parserCheck = { state: 'checking' };
		try {
			const client = new MinerUClient({ endpoint: draft.parserEndpoint, apiKey: draft.parserApiKey });
			const tiers = await client.tiers();
			parserCheck = { state: 'ok', message: `Connected — tiers available: ${tiers.join(', ') || 'none'}` };
		} catch (error) {
			parserCheck = { state: 'error', message: error instanceof Error ? error.message : String(error) };
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (isOpen && e.key === 'Escape') close();
	}

	const field =
		'w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-charcoal dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-sage/50';
	const label = 'block text-xs font-medium text-slate dark:text-gray-400 mb-1';
</script>

<svelte:window on:keydown={handleKeydown} />

{#if isOpen}
	<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
	<div
		class="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
		on:click={(e) => {
			if (e.target === e.currentTarget) close();
		}}
		transition:fade={{ duration: 150 }}
	>
		<div
			class="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden"
			role="dialog"
			aria-modal="true"
			aria-labelledby="chat-settings-title"
			use:trapFocus
			transition:fly={{ y: 20, duration: 250 }}
		>
			<div class="flex items-center justify-between px-6 pt-5 pb-3">
				<div>
					<h2 id="chat-settings-title" class="text-lg font-semibold text-charcoal dark:text-white">
						Chat settings
					</h2>
					<p class="text-xs text-slate dark:text-gray-400 mt-0.5">Model, API key and document parsing</p>
				</div>
				<button
					on:click={close}
					class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
					aria-label="Close"
				>
					<X size={18} />
				</button>
			</div>

			<div class="px-6 pb-4 space-y-6 overflow-y-auto">
				<!-- OpenRouter -->
				<section class="space-y-3">
					<h3 class="text-sm font-semibold text-charcoal dark:text-gray-100">OpenRouter</h3>
					<div>
						<label class={label} for="chat-api-key">API key</label>
						<div class="flex gap-2">
							<div class="relative flex-1">
								{#if showKey}
									<input id="chat-api-key" class={field} type="text" bind:value={draft.apiKey} placeholder="sk-or-v1-…" autocomplete="off" spellcheck="false" />
								{:else}
									<input id="chat-api-key" class={field} type="password" bind:value={draft.apiKey} placeholder="sk-or-v1-…" autocomplete="off" />
								{/if}
								<button
									type="button"
									class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
									on:click={() => (showKey = !showKey)}
									aria-label={showKey ? 'Hide key' : 'Show key'}
								>
									{#if showKey}<EyeOff size={16} />{:else}<Eye size={16} />{/if}
								</button>
							</div>
							<button
								type="button"
								class="shrink-0 rounded-lg border border-gray-200 dark:border-gray-600 px-3 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
								disabled={!draft.apiKey.trim() || keyCheck.state === 'checking'}
								on:click={testKey}
							>
								{#if keyCheck.state === 'checking'}<Loader2 size={14} class="animate-spin" />{:else}Test{/if}
							</button>
						</div>
						{#if keyCheck.state === 'ok'}
							<p class="mt-1 flex items-center gap-1 text-xs text-sage"><Check size={12} /> {keyCheck.message}</p>
						{:else if keyCheck.state === 'error'}
							<p class="mt-1 text-xs text-red-600 dark:text-red-400">{keyCheck.message}</p>
						{/if}
						<p class="mt-1 text-[11px] text-slate dark:text-gray-500">
							Stored in this browser only, and sent only to OpenRouter.
						</p>
					</div>

					<div>
						<label class={label} for="chat-model">Chat model</label>
						<input id="chat-model" class={field} list="chat-model-options" bind:value={draft.chatModel} spellcheck="false" />
						<datalist id="chat-model-options">
							{#each models as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
						</datalist>
						{#if chosenModel}
							<p class="mt-1 text-[11px] text-slate dark:text-gray-500">
								${chosenModel.promptPricePerM.toFixed(2)}/M input tokens ·
								{chosenModel.acceptsImages ? 'can read page images' : 'text only'}
							</p>
						{/if}
					</div>
				</section>

				<!-- Summaries -->
				<section class="space-y-3">
					<h3 class="text-sm font-semibold text-charcoal dark:text-gray-100">Hover summaries</h3>
					<label class="flex items-center gap-2 text-sm text-charcoal dark:text-gray-200">
						<input type="checkbox" bind:checked={draft.autoSummarize} class="rounded text-sage focus:ring-sage" />
						Summarise each conversation for its highlight
					</label>
					<div class="grid grid-cols-2 gap-3">
						<div>
							<label class={label} for="summary-model">Summary model</label>
							<input
								id="summary-model"
								class={field}
								list="chat-model-options"
								bind:value={draft.summaryModel}
								placeholder="Same as chat model"
								spellcheck="false"
								disabled={!draft.autoSummarize}
							/>
						</div>
						<div>
							<label class={label} for="summary-idle">After idle (minutes)</label>
							<input
								id="summary-idle"
								class={field}
								type="number"
								min="1"
								max="30"
								value={idleMinutes}
								disabled={!draft.autoSummarize}
								on:input={(e) => {
									const n = Math.min(30, Math.max(1, Number(e.currentTarget.value) || 1));
									draft.summaryIdleMs = n * 60_000;
								}}
							/>
						</div>
					</div>
					{#if draft.autoSummarize && !draft.summaryModel}
						<button
							type="button"
							class="text-[11px] text-sage hover:underline"
							on:click={() => (draft.summaryModel = SUGGESTED_SUMMARY_MODEL)}
						>
							Use a cheaper model for summaries ({SUGGESTED_SUMMARY_MODEL})
						</button>
					{/if}
				</section>

				<!-- Parser -->
				<section class="space-y-3">
					<h3 class="text-sm font-semibold text-charcoal dark:text-gray-100">Document parsing (MinerU)</h3>
					<label class="flex items-center gap-2 text-sm text-charcoal dark:text-gray-200">
						<input type="checkbox" bind:checked={draft.autoParse} class="rounded text-sage focus:ring-sage" />
						Parse papers in the background as soon as they're opened
					</label>
					<div>
						<label class={label} for="parser-tier">Quality tier</label>
						<select id="parser-tier" class={field} bind:value={draft.parserTier}>
							<option value="auto">Best available</option>
							<option value="flash">Flash — fast text extraction</option>
							<option value="basic">Basic — lightweight models</option>
							<option value="standard">Standard — most documents</option>
							<option value="advanced">Advanced — difficult documents</option>
						</select>
					</div>
					<details class="text-sm">
						<summary class="cursor-pointer text-xs text-slate dark:text-gray-400">Advanced</summary>
						<div class="mt-2 space-y-3">
							<div>
								<label class={label} for="parser-endpoint">Parser endpoint</label>
								<input id="parser-endpoint" class={field} bind:value={draft.parserEndpoint} placeholder={DEFAULT_CHAT_SETTINGS.parserEndpoint} spellcheck="false" />
							</div>
							<div>
								<label class={label} for="parser-key">Parser API key (e.g. for mineru.net)</label>
								<input id="parser-key" class={field} type="password" bind:value={draft.parserApiKey} autocomplete="off" />
								<p class="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
									A hosted parser receives a copy of each paper you open.
								</p>
							</div>
						</div>
					</details>
					<div>
						<button
							type="button"
							class="rounded-lg border border-gray-200 dark:border-gray-600 px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
							disabled={parserCheck.state === 'checking'}
							on:click={testParser}
						>
							{#if parserCheck.state === 'checking'}Checking…{:else}Test parser connection{/if}
						</button>
						{#if parserCheck.state === 'ok'}
							<p class="mt-1 flex items-center gap-1 text-xs text-sage"><Check size={12} /> {parserCheck.message}</p>
						{:else if parserCheck.state === 'error'}
							<p class="mt-1 text-xs text-red-600 dark:text-red-400">{parserCheck.message}</p>
						{/if}
					</div>
				</section>
			</div>

			<div class="flex justify-end gap-2 border-t border-gray-100 dark:border-gray-700 px-6 py-3">
				<button type="button" class="rounded-lg px-4 py-2 text-sm text-slate hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700" on:click={close}>
					Cancel
				</button>
				<button type="button" class="rounded-lg bg-sage px-4 py-2 text-sm font-medium text-white hover:brightness-110" on:click={save} data-testid="chat-settings-save">
					Save
				</button>
			</div>
		</div>
	</div>
{/if}
