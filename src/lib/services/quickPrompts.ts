/** One-click questions offered when a passage is first brought into a conversation. */

export interface QuickPrompt {
	label: string;
	/** Sent as the user's question. */
	prompt: string;
}

/** Starting a conversation about a passage. */
export const NEW_CONVERSATION_PROMPTS: QuickPrompt[] = [
	{ label: 'Explain the concept', prompt: 'Explain the concept in this passage.' },
	{ label: 'Simplify', prompt: 'Explain this passage in simpler terms, as if to someone new to the field.' },
	{ label: 'Why it matters', prompt: 'Why does this matter for the paper’s argument or results?' },
	{ label: 'Define the terms', prompt: 'Define the key terms and symbols used in this passage.' },
	{ label: 'Walk through the math', prompt: 'Walk through the math in this passage step by step.' },
	{ label: 'Give an example', prompt: 'Give a concrete example that illustrates this passage.' }
];

/** Adding another passage to a conversation already under way. */
export const ADDED_PASSAGE_PROMPTS: QuickPrompt[] = [
	{ label: 'How does this relate?', prompt: 'How does this passage relate to what we have discussed so far?' },
	{ label: 'Compare', prompt: 'Compare this passage with the one this conversation started from.' },
	{ label: 'Explain the concept', prompt: 'Explain the concept in this passage.' },
	{ label: 'Simplify', prompt: 'Explain this passage in simpler terms, as if to someone new to the field.' }
];
