<script lang="ts">
	import type { ChatMessage } from '$lib/utils/chatStorage';
	import ChatMarkdown from './ChatMarkdown.svelte';

	export let message: ChatMessage;
	export let onGoToPage: (page: number) => void = () => {};
</script>

{#if message.role === 'user'}
	<div class="flex flex-col items-end gap-1" data-testid="chat-message-user">
		{#if message.passage}
			{@const passage = message.passage}
			<button
				class="max-w-[85%] rounded-lg border-l-4 border-indigo-400 bg-indigo-50/60 px-3 py-1.5 text-left text-xs italic text-charcoal hover:bg-indigo-50 dark:bg-indigo-500/10 dark:text-gray-200"
				on:click={() => onGoToPage(passage.pageNumber)}
				title="Go to this passage"
				data-testid="chat-message-passage"
			>
				“{passage.quotedText}”
				<span class="not-italic text-gray-400"> · p{passage.pageNumber}</span>
			</button>
		{/if}
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
		{#if message.sources?.length}
			<details class="mt-2 text-xs text-slate dark:text-gray-400" data-testid="chat-message-sources">
				<summary class="cursor-pointer select-none">
					Searched the web · {message.sources.length} source{message.sources.length === 1 ? '' : 's'}
				</summary>
				<ul class="mt-1 space-y-0.5 pl-3">
					{#each message.sources as source (source.url)}
						<li class="truncate">
							<a href={source.url} target="_blank" rel="noopener noreferrer" class="text-sage hover:underline" title={source.url}>
								{source.title}
							</a>
						</li>
					{/each}
				</ul>
			</details>
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
