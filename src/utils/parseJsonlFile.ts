import "colors";
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
const STRIP_THINKING_BLOCKS: boolean = false;   // thinking blocks are large and not displayed in UI
const STRIP_TOOL_RESULTS: boolean = false;      // tool results provide useful context for viewing

// --- Helpers ---

/**
 * Compute total context window input tokens from a usage object.
 * Context window = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 * (cache affects pricing, not context window size — all cached tokens still occupy the window)
 */
function computeTotalInputTokens(usage: Record<string, unknown>): number {
    const input: number = (usage.input_tokens as number) || 0;
    const cacheCreation: number = (usage.cache_creation_input_tokens as number) || 0;
    const cacheRead: number = (usage.cache_read_input_tokens as number) || 0;
    return input + cacheCreation + cacheRead;
}

// --- Function ---

/**
 * Parse a single JSONL file into structured session data
 * Returns null if file has no user/assistant messages
 */
function parseJsonlFile(filePath: string): IParsedFile | null {
    console.debug('DEBUG: Parsing JSONL file'.cyan, {file: path.basename(filePath)});
    const raw: string = fs.readFileSync(filePath, 'utf-8');
    const lines: string[] = raw.split('\n');

    const messages: IParsedMessage[] = [];
    // Track uuid → parentUuid for ALL entries (including non-stored ones like result, system,
    // progress, file-history-snapshot) so we can re-parent stored messages whose parentUuid
    // references a non-stored entry — without this, getActiveBranch's tree walk breaks at
    // turn boundaries where result entries act as bridge nodes.
    const allUuidToParent: Map<string, string | undefined> = new Map();
    let sessionId: string = '';
    let projectDir: string = '';
    let rawProjectDir: string = '';
    let gitBranch: string | undefined;
    let slug: string | undefined;
    let aiModel: string | undefined;
    let customTitle: string | undefined;
    let firstUserMessage: string = '';
    let contextTokensUsed: number | undefined;
    // Track last assistant message.id for merging split JSONL entries.
    // Claude CLI writes each content block as a separate JSONL line, but they
    // share the same message.id and should be combined into a single message.
    let lastAssistantMsgId: string | null = null;

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
            rawProjectDir = parsedLine.cwd as string;
            projectDir = rawProjectDir.replace(NON_ALPHANUMERIC_REGEX, '-');
        }
        if (parsedLine.gitBranch) {
            gitBranch = parsedLine.gitBranch as string;
        }
        if (parsedLine.slug) {
            slug = parsedLine.slug as string;
        }

        // Record uuid → parentUuid for every entry (before any type-specific continue).
        // Non-stored entries (result, system, progress, etc.) must still be tracked so
        // we can resolve parentUuid chains for stored messages in the post-loop pass.
        const entryUuid: string | undefined = parsedLine.uuid as string | undefined;
        if (entryUuid) {
            allUuidToParent.set(entryUuid, parsedLine.parentUuid as string | undefined);
        }

        // Extract custom title from /rename command
        if (lineType === 'custom-title' && parsedLine.customTitle) {
            customTitle = parsedLine.customTitle as string;
        }

        // Skip result events — result.usage is cumulative across all API calls/turns,
        // NOT the current context size. contextTokensUsed is set from the last assistant
        // event's per-call usage below, which reflects the actual context.
        if (lineType === 'result') {
            continue;
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

        // Apply sync filters to content blocks
        let content: string | Record<string, unknown>[] = message.content as string | Record<string, unknown>[];
        if (Array.isArray(content)) {
            if (STRIP_THINKING_BLOCKS) content = content.filter((block) => (block as Record<string, unknown>).type !== 'thinking');
            if (STRIP_TOOL_RESULTS) content = content.filter((block) => (block as Record<string, unknown>).type !== 'tool_result');
        }

        // Merge consecutive assistant JSONL entries with the same message.id.
        // Claude CLI writes each content block (thinking, text, tool_use) as a separate
        // JSONL line, but they belong to the same logical message. Merge them so the
        // historical view matches the live streaming view.
        const msgId: string | undefined = message.id as string | undefined;

        if (messageRole === EMessageRole.ASSISTANT && msgId && msgId === lastAssistantMsgId && messages.length > 0) {
            const lastMsg: IParsedMessage = messages[messages.length - 1];
            if (lastMsg.role === EMessageRole.ASSISTANT && Array.isArray(lastMsg.content) && Array.isArray(content)) {
                // Redirect the OLD merged uuid so that any message whose parentUuid
                // points to it (e.g. a tool_result for a specific tool_use block) will
                // re-parent to the final merged uuid instead of walking to root.
                const previousMergedUuid: string = lastMsg.uuid;
                const newUuid: string = parsedLine.uuid as string;
                allUuidToParent.set(previousMergedUuid, newUuid);

                // Append new blocks to existing message
                (lastMsg.content as Record<string, unknown>[]).push(...(content as Record<string, unknown>[]));
                // Update uuid + timestamp to latest entry's values.
                // IMPORTANT: Do NOT update parentUuid — the first entry's parentUuid
                // points to the previous stored message (e.g. user prompt). Updating it
                // would set it to an intermediate UUID within this merged group, which
                // the redirect above maps forward to the merged uuid → self-loop.
                lastMsg.uuid = newUuid;
                lastMsg.timestamp = new Date(parsedLine.timestamp as string);
                if (message.model) {
                    lastMsg.aiModel = message.model as string;
                }
                const usage: Record<string, unknown> | undefined = message.usage as Record<string, unknown> | undefined;
                if (usage) {
                    const perCallInput: number = computeTotalInputTokens(usage);
                    lastMsg.tokenUsage = {
                        input: perCallInput,
                        output: (usage.output_tokens as number) || 0,
                    };
                    if (perCallInput > 0) {
                        contextTokensUsed = perCallInput;
                    }
                }
                continue;
            }
        }

        // Build new message entry
        const parsedMessage: IParsedMessage = {
            uuid: parsedLine.uuid as string,
            parentUuid: parsedLine.parentUuid as string | undefined,
            role: messageRole,
            content,
            timestamp: new Date(parsedLine.timestamp as string),
        };

        if (messageRole === EMessageRole.ASSISTANT) {
            lastAssistantMsgId = msgId ?? null;
            if (message.model) {
                parsedMessage.aiModel = message.model as string;
            }
            const usage: Record<string, unknown> | undefined = message.usage as Record<string, unknown> | undefined;
            if (usage) {
                const perCallInput: number = computeTotalInputTokens(usage);
                parsedMessage.tokenUsage = {
                    input: perCallInput,
                    output: (usage.output_tokens as number) || 0,
                };
                if (perCallInput > 0) {
                    contextTokensUsed = perCallInput;
                }
            }
        } else {
            // Reset on user message — prevents merging across user/assistant boundaries
            lastAssistantMsgId = null;
        }

        messages.push(parsedMessage);
    }

    // Re-parent stored messages: if a message's parentUuid points to a non-stored entry
    // (result, system, progress, etc.), walk up through ancestors until finding a stored
    // uuid or reaching root (undefined). This keeps the parentUuid chain intact for
    // getActiveBranch's tree walk on the frontend.
    const storedUuids: Set<string> = new Set(messages.map((m: IParsedMessage) => m.uuid));
    for (const message of messages) {
        let parent: string | undefined = message.parentUuid;
        while (parent && !storedUuids.has(parent)) {
            parent = allUuidToParent.get(parent);
        }
        message.parentUuid = parent;
    }

    if (messages.length === 0) {
        console.debug('DEBUG: No messages found, skipping file'.cyan, {file: path.basename(filePath)});
        return null;
    }

    console.debug('DEBUG: Parsed JSONL file'.cyan, {file: path.basename(filePath), sessionId, messages: messages.length, title: customTitle || slug || firstUserMessage?.substring(0, 40) || 'Untitled'});
    return {
        sessionId,
        projectDir,
        rawProjectDir,
        gitBranch,
        slug,
        aiModel,
        title: customTitle || slug || firstUserMessage || 'Untitled session',
        messages,
        contextTokensUsed,
    };
}

export {parseJsonlFile};
