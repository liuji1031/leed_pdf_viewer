<script lang="ts">
	import type { QuickPrompt } from '$lib/services/quickPrompts';

	export let prompts: QuickPrompt[];
	export let disabled = false;
	export let onPick: (prompt: string) => void;
</script>

<div class="flex flex-wrap gap-1.5 px-3 pt-2" role="group" aria-label="Quick questions" data-testid="chat-quick-prompts">
	{#each prompts as p (p.label)}
		<button
			type="button"
			class="rounded-full border border-sage/40 px-2.5 py-1 text-xs text-charcoal hover:bg-sage/10 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-200"
			{disabled}
			title={p.prompt}
			on:click={() => onPick(p.prompt)}
			data-testid="chat-quick-prompt"
		>
			{p.label}
		</button>
	{/each}
</div>
