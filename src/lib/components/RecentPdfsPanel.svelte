<script lang="ts">
	import { onMount } from 'svelte';
	import { FileText, History, Link2, Search, X } from 'lucide-svelte';
	import { activePDFKey, pdfState } from '$lib/stores/drawingStore';
	import { toastStore } from '$lib/stores/toastStore';
	import type { RecentPdf } from '$lib/services/paperApi';
	import {
		openPickedFile,
		recentPanelOpen,
		recentPdfHref,
		recentPdfs,
		recentPdfsAvailable,
		refreshRecentPdfs,
		removeRecentPdf
	} from '$lib/services/recentPdfs';

	let filter = '';
	let picker: HTMLInputElement;
	let picking: RecentPdf | null = null;

	onMount(() => {
		void refreshRecentPdfs();
	});

	$: needle = filter.trim().toLowerCase();
	$: shown = needle
		? $recentPdfs.filter((p) => `${p.title ?? ''} ${p.name}`.toLowerCase().includes(needle))
		: $recentPdfs;

	function open(pdf: RecentPdf) {
		const href = recentPdfHref(pdf);
		if (href) {
			// a full navigation: the viewer routes load their PDF once.
			window.location.assign(href);
			return;
		}
		// a local file can't be reopened without the user picking it again.
		picking = pdf;
		picker.value = '';
		picker.click();
	}

	async function picked() {
		const file = picker.files?.[0];
		const wanted = picking;
		picking = null;
		if (!file) return;
		if (wanted && (file.name !== wanted.name || file.size !== wanted.size)) {
			toastStore.info('A different file', `Opening ${file.name} instead of ${wanted.name}.`, { duration: 4000 });
		}
		try {
			await openPickedFile(file);
		} catch (error) {
			toastStore.error('Could not open the PDF', error instanceof Error ? error.message : String(error));
		}
	}

	const day = 24 * 60 * 60 * 1000;
	function when(ms: number): string {
		const age = Date.now() - ms;
		if (age < 60_000) return 'just now';
		if (age < 60 * 60_000) return `${Math.floor(age / 60_000)} min ago`;
		if (age < day) return `${Math.floor(age / (60 * 60_000))} h ago`;
		if (age < 7 * day) return `${Math.floor(age / day)} d ago`;
		return new Date(ms).toLocaleDateString();
	}

	function details(pdf: RecentPdf): string {
		return [pdf.title && pdf.name, pdf.pageCount && `${pdf.pageCount} pp`, when(pdf.openedAt)].filter(Boolean).join(' · ');
	}
</script>

<input
	bind:this={picker}
	type="file"
	accept="application/pdf,.pdf"
	class="hidden"
	on:change={picked}
	data-testid="recent-pdfs-picker"
/>

{#if $recentPdfsAvailable && $recentPanelOpen}
	<aside
		class="flex h-full w-64 shrink-0 flex-col border-r border-gray-200 bg-white/95 dark:border-gray-700 dark:bg-gray-800/95"
		aria-label="Recently opened PDFs"
		data-testid="recent-pdfs-panel"
	>
		<header class="flex items-center gap-2 border-b border-gray-200 px-3 py-2.5 dark:border-gray-700">
			<History size={16} class="text-sage" />
			<h2 class="flex-1 truncate text-sm font-semibold text-charcoal dark:text-gray-100">
				Recent PDFs
				{#if $recentPdfs.length}<span class="font-normal text-slate dark:text-gray-400">· {$recentPdfs.length}</span>{/if}
			</h2>
			<button
				class="rounded-lg p-1 text-slate hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
				on:click={() => recentPanelOpen.set(false)}
				aria-label="Close recent PDFs"
			>
				<X size={16} />
			</button>
		</header>

		{#if $recentPdfs.length > 8}
			<label class="mx-3 mt-2 flex items-center gap-1.5 rounded-lg border border-gray-200 px-2 py-1 dark:border-gray-600">
				<Search size={13} class="text-slate dark:text-gray-400" />
				<input
					bind:value={filter}
					placeholder="Filter"
					aria-label="Filter recent PDFs"
					class="w-full bg-transparent text-xs text-charcoal focus:outline-none dark:text-gray-100"
				/>
			</label>
		{/if}

		<ul class="flex-1 overflow-y-auto py-1" data-testid="recent-pdfs-list">
			{#each shown as pdf (pdf.pdfKey)}
				{@const current = !!$pdfState.document && pdf.pdfKey === $activePDFKey}
				<li class="group relative">
					<button
						class="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700/60 {current ? 'bg-sage/10' : ''}"
						on:click={() => open(pdf)}
						title={pdf.url ? `Open ${pdf.url}` : `Choose ${pdf.name} again to open it`}
						aria-current={current ? 'true' : undefined}
						data-testid="recent-pdf"
					>
						{#if pdf.url}
							<Link2 size={14} class="mt-0.5 shrink-0 text-slate dark:text-gray-400" />
						{:else}
							<FileText size={14} class="mt-0.5 shrink-0 text-slate dark:text-gray-400" />
						{/if}
						<span class="min-w-0 flex-1 pr-4">
							<span class="block truncate text-xs font-medium text-charcoal dark:text-gray-100">{pdf.title ?? pdf.name}</span>
							<span class="block truncate text-[11px] text-slate dark:text-gray-400">{details(pdf)}</span>
						</span>
					</button>
					<button
						class="absolute right-2 top-2 hidden rounded p-0.5 text-slate hover:bg-gray-200 group-hover:block dark:text-gray-400 dark:hover:bg-gray-600"
						on:click={() => removeRecentPdf(pdf.pdfKey)}
						aria-label="Remove {pdf.title ?? pdf.name} from recent PDFs"
					>
						<X size={12} />
					</button>
				</li>
			{:else}
				<li class="px-3 py-6 text-center text-xs text-slate dark:text-gray-400">
					{needle ? 'No match.' : 'PDFs you open on this device appear here.'}
				</li>
			{/each}
		</ul>
	</aside>
{/if}
