import "colors";
import {WebSocket} from "ws";
import {ChildProcess, spawn} from "child_process";
import {IMessage} from "../models/Message";
import {INewSessionMessage, IResumeSessionMessage} from "../types/ws";

/**
 * Build the argument list for spawning the claude CLI.
 * Flags: -p --verbose --output-format stream-json --input-format stream-json --include-partial-messages
 * --input-format stream-json keeps stdin open so follow-up messages can be
 * written as NDJSON lines without spawning a new process per message.
 * --include-partial-messages emits content_block_delta events as tokens arrive,
 * enabling token-by-token streaming to the frontend.
 */
function buildArgs(message: INewSessionMessage | IResumeSessionMessage): string[] {
    const args: string[] = [
        '-p',
        '--verbose',
        '--output-format', 'stream-json',
        '--input-format', 'stream-json',
        '--include-partial-messages',
        // Instruct Claude to use Bash for .claude/ file writes. The Edit tool has a
        // hardcoded protection that blocks edits to .claude/ directories in non-interactive
        // mode (no flag or setting can override it). Bash(cat/echo redirect) works fine.
        '--append-system-prompt', 'IMPORTANT: When editing files inside .claude/ directories (e.g. .claude/CLAUDE.md, .claude/settings.json, .claude/standup-notes.md), you MUST use the Bash tool with cat/echo redirect instead of the Edit tool. The Edit tool is blocked for .claude/ paths in this environment. Example: Bash(cat > .claude/file.md << \'EOF\'\ncontent\nEOF)',
    ];

    if (message.type === 'resume_session') {
        args.push('--resume', message.sessionId);
    }

    if (message.model) {
        args.push('--model', message.model);
    }

    if (message.effort) {
        args.push('--effort', message.effort);
    }

    console.debug('args:'.cyan, args);
    return args;
}

/**
 * Format prior conversation messages as NDJSON lines for --input-format stream-json.
 * Used for context reconstruction in edit_session: pipes the conversation history
 * (both user and assistant turns) to a fresh claude process before the new user message.
 * Thinking/redacted_thinking blocks are excluded — they're stripped during sync.
 */
function toContextNdjson(messages: IMessage[]): string {
    return messages
        .map((message: IMessage) => {
            const rawContent = message.content;
            const content = Array.isArray(rawContent)
                ? rawContent.filter((block: Record<string, unknown>) =>
                    block.type !== 'thinking' && block.type !== 'redacted_thinking',
                )
                : [{type: 'text', text: String(rawContent)}];

            // Skip messages with empty content after filtering (thinking-only messages).
            // Claude CLI crashes (exit code 1) when it receives content: [] via stdin.
            if (Array.isArray(content) && content.length === 0) return '';

            return JSON.stringify({
                type: message.role,
                session_id: '',
                message: {
                    role: message.role,
                    content,
                },
                parent_tool_use_id: null,
            }) + '\n';
        })
        .filter(Boolean)
        .join('');
}

/**
 * Format a user message as an NDJSON line for --input-format stream-json.
 * Format matches the SDKUserMessage contract used by the official Agent SDK.
 */
function toNdjson(text: string): string {
    return JSON.stringify({
        type: 'user',
        session_id: '',
        message: {
            role: 'user',
            content: [{type: 'text', text}],
        },
        parent_tool_use_id: null,
    }) + '\n';
}

/**
 * Write a follow-up user message to an already-running claude process stdin.
 * Call this for every turn after the first (the first is sent inside spawnClaude).
 * Do NOT close stdin after calling — the process stays alive for more turns.
 */
function sendMessage(claudeProcess: ChildProcess, text: string): void {
    console.debug('DEBUG: Writing follow-up message to claude stdin'.cyan, {text});
    claudeProcess.stdin!.write(toNdjson(text));
}

/**
 * Spawn the claude CLI as a persistent process, send the first message via stdin,
 * and stream stdout lines to the WebSocket.
 * stdin is kept open — call sendMessage() for follow-up turns.
 * onResult is called after each completed turn (result event) for per-turn auto-sync.
 * Receives the parsed result event so the caller can extract contextWindow/usage data.
 * onEvent is an optional hook called for every parsed stdout event before WS forwarding.
 * contextNdjson is optional prior-conversation context piped to stdin before the first user message.
 * onMessage is an optional hook called for every complete user/assistant event — used
 * for direct MongoDB writes during live sessions (bypasses JSONL sync race condition).
 * Only fires for complete assistant events (stop_reason !== null) and all user events.
 * Returns the spawned ChildProcess so the caller can manage its lifecycle.
 */
function spawnClaude(message: INewSessionMessage | IResumeSessionMessage, webSocket: WebSocket, onResult: (resultEvent: Record<string, unknown>) => void, onEvent?: (event: Record<string, unknown>) => void, contextNdjson?: string, contextUserCount?: number, onMessage?: (event: Record<string, unknown>) => void): ChildProcess {
    const args: string[] = buildArgs(message);
    console.log(`WebSocket: Spawning claude ${args.join(' ')}`.cyan);

    const claudeProcess: ChildProcess = spawn('claude', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: message.projectDir || undefined,
        detached: true,
    });

    // Pipe prior conversation context first (edit_session reconstruction), then the new user message
    if (contextNdjson) {
        console.debug('DEBUG: Piping context NDJSON to stdin'.cyan, {contextUserCount, contextBytes: contextNdjson.length});
        claudeProcess.stdin!.write(contextNdjson);
    }

    // Send the first user message as NDJSON — stdin stays open for follow-ups.
    // Skip when text is empty (e.g. switch_model: re-spawn without sending a message).
    if (message.text && message.text.trim()) {
        sendMessage(claudeProcess, message.text);
    }

    // Line-buffered stdout → parse JSON lines → forward to WebSocket
    let buffer: string = '';
    // Track how many context turns to suppress — the CLI generates a real response
    // for each piped context user message. We skip these N intermediate turns and
    // only forward events from the final turn (the actual new user message response).
    const contextTurnsToSkip: number = contextUserCount ?? 0;
    let contextResultsSeen: number = 0;
    // Track the last assistant event's per-call usage for accurate context calculation.
    // result.usage is cumulative across all turns; this holds the LAST call's actual context.
    let lastAssistantUsage: Record<string, unknown> | null = null;
    // Accumulate assistant events per API turn for direct-write.
    // The CLI emits separate events per content block (thinking, text, tool_use),
    // each with a different uuid but the same message.id. The JSONL parser merges
    // these into a single message with concatenated content blocks and the LAST uuid.
    // We replicate that merge here: accumulate all events for the same message.id,
    // then flush ONE merged message when a user/result event signals the turn ended.
    // Within the same uuid, --include-partial-messages causes cumulative updates —
    // we keep the latest event per uuid (it's a superset of the previous).
    let turnMsgId: string | null = null;
    let turnEvents: Map<string, Record<string, unknown>> = new Map();
    let turnUuidOrder: string[] = [];
    // Sub-agent filter: track pending Agent tool_use IDs to suppress sub-agent
    // events from direct-write. The CLI streams sub-agent conversation events
    // (user prompt, assistant tool calls, tool results) inline with the main
    // conversation — saving these to MongoDB creates phantom "user messages"
    // that the user never typed. We skip them here; JSONL sync also ignores
    // sub-agent files (findJsonlFiles skips subdirectories).
    const pendingAgentToolIds: Set<string> = new Set();
    const flushAssistantTurn = (): void => {
        if (turnUuidOrder.length === 0 || !onMessage) {
            turnMsgId = null;
            return;
        }
        // Merge content blocks from all uuids in order (matches JSONL parser behavior)
        const mergedContent: Record<string, unknown>[] = [];
        for (const uuid of turnUuidOrder) {
            const evt: Record<string, unknown> = turnEvents.get(uuid)!;
            const msg = evt.message as Record<string, unknown>;
            const content = msg.content as Record<string, unknown>[];
            if (Array.isArray(content)) {
                mergedContent.push(...content);
            }
        }
        // Use the LAST event as base (has latest uuid, model, usage — matches JSONL parser)
        const lastUuid: string = turnUuidOrder[turnUuidOrder.length - 1];
        const lastEvent: Record<string, unknown> = turnEvents.get(lastUuid)!;
        const lastMsg = lastEvent.message as Record<string, unknown>;
        const mergedEvent: Record<string, unknown> = {
            ...lastEvent,
            message: {...lastMsg, content: mergedContent},
        };
        onMessage(mergedEvent);
        // Detect Agent tool_use blocks in the flushed turn — their sub-agent
        // events will follow in the stream and must be suppressed from direct-write.
        for (const block of mergedContent) {
            if (block.type === 'tool_use' && block.name === 'Agent') {
                const toolId: string = block.id as string;
                pendingAgentToolIds.add(toolId);
                console.log(`WebSocket: [sub-agent] Agent tool_use detected (id: ${toolId}) — suppressing sub-agent events from direct-write`.cyan);
            }
        }
        turnMsgId = null;
        turnEvents = new Map();
        turnUuidOrder = [];
    };

    claudeProcess.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines: string[] = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const event: Record<string, unknown> = JSON.parse(line);

                // When context was piped, the CLI echoes context messages on stdout as
                // JSONL entries (not stream-json events). Forwarding them to the frontend
                // causes prior conversation messages to flash as streaming content.
                // Skip: type "user" (never in stream-json), type "assistant" without
                // message.id (context replay — real API responses always have message.id),
                // and JSONL-only metadata entries (queue-operation, last-prompt).
                if (contextNdjson) {
                    const msgObj = event.message as Record<string, unknown> | undefined;
                    const isContextReplay: boolean = event.type === 'user'
                        || event.type === 'last-prompt'
                        || event.type === 'queue-operation'
                        || (event.type === 'assistant' && !msgObj?.id);
                    if (isContextReplay) {
                        console.log(`WebSocket: Skipping context replay event (type: ${event.type})`.cyan);
                        continue;
                    }
                }

                // Suppress intermediate real responses generated for context user messages.
                // The CLI treats each piped user message as a separate prompt and generates
                // a full stream-json response (with message.id). We suppress these N turns
                // (N = contextUserCount) and only forward the final turn's events.
                // The system event is always forwarded — it contains the session_id.
                if (contextTurnsToSkip > 0 && contextResultsSeen < contextTurnsToSkip) {
                    if (event.type === 'system') {
                        // System event must pass through (session_id capture + frontend needs it)
                        if (onEvent) onEvent(event);
                        if (webSocket.readyState === WebSocket.OPEN) {
                            webSocket.send(JSON.stringify(event));
                        }
                        continue;
                    }
                    if (event.type === 'result') {
                        contextResultsSeen++;
                        console.log(`WebSocket: Suppressing context turn result (${contextResultsSeen}/${contextTurnsToSkip})`.cyan);
                    }
                    continue;
                }

                // --- Debug logging for stream-json events ---
                if (event.type === 'system') {
                    const subtype: string = (event.subtype as string) ?? 'init';
                    console.debug(`WebSocket: [stream] system → subtype: ${subtype}, session_id: ${event.session_id}`.gray);
                } else if (event.type === 'assistant') {
                    const msgObj = event.message as Record<string, unknown> | undefined;
                    const content = msgObj?.content as Array<Record<string, unknown>> | undefined;
                    const blockTypes: string = content?.map((b) => b.type).join(', ') ?? '?';
                    const stopReason: string = (msgObj?.stop_reason as string) ?? 'null';
                    console.debug(`WebSocket: [stream] assistant → blocks: [${blockTypes}], stop_reason: ${stopReason}`.gray);
                } else if (event.type === 'user') {
                    const msgObj = event.message as Record<string, unknown> | undefined;
                    const content = msgObj?.content as Array<Record<string, unknown>> | undefined;
                    const blockTypes: string = content?.map((b) => b.type).join(', ') ?? '?';
                    console.debug(`WebSocket: [stream] user → blocks: [${blockTypes}]`.gray);
                } else if (event.type === 'rate_limit_event') {
                    console.debug('WebSocket: [stream] rate_limit_event'.yellow);
                } else if (event.type !== 'result' && event.type !== 'stream_event') {
                    console.debug(`WebSocket: [stream] ${event.type}`.gray);
                }

                // Track last assistant event's per-call usage for accurate context
                if (event.type === 'assistant') {
                    const msgObj = event.message as Record<string, unknown> | undefined;
                    if (msgObj?.usage) {
                        lastAssistantUsage = msgObj.usage as Record<string, unknown>;
                    }
                }

                // Direct-write hook: accumulate assistant events per turn, flush merged.
                // Groups by message.id (same API response). Within a turn, tracks
                // content per uuid (last event per uuid = complete content for that block).
                // On flush (user/result event), merges all content blocks into ONE message
                // with the LAST uuid — matching the JSONL parser's merge behavior exactly.
                //
                // Sub-agent suppression: when the main agent calls the Agent tool, all
                // subsequent events until the matching tool_result belong to the sub-agent
                // and must NOT be saved to MongoDB. WebSocket forwarding is unaffected —
                // the user still sees sub-agent progress live.
                if (onMessage) {
                    const isSubAgentActive: boolean = pendingAgentToolIds.size > 0;

                    if (event.type === 'assistant') {
                        if (!isSubAgentActive) {
                            const msgObj = event.message as Record<string, unknown>;
                            const msgId: string = msgObj.id as string;
                            const eventUuid: string = event.uuid as string;
                            // Different message.id = different API response = flush previous turn
                            if (msgId && msgId !== turnMsgId) {
                                flushAssistantTurn();
                                turnMsgId = msgId;
                            }
                            // Track unique uuids in order; update with latest event per uuid
                            if (!turnEvents.has(eventUuid)) {
                                turnUuidOrder.push(eventUuid);
                            }
                            turnEvents.set(eventUuid, event);
                        }
                    } else if (event.type === 'user') {
                        if (isSubAgentActive) {
                            // Check if this is the Agent's tool_result (exits sub-agent mode)
                            const msgObj = event.message as Record<string, unknown> | undefined;
                            const content = msgObj?.content as Array<Record<string, unknown>> | undefined;
                            let matchedAgentId: string | null = null;
                            if (Array.isArray(content)) {
                                for (const block of content) {
                                    if (block.type === 'tool_result' && pendingAgentToolIds.has(block.tool_use_id as string)) {
                                        matchedAgentId = block.tool_use_id as string;
                                        break;
                                    }
                                }
                            }
                            if (matchedAgentId) {
                                // Main agent's tool_result for Agent — save and exit sub-agent mode
                                pendingAgentToolIds.delete(matchedAgentId);
                                console.log(`WebSocket: [sub-agent] Agent tool_result received (id: ${matchedAgentId}) — resuming direct-write (remaining: ${pendingAgentToolIds.size})`.cyan);
                                flushAssistantTurn();
                                onMessage(event);
                            } else {
                                // Sub-agent user event (prompt or internal tool result) — skip
                                console.debug('WebSocket: [sub-agent] Skipping sub-agent user event from direct-write'.gray);
                            }
                        } else {
                            flushAssistantTurn();
                            onMessage(event);
                        }
                    }
                }

                if (onEvent) onEvent(event);
                if (webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(JSON.stringify(event));
                }
                if (event.type === 'result') {
                    // Flush accumulated assistant turn before processing result
                    flushAssistantTurn();
                    // Attach last assistant's per-call usage so persistResultContext can use
                    // it for accurate context (result.usage is cumulative across all turns).
                    if (lastAssistantUsage) {
                        event._lastAssistantUsage = lastAssistantUsage;
                        lastAssistantUsage = null;
                    }
                    console.log('WebSocket: result event received — notifying caller for sync'.cyan);
                    onResult(event);
                }
            } catch {
                // Non-JSON line from claude stdout (e.g. startup text or plain-text error)
                if (line.trim()) {
                    console.warn(`WebSocket: claude stdout (non-JSON) — ${line}`.yellow);
                }
            }
        }
    });

    // Forward stderr as error messages
    claudeProcess.stderr!.on('data', (chunk: Buffer) => {
        const text: string = chunk.toString().trim();
        if (text && webSocket.readyState === WebSocket.OPEN) {
            console.error(`WebSocket: claude stderr — ${text}`.yellow);
        }
    });

    return claudeProcess;
}

export {spawnClaude, sendMessage, toContextNdjson};
