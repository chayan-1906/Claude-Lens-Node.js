import fs from "fs";
import path from "path";
import {EMessageRole} from "../models/Message";
import {NON_ALPHANUMERIC_REGEX} from "./constants";
import {IParsedFile, IParsedMessage} from "../types/sync";

// --- Constants ---

const TITLE_MAX_LENGTH: number = 100;

// --- Sync filters ---
// Toggle these to control what gets stored in MongoDB
// Comment out a line to disable that filter (i.e. store everything)
const STRIP_THINKING_BLOCKS: boolean = true;    // thinking blocks are large and not displayed in UI
const STRIP_TOOL_RESULTS: boolean = false;      // tool results provide useful context for viewing

// --- Function ---

/**
 * Parse a single JSONL file into structured session data
 * Returns null if file has no user/assistant messages
 */
function parseJsonlFile(filePath: string): IParsedFile | null {
    const raw: string = fs.readFileSync(filePath, 'utf-8');
    const lines: string[] = raw.split('\n');

    const messages: IParsedMessage[] = [];
    let sessionId: string = '';
    let projectDir: string = '';
    let gitBranch: string | undefined;
    let slug: string | undefined;
    let aiModel: string | undefined;
    let customTitle: string | undefined;
    let firstUserMessage: string = '';

    for (let i: number = 0; i < lines.length; i++) {
        const line: string = lines[i].trim();
        if (!line) continue;

        let parsedLine: Record<string, unknown>;
        try {
            parsedLine = JSON.parse(line);
        } catch {
            console.warn(`  Warning: Malformed JSON at line ${i + 1} in ${path.basename(filePath)}`.yellow);
            continue;
        }

        const lineType: string = parsedLine.type as string;

        // Extract metadata from every line (slug can appear on later lines)
        if (!sessionId && parsedLine.sessionId) {
            sessionId = parsedLine.sessionId as string;
        }
        if (!projectDir && parsedLine.cwd) {
            projectDir = (parsedLine.cwd as string).replace(NON_ALPHANUMERIC_REGEX, '-');
        }
        if (parsedLine.gitBranch) {
            gitBranch = parsedLine.gitBranch as string;
        }
        if (parsedLine.slug) {
            slug = parsedLine.slug as string;
        }

        // Extract custom title from /rename command
        if (lineType === 'custom-title' && parsedLine.customTitle) {
            customTitle = parsedLine.customTitle as string;
        }

        // Only store user and assistant messages
        if (lineType !== 'user' && lineType !== 'assistant') continue;

        const message: Record<string, unknown> = parsedLine.message as Record<string, unknown>;
        if (!message) continue;

        const role: string = message.role as string;
        if (role !== 'user' && role !== 'assistant') continue;

        const messageRole: EMessageRole = role === 'user' ? EMessageRole.USER : EMessageRole.ASSISTANT;

        // Extract first user message as fallback title
        if (!firstUserMessage && messageRole === EMessageRole.USER && typeof message.content === 'string') {
            firstUserMessage = message.content.length > TITLE_MAX_LENGTH
                ? message.content.substring(0, TITLE_MAX_LENGTH) + '...'
                : message.content;
        }

        // Extract aiModel from first assistant message (for session-level)
        if (!aiModel && messageRole === EMessageRole.ASSISTANT && message.model) {
            aiModel = message.model as string;
        }

        // Apply sync filters to assistant content blocks
        let content: string | Record<string, unknown>[] = message.content as string | Record<string, unknown>[];
        if (Array.isArray(content)) {
            if (STRIP_THINKING_BLOCKS) content = content.filter((block) => (block as Record<string, unknown>).type !== 'thinking');
            if (STRIP_TOOL_RESULTS) content = content.filter((block) => (block as Record<string, unknown>).type !== 'tool_result');
        }

        // Build parsedLine message
        const parsedMessage: IParsedMessage = {
            uuid: parsedLine.uuid as string,
            role: messageRole,
            content,
            timestamp: new Date(parsedLine.timestamp as string),
        };

        if (messageRole === EMessageRole.ASSISTANT) {
            // Extract aiModel from each assistant message (for message-level)
            if (message.model) {
                parsedMessage.aiModel = message.model as string;
            }
            const usage: Record<string, unknown> | undefined = message.usage as Record<string, unknown> | undefined;
            if (usage) {
                parsedMessage.tokenUsage = {
                    input: (usage.input_tokens as number) || 0,
                    output: (usage.output_tokens as number) || 0,
                };
            }
        }

        messages.push(parsedMessage);
    }

    if (messages.length === 0) return null;

    return {
        sessionId,
        projectDir,
        gitBranch,
        slug,
        aiModel,
        title: customTitle || slug || firstUserMessage || 'Untitled session',
        messages,
    };
}

export {parseJsonlFile};
