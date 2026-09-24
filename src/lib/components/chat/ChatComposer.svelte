<script lang="ts">
	import { tick } from 'svelte';
	import { SendHorizontal, Square } from 'lucide-svelte';

	export let placeholder = 'Ask a question…';
	/** Why sending is unavailable, if it is; shown in place of the hint. */
	export let blockedReason: string | null = null;
	export let busy = false;
	export let wholePaper = false;
	/** Rough size of what will be sent, e.g. "≈4.8k tokens". */
	export let contextNote = '';
	export let onSend: (text: string) => void;
	export let onStop: () => void = () => {};

	let text = '';
	let textarea: HTMLTextAreaElement;

	export async function focus() {
		await tick();
		textarea?.focus();
	}

	$: canSend = !busy && !blockedReason && text.trim().length > 0;

	function send() {
		if (!canSend) return;
		const question = text.trim();
		text = '';
		autosize();
		onSend(question);
	}

	function onKeydown(event: KeyboardEvent) {
		// Enter sends; Shift+Enter adds a line. Never send mid-IME-composition.
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			send();
		}
	}

	function autosize() {
		if (!textarea) return;
		textarea.style.height = 'auto';
		textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
	}
</script>

<div class="border-t border-gray-200 dark:border-gray-700 p-3 space-y-2">
	<div class="flex items-end gap-2">
		<textarea
			bind:this={textarea}
			bind:value={text}
			on:input={autosize}
			on:keydown={onKeydown}
			rows="1"
			{placeholder}
			aria-label="Your question"
			class="flex-1 resize-none rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-charcoal dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-sage/50"
			data-testid="chat-input"
		></textarea>
		{#if busy}
			<button
				type="button"
				class="shrink-0 rounded-xl bg-gray-200 p-2.5 text-charcoal hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-100"
				on:click={onStop}
				aria-label="Stop answering"
				data-testid="chat-stop"
			>
				<Square size={16} />
			</button>
		{:else}
			<button
				type="button"
				class="shrink-0 rounded-xl bg-sage p-2.5 text-white hover:brightness-110 disabled:opacity-40"
				disabled={!canSend}
				on:click={send}
				aria-label="Send"
				data-testid="chat-send"
			>
				<SendHorizontal size={16} />
			</button>
		{/if}
	</div>
	<div class="flex items-center justify-between gap-2 text-[11px] text-slate dark:text-gray-400">
		<label class="flex items-center gap-1.5">
			<input type="checkbox" bind:checked={wholePaper} class="rounded text-sage focus:ring-sage" />
			Include the whole paper
		</label>
		{#if blockedReason}
			<span class="text-amber-700 dark:text-amber-400">{blockedReason}</span>
		{:else if contextNote}
			<span title="Estimated size of what is sent with this question">{contextNote}</span>
		{/if}
	</div>
</div>
