import {ContentBlock} from "../models/Message";

const SNIPPET_LEN = 150;

export function extractTextFromContent(content: string | ContentBlock[]): string {
    if (typeof content === 'string') return content;
    const parts: string[] = [];
    for (const block of content) {
        if (block.type === 'text') parts.push(block.text);
        else if (block.type === 'thinking') parts.push(block.thinking);
    }
    return parts.join(' ');
}

export function makeSnippet(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length <= SNIPPET_LEN) return trimmed;
    return trimmed.slice(0, SNIPPET_LEN).trimEnd() + '…';
}
