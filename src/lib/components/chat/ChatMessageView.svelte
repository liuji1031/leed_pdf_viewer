<script lang="ts">
	import type { ChatMessage } from '$lib/utils/chatStorage';
	import ChatMarkdown from './ChatMarkdown.svelte';

	export let message: ChatMessage;
</script>

{#if message.role === 'user'}
	<div class="flex justify-end" data-testid="chat-message-user">
		<div class="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-sage/15 px-3 py-2 text-sm text-charcoal dark:bg-sage/25 dark:text-gray-100">
			{message.content}
		</div>
	</div>
{:else}
	<div
		class="text-sm text-charcoal dark:text-gray-100"
		class:is-error={message.status === 'error'}
		data-testid="chat-message-assistant"
		data-status={message.status}
	>
		{#if message.status === 'streaming' && !message.content}
			<span class="inline-flex items-center gap-1 text-slate dark:text-gray-400" aria-live="polite">
				<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>
				<span class="sr-only">Thinking…</span>
			</span>
		{:else}
			<ChatMarkdown source={message.content} />
			{#if message.status === 'streaming'}<span class="stream-caret" aria-hidden="true"></span>{/if}
		{/if}
	</div>
{/if}

<style>
	.is-error {
		border-left: 3px solid rgb(220 38 38 / 0.6);
		padding-left: 0.6rem;
	}
	.typing-dot {
		width: 6px;
		height: 6px;
		border-radius: 9999px;
		background: currentColor;
		animation: blink 1.2s infinite ease-in-out;
	}
	.typing-dot:nth-child(2) {
		animation-delay: 0.2s;
	}
	.typing-dot:nth-child(3) {
		animation-delay: 0.4s;
	}
	.stream-caret {
		display: inline-block;
		width: 0.5em;
		height: 1em;
		margin-left: 1px;
		vertical-align: text-bottom;
		background: currentColor;
		opacity: 0.5;
		animation: blink 1s steps(2) infinite;
	}
	@keyframes blink {
		0%, 100% { opacity: 0.2; }
		50% { opacity: 0.9; }
	}
</style>
