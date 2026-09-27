/** One-click questions offered when a passage is first brought into a conversation. */

export interface QuickPrompt {
	label: string;
	/** Sent as the user's question. */
	prompt: string;
}

/** Starting a conversation about a passage. */
export const NEW_CONVERSATION_PROMPTS: QuickPrompt[] = [
	{ label: 'Explain the concept', prompt: 'Explain the concept in this passage in a few sentences.' },
	{
		label: 'Simplify',
		prompt: 'Explain this passage in simpler terms, in a few sentences. Stick to what the passage says.'
	},
	{ label: 'Why it matters', prompt: 'In two or three sentences, why does this passage matter for the paper’s results?' },
	{ label: 'Define the terms', prompt: 'Define the key terms and symbols in this passage, one line each.' },
	{ label: 'Walk through the math', prompt: 'Walk through the math in this passage step by step, briefly.' },
	{ label: 'Give an example', prompt: 'Give one short, concrete example that illustrates this passage.' }
];

/** Adding another passage to a conversation already under way. */
export const ADDED_PASSAGE_PROMPTS: QuickPrompt[] = [
	{ label: 'How does this relate?', prompt: 'In a few sentences, how does this passage relate to what we discussed?' },
	{ label: 'Compare', prompt: 'Briefly compare this passage with the one this conversation started from.' },
	{ label: 'Explain the concept', prompt: 'Explain the concept in this passage in a few sentences.' },
	{
		label: 'Simplify',
		prompt: 'Explain this passage in simpler terms, in a few sentences. Stick to what the passage says.'
	}
];
