import "colors";
import fs from "fs";
import path from "path";
import {ChildProcess} from "child_process";
import {WebSocket, WebSocketServer} from "ws";
import {IncomingMessage, Server as HttpServer} from "http";
import TaskModel from "../models/Task";
import MemoryModel from "../models/Memory";
import {IMessage} from "../models/Message";
import SyncService from "../services/SyncService";
import SessionService from "../services/SessionService";
import {NON_ALPHANUMERIC_REGEX} from "../utils/constants";
import SessionModel, {ESessionSource, ISession} from "../models/Session";
import {sendMessage, spawnClaude, toContextNdjson} from "./claudeSpawner";
import {cleanupSession, registerSession, resolveApproval} from "./toolApprovalStore";
import {ClientMessage, IEditSessionMessage, INewSessionMessage, IProjectNotAvailableMessage, IResumeSessionMessage, IToolApprovalResponseMessage} from "../types/ws";

/**
 * Check if the local JSONL session file exists for the given projectDir + sessionId.
 * Claude stores sessions at ~/.claude/projects/{projectDirHash}/{sessionId}.jsonl
 * where projectDirHash replaces all non-alphanumeric chars with '-'.
 */
function isLocalSessionAvailable(projectDir: string, sessionId: string): boolean {
    const claudeProjectsDir: string = path.join(process.env.HOME || '~', '.claude', 'projects');
    const projectDirHash: string = projectDir.replace(NON_ALPHANUMERIC_REGEX, '-');
    const jsonlPath: string = path.join(claudeProjectsDir, projectDirHash, `${sessionId}.jsonl`);

    console.log(`WebSocket: [TRACE] isLocalSessionAvailable — checking: ${jsonlPath}`.cyan);

    if (!fs.existsSync(jsonlPath)) {
        console.log(`WebSocket: [TRACE] isLocalSessionAvailable — file NOT found → false`.cyan);
        return false;
    }

    // Validate: if any user/assistant message has empty content, the JSONL is broken.
    // Claude exits with code 1 on resume when it encounters content: [] in the session.
    // Also: a JSONL with only metadata (e.g. last-prompt) and no user/assistant entries
    // is effectively empty — Claude CLI writes last-prompt on every run, even failed ones.
    // Return false so the caller falls back to reconstructing from MongoDB.
    try {
        const lines: string[] = fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean);
        console.log(`WebSocket: [TRACE] isLocalSessionAvailable — file found, validating ${lines.length} lines`.cyan);
        let hasConversationEntry: boolean = false;
        for (const line of lines) {
            const entry = JSON.parse(line) as Record<string, unknown>;
            if (entry.type === 'user' || entry.type === 'assistant') {
                hasConversationEntry = true;
                const content = (entry.message as Record<string, unknown>)?.content;
                const contentSummary: string = !content ? 'null/undefined'
                    : Array.isArray(content) ? `ContentBlock[${(content as unknown[]).length}]`
                        : `string(${String(content).length})`;
                console.log(`WebSocket: [TRACE] isLocalSessionAvailable — type=${entry.type} content=${contentSummary}`.cyan);
                if (!content || (Array.isArray(content) && (content as unknown[]).length === 0)) {
                    console.warn(`WebSocket: [TRACE] isLocalSessionAvailable — BROKEN (empty content for ${entry.type}) → false`.yellow);
                    return false;
                }
            }
        }

        if (!hasConversationEntry) {
            console.warn(`WebSocket: [TRACE] isLocalSessionAvailable — BROKEN (no user/assistant entries, only metadata) → false`.yellow);
            return false;
        }
    } catch (err) {
        console.error(`WebSocket: [TRACE] isLocalSessionAvailable — parse error: ${err} → false`.red);
        return false;
    }

    console.log(`WebSocket: [TRACE] isLocalSessionAvailable — VALID → true`.cyan);
    return true;
}

/**
 * Repair a local JSONL session file by stripping trailing orphaned tool_use entries.
 * The Anthropic API returns 400 if the conversation history has tool_use blocks in an
 * assistant message without a matching tool_result in the next user message.
 * This happens when a session is interrupted mid-tool-call (e.g. force quit, tab close).
 *
 * Strategy: walk backwards from the end of the JSONL. If the last user/assistant entry
 * is an assistant message whose content ends with tool_use blocks (no following tool_result),
 * remove it. Repeat until the history ends cleanly.
 */
function repairOrphanedToolUse(projectDir: string, sessionId: string): void {
    const claudeProjectsDir: string = path.join(process.env.HOME || '~', '.claude', 'projects');
    const projectDirHash: string = projectDir.replace(NON_ALPHANUMERIC_REGEX, '-');
    const jsonlPath: string = path.join(claudeProjectsDir, projectDirHash, `${sessionId}.jsonl`);

    if (!fs.existsSync(jsonlPath)) return;

    try {
        const lines: string[] = fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean);
        let trimCount: number = 0;

        // Walk backwards: remove trailing assistant entries that end with tool_use
        // and have no following user entry with tool_result
        while (lines.length > 0) {
            const lastLine: string = lines[lines.length - 1];
            const entry = JSON.parse(lastLine) as Record<string, unknown>;

            if (entry.type !== 'assistant') break;

            const message = entry.message as Record<string, unknown> | undefined;
            const content = message?.content;
            if (!Array.isArray(content)) break;

            const hasToolUse: boolean = (content as Record<string, unknown>[]).some(
                (block: Record<string, unknown>) => block.type === 'tool_use',
            );

            if (!hasToolUse) break;

            // This assistant message has tool_use blocks with no following tool_result — remove it
            lines.pop();
            trimCount++;
            console.log(`WebSocket: [REPAIR] Removed orphaned tool_use assistant entry (trimCount: ${trimCount})`.yellow);
        }

        if (trimCount > 0) {
            fs.writeFileSync(jsonlPath, lines.join('\n') + '\n', 'utf-8');
            console.log(`WebSocket: [REPAIR] Repaired JSONL — removed ${trimCount} trailing orphaned tool_use entries from ${jsonlPath}`.yellow);
        }
    } catch (err) {
        console.error(`WebSocket: [REPAIR] Failed to repair JSONL — ${err}`.red);
    }
}

/**
 * Reconstruct a Claude session JSONL file from MongoDB data and write it to
 * ~/.claude/projects/{session.projectDir}/{session.sessionId}.jsonl.
 * Creates the directory if it doesn't exist.
 * Note: tool_use/tool_result blocks and thinking blocks may be absent
 * if they were stripped during the original sync.
 */
function reconstructAndSaveJsonl(session: ISession, messages: IMessage[]): void {
    const claudeProjectsDir: string = path.join(process.env.HOME || '~', '.claude', 'projects');
    const sessionDir: string = path.join(claudeProjectsDir, session.projectDir);
    const jsonlPath: string = path.join(sessionDir, `${session.sessionId}.jsonl`);

    fs.mkdirSync(sessionDir, {recursive: true});

    // Step 1: Filter out messages with empty content (stripped thinking/tool blocks)
    const filtered: IMessage[] = messages.filter((message: IMessage) => {
        const content = message.content;
        if (Array.isArray(content) && content.length === 0) {
            console.warn(`WebSocket: [RECONSTRUCT] Skipping ${message.role} message (uuid: ${message.uuid}) — empty content array`.yellow);
            return false;
        }
        return true;
    });

    // Step 2: Collect all tool_use IDs present in assistant messages
    const toolUseIds: Set<string> = new Set();
    for (const message of filtered) {
        if (message.role === 'assistant' && Array.isArray(message.content)) {
            for (const block of message.content as Record<string, unknown>[]) {
                if (block.type === 'tool_use' && typeof block.id === 'string') {
                    toolUseIds.add(block.id);
                }
            }
        }
    }

    // Step 3: Strip orphaned tool_result blocks (reference tool_use IDs that were stripped)
    // and remove user messages that become empty after stripping
    const cleaned: IMessage[] = [];
    for (const message of filtered) {
        if (message.role === 'user' && Array.isArray(message.content)) {
            const blocks = (message.content as Record<string, unknown>[]).filter((block: Record<string, unknown>) => {
                if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                    if (!toolUseIds.has(block.tool_use_id)) {
                        console.warn(`WebSocket: [RECONSTRUCT] Stripping orphaned tool_result (tool_use_id: ${block.tool_use_id}) from user message (uuid: ${message.uuid})`.yellow);
                        return false;
                    }
                }
                return true;
            });
            if (blocks.length === 0) {
                console.warn(`WebSocket: [RECONSTRUCT] Removing user message (uuid: ${message.uuid}) — all content was orphaned tool_results`.yellow);
                continue;
            }
            cleaned.push({...message, content: blocks} as IMessage);
        } else {
            cleaned.push(message);
        }
    }

    // Step 4: Merge consecutive same-role messages to maintain valid alternation.
    // Filtering empty-content messages can leave consecutive user or assistant entries
    // which the Anthropic API rejects with 400.
    const merged: IMessage[] = [];
    for (const message of cleaned) {
        const prev: IMessage | undefined = merged[merged.length - 1];
        if (prev && prev.role === message.role) {
            console.warn(`WebSocket: [RECONSTRUCT] Merging consecutive ${message.role} message (uuid: ${message.uuid}) into previous (uuid: ${prev.uuid})`.yellow);
            // Normalize both to ContentBlock[] and concatenate
            const prevContent: Record<string, unknown>[] = typeof prev.content === 'string'
                ? [{type: 'text', text: prev.content}]
                : prev.content as Record<string, unknown>[];
            const curContent: Record<string, unknown>[] = typeof message.content === 'string'
                ? [{type: 'text', text: message.content}]
                : message.content as Record<string, unknown>[];
            (prev as unknown as Record<string, unknown>).content = [...prevContent, ...curContent];
        } else {
            merged.push(message);
        }
    }

    console.log(`WebSocket: [RECONSTRUCT] Pipeline: ${messages.length} raw → ${filtered.length} filtered → ${cleaned.length} cleaned → ${merged.length} merged`.cyan);

    const lines: string[] = merged
        .map((message: IMessage) => JSON.stringify({
            type: message.role,
            uuid: message.uuid,
            parentUuid: message.parentUuid ?? null,
            sessionId: session.sessionId,
            timestamp: message.timestamp ? (message.timestamp as Date).toISOString() : new Date().toISOString(),
            cwd: session.rawProjectDir,
            message: {
                role: message.role,
                content: message.content,
                ...(message.aiModel ? {model: message.aiModel} : {}),
            },
        }));

    if (lines.length === 0) {
        console.warn(`WebSocket: [TRACE] reconstructAndSaveJsonl — 0 lines after filter (all messages had empty content?), writing empty JSONL`.yellow);
    }

    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n', 'utf-8');
    console.log(`WebSocket: Reconstructed session JSONL at ${jsonlPath} (${lines.length} messages)`.cyan);
    console.log(`WebSocket: [TRACE] reconstructAndSaveJsonl — written to: ${jsonlPath}, rawProjectDir: ${session.rawProjectDir}`.cyan);
}

/**
 * Reconstruct task JSON files from MongoDB and write them to
 * ~/.claude/tasks/{sessionId}/{taskId}.json.
 * Skips if the task directory already exists with files on disk.
 * Returns the number of tasks restored.
 */
async function reconstructAndSaveTasks(sessionId: string): Promise<number> {
    const tasksDir: string = path.join(process.env.HOME || '~', '.claude', 'tasks', sessionId);

    // Skip if local task files already exist
    if (fs.existsSync(tasksDir)) {
        const existing: string[] = fs.readdirSync(tasksDir).filter((name: string) => name.endsWith('.json'));
        if (existing.length > 0) {
            return 0;
        }
    }

    const tasks = await TaskModel.find({sessionId});
    if (tasks.length === 0) {
        return 0;
    }

    fs.mkdirSync(tasksDir, {recursive: true});

    for (const task of tasks) {
        const rawTask = {
            id: task.taskId,
            subject: task.subject,
            description: task.description,
            ...(task.activeForm ? {activeForm: task.activeForm} : {}),
            status: task.status,
            blocks: task.blocks ?? [],
            blockedBy: task.blockedBy ?? [],
        };
        fs.writeFileSync(path.join(tasksDir, `${task.taskId}.json`), JSON.stringify(rawTask, null, 2), 'utf-8');
    }

    console.log(`WebSocket: Reconstructed ${tasks.length} task(s) at ${tasksDir}`.cyan);
    return tasks.length;
}

/** Marker path segment used to extract relative memory file paths */
const MEMORY_PATH_MARKER: string = '/memory/';

/**
 * Reconstruct all memory files from MongoDB and write them to
 * ~/.claude/projects/{projectDir}/memory/.
 * Skips if the memory directory already exists with files on disk.
 * Returns true if any files were restored.
 */
async function reconstructAndSaveMemory(projectDir: string): Promise<boolean> {
    const claudeProjectsDir: string = path.join(process.env.HOME || '~', '.claude', 'projects');
    const memoryDir: string = path.join(claudeProjectsDir, projectDir, 'memory');

    // Skip if memory dir already exists with files
    if (fs.existsSync(memoryDir) && fs.readdirSync(memoryDir).length > 0) {
        return false;
    }

    const memories = await MemoryModel.find({projectDir});
    if (memories.length === 0) {
        return false;
    }

    fs.mkdirSync(memoryDir, {recursive: true});

    for (const memory of memories) {
        // Extract relative path after /memory/ marker — mirrors ExportService pattern
        const markerIndex: number = memory.filePath.lastIndexOf(MEMORY_PATH_MARKER);
        const relPath: string = markerIndex >= 0
            ? memory.filePath.substring(markerIndex + MEMORY_PATH_MARKER.length)
            : path.basename(memory.filePath);
        const outputPath: string = path.join(memoryDir, relPath);
        fs.mkdirSync(path.dirname(outputPath), {recursive: true});
        fs.writeFileSync(outputPath, memory.content, 'utf-8');
    }

    console.log(`WebSocket: Reconstructed ${memories.length} memory file(s) at ${memoryDir}`.cyan);
    return true;
}

/**
 * Walk the parentUuid-linked message tree and return only the active branch.
 * Matches the getActiveBranch logic in the frontend — always picks the latest child.
 */
function getActiveBranch(messages: IMessage[]): IMessage[] {
    const hasTreeData: boolean = messages.some((m: IMessage) => m.parentUuid !== undefined && m.parentUuid !== null);
    if (!hasTreeData) return messages;

    const childrenMap: Map<string | null, IMessage[]> = new Map();
    for (const msg of messages) {
        const key: string | null = msg.parentUuid ?? null;
        if (!childrenMap.has(key)) childrenMap.set(key, []);
        childrenMap.get(key)!.push(msg);
    }

    const result: IMessage[] = [];
    let currentUuid: string | null = null;
    while (true) {
        const children: IMessage[] | undefined = childrenMap.get(currentUuid);
        if (!children?.length) break;
        const next: IMessage = children.reduce((a: IMessage, b: IMessage) =>
            new Date(a.timestamp as Date) > new Date(b.timestamp as Date) ? a : b,
        );
        result.push(next);
        currentUuid = next.uuid;
    }
    return result;
}

/**
 * Kill the Claude process and its entire process group.
 * Step 1: SIGTERM (graceful shutdown).
 * Step 2: SIGKILL after 500ms if still alive (force kill).
 * Uses negative PID to kill the entire process group (requires detached: true on spawn).
 */
function killClaudeProcess(claudeProcess: ChildProcess): void {
    if (!claudeProcess || claudeProcess.killed) return;

    const pid: number | undefined = claudeProcess.pid;

    // Step 1: Graceful shutdown
    if (pid) {
        try {
            process.kill(-pid, 'SIGTERM');
        } catch {
            claudeProcess.kill('SIGTERM');
        }
    } else {
        claudeProcess.kill('SIGTERM');
    }

    // Step 2: Force kill if still alive after 500ms
    const forceKillTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
        if (!claudeProcess.killed) {
            console.log('WebSocket: Claude process still alive after 500ms — sending SIGKILL'.yellow);
            if (pid) {
                try {
                    process.kill(-pid, 'SIGKILL');
                } catch {
                    claudeProcess.kill('SIGKILL');
                }
            } else {
                claudeProcess.kill('SIGKILL');
            }
        }
    }, 500);

    claudeProcess.once('exit', () => clearTimeout(forceKillTimer));
}

/**
 * Attach a WebSocketServer to the given HTTP server at path /ws.
 * Handles message routing, claude process lifecycle, and auto-sync.
 * No auth needed — both servers always run locally on the same Mac inside the .app bundle.
 *
 * Protocol:
 *   new_session / resume_session  → spawns a persistent claude process, sends first message
 *   send_message                  → writes follow-up message to the same process stdin (no re-spawn)
 *   ping                          → pong
 *   WS close                      → kills the process, triggers auto-sync
 */
function attachWebSocket(httpServer: HttpServer): WebSocketServer {
    const webSocketServer: WebSocketServer = new WebSocketServer({server: httpServer, path: '/ws'});

    webSocketServer.on('connection', (webSocket: WebSocket, _req: IncomingMessage) => {
        console.log('WebSocket: Client connected'.green.bold);

        let claudeProcess: ChildProcess | null = null;
        let syncTimer: ReturnType<typeof setTimeout> | null = null;
        let activeSessionId: string | null = null;

        /** Register session → WS mapping when system event provides the session_id */
        const onSystemEvent = (event: Record<string, unknown>): void => {
            if (event.type === 'system' && event.session_id) {
                activeSessionId = event.session_id as string;
                registerSession(activeSessionId, webSocket);
            }
        }

        /**
         * Schedule a sync callback with 1500ms delay (debounced).
         * Claude emits the result event before finishing JSONL writes,
         * so the delay gives it time to flush. Cancels any pending timer.
         */
        const scheduleSync = (fn: () => void): void => {
            if (syncTimer) clearTimeout(syncTimer);
            syncTimer = setTimeout(() => {
                syncTimer = null;
                fn();
            }, 1500);
        }

        /**
         * Cancel any pending scheduled sync and run the given callback immediately.
         * Used on process_exit where JSONL writes are guaranteed complete.
         */
        const flushSync = (fn: () => void): void => {
            if (syncTimer) {
                console.debug('DEBUG: Clearing pending sync timer — process_exit takes priority'.cyan);
                clearTimeout(syncTimer);
                syncTimer = null;
            }
            fn();
        }

        /**
         * Persist contextWindowSize + contextTokensUsed from the result event to MongoDB.
         * Called immediately when a result event arrives (before the debounced sync).
         * contextWindowSize is account-level (Pro=200k, Team=10M) — stored per session
         * so historical sessions can display accurate context info.
         */
        const persistResultContext = async (resultEvent: Record<string, unknown>): Promise<void> => {
            if (!activeSessionId) return;

            const usage = resultEvent.usage as Record<string, number> | undefined;
            const modelUsage = resultEvent.modelUsage as Record<string, Record<string, number>> | undefined;
            if (!usage) return;

            const totalInput: number = (usage.input_tokens ?? 0)
                + (usage.cache_creation_input_tokens ?? 0)
                + (usage.cache_read_input_tokens ?? 0);

            // Skip persisting when all tokens are 0 — rejected API call (e.g. "Prompt is too long")
            // would overwrite valid previous context data with zeros
            if (totalInput === 0) return;

            const modelKey: string | undefined = modelUsage ? Object.keys(modelUsage)[0] : undefined;
            const contextWindow: number | undefined = modelKey ? modelUsage?.[modelKey]?.contextWindow : undefined;

            const update: Record<string, number> = {contextTokensUsed: totalInput};
            if (contextWindow) {
                update.contextWindowSize = contextWindow;
            }

            try {
                await SessionModel.findOneAndUpdate(
                    {sessionId: activeSessionId},
                    {$set: update},
                );
                console.log(`WebSocket: Persisted context — sessionId: ${activeSessionId}, tokens: ${totalInput}, contextWindow: ${contextWindow ?? 'unchanged'}`.cyan);
            } catch (error: unknown) {
                console.error(`WebSocket: Failed to persist context — ${error}`.red);
            }
        }

        /** Sync then label the active session as web-UI originated */
        const autoSyncWebUI = async (): Promise<void> => {
            await autoSync();
            if (activeSessionId) {
                await SessionModel.updateOne(
                    {sessionId: activeSessionId},
                    {$set: {source: ESessionSource.WEBUI}},
                );
            }
        }

        webSocket.on('message', async (raw: Buffer) => {
            let clientMessage: ClientMessage;
            try {
                clientMessage = JSON.parse(raw.toString()) as ClientMessage;
            } catch {
                sendError(webSocket, 'Invalid JSON');
                return;
            }

            switch (clientMessage.type) {
                case 'ping': {
                    if (webSocket.readyState === WebSocket.OPEN) {
                        webSocket.send(JSON.stringify({type: 'pong'}));
                    }
                    break;
                }

                case 'new_session':
                case 'resume_session': {
                    if (claudeProcess) {
                        sendError(webSocket, 'Session already active on this connection. Use send_message to continue or close and reconnect!');
                        return;
                    }

                    if (!clientMessage.text || !clientMessage.text.trim()) {
                        sendError(webSocket, 'Message text is required!');
                        return;
                    }

                    if (clientMessage.type === 'resume_session' && !clientMessage.newProjectDir) {
                        console.log(`WebSocket: [TRACE] resume_session — sessionId: ${clientMessage.sessionId}`.cyan);
                        const {session, messages, error} = await SessionService.getSessionBySessionId(clientMessage.sessionId);
                        console.log(`WebSocket: [TRACE] DB fetch — session: ${session ? `found (projectDir: ${session.projectDir}, rawProjectDir: ${session.rawProjectDir})` : 'null'}, messages: ${messages?.length ?? 0}, error: ${error ?? 'none'}`.cyan);

                        if (error || !session) {
                            console.log(`WebSocket: [TRACE] DB error or session not found — falling through to let claude handle it`.cyan);
                        } else {
                            const localAvailable: boolean = isLocalSessionAvailable(session.projectDir, clientMessage.sessionId);
                            if (!localAvailable) {
                                console.log(`WebSocket: [TRACE] Local JSONL unavailable/broken — reconstruction path`.cyan);
                                if (!messages || messages.length === 0) {
                                    sendError(webSocket, `Cannot resume: session ${clientMessage.sessionId} has no messages in MongoDB and local files are missing.`);
                                    break;
                                }
                                console.log(`WebSocket: [TRACE] Messages from MongoDB (${messages.length}):`);
                                messages.forEach((m, i) => {
                                    const contentSummary: string = Array.isArray(m.content)
                                        ? `ContentBlock[${m.content.length}]`
                                        : `string(${String(m.content).length})`;
                                    console.log(`WebSocket: [TRACE]   [${i}] role=${m.role} uuid=${m.uuid} content=${contentSummary}`.cyan);
                                });
                                try {
                                    reconstructAndSaveJsonl(session, messages);
                                } catch (reconstructionError: unknown) {
                                    sendError(webSocket, `Failed to reconstruct session files: ${reconstructionError}`);
                                    break;
                                }

                                try {
                                    await reconstructAndSaveTasks(clientMessage.sessionId);
                                } catch (taskError: unknown) {
                                    console.error(`WebSocket: Failed to reconstruct tasks — ${taskError}`.red);
                                }

                                try {
                                    await reconstructAndSaveMemory(session.projectDir);
                                } catch (memoryError: unknown) {
                                    console.error(`WebSocket: Failed to reconstruct memory files — ${memoryError}`.red);
                                }

                                // Set cwd so claude --resume hashes the correct project dir
                                clientMessage.projectDir = session.rawProjectDir;
                                console.log(`WebSocket: [TRACE] Reconstruction done — cwd set to: ${clientMessage.projectDir}`.cyan);
                            } else {
                                // Set cwd even when local JSONL is valid — claude --resume hashes cwd
                                // to locate the session file, so it must match the original project dir
                                clientMessage.projectDir = session.rawProjectDir;
                                console.log(`WebSocket: [TRACE] Local JSONL valid — skipping reconstruction, cwd set to: ${session.rawProjectDir}`.cyan);
                            }

                            // Repair: strip trailing orphaned tool_use entries from the JSONL.
                            // The Anthropic API returns 400 if an assistant tool_use has no matching tool_result.
                            repairOrphanedToolUse(session.projectDir, clientMessage.sessionId);

                            // Guard: verify rawProjectDir actually exists on disk before spawning.
                            // Without this, spawn('claude', args, {cwd: missing_dir}) crashes with ENOENT.
                            if (!fs.existsSync(clientMessage.projectDir!)) {
                                console.warn(`WebSocket: [TRACE] projectDir does not exist on disk: ${clientMessage.projectDir}`.yellow);
                                if (webSocket.readyState === WebSocket.OPEN) {
                                    const projectNotAvailable: IProjectNotAvailableMessage = {
                                        type: 'project_not_available',
                                        sessionId: clientMessage.sessionId,
                                        projectDir: clientMessage.projectDir!,
                                        warning: `Project directory "${clientMessage.projectDir}" does not exist on this machine. The session cannot be resumed here.`,
                                        session: session as unknown as Record<string, unknown>,
                                        messages: (messages ?? []) as unknown as Record<string, unknown>[],
                                    };
                                    webSocket.send(JSON.stringify(projectNotAvailable));
                                }
                                break;
                            }
                        }
                        // MongoDB error or session not in DB — fall through and let claude handle it
                    }

                    const spawnMessage: INewSessionMessage | IResumeSessionMessage = (clientMessage.type === 'resume_session' && clientMessage.newProjectDir)
                        ? ({type: 'new_session', text: clientMessage.text, projectDir: clientMessage.newProjectDir} as INewSessionMessage)
                        : clientMessage;

                    console.log(`WebSocket: [TRACE] Spawning claude — type: ${spawnMessage.type}, cwd: ${spawnMessage.projectDir ?? 'undefined (inherits server cwd)'}`.cyan);
                    claudeProcess = spawnClaude(spawnMessage, webSocket, (resultEvent: Record<string, unknown>) => {
                        // Persist context immediately for existing sessions (resume).
                        // Also persist AFTER sync for new sessions (sync creates the session first).
                        // Both calls are safe: zero-guard skips rejected results, $set is idempotent.
                        persistResultContext(resultEvent);
                        scheduleSync(async (): Promise<void> => {
                            await autoSyncWebUI();
                            await persistResultContext(resultEvent);
                        });
                    }, onSystemEvent);

                    claudeProcess.on('exit', (code: number | null) => {
                        console.log(`WebSocket: claude process exited with code ${code}`.cyan);

                        if (webSocket.readyState === WebSocket.OPEN) {
                            webSocket.send(JSON.stringify({type: 'process_exit', code}));
                        }

                        // Flush: cancel any pending result-event sync and run immediately.
                        // On exit all JSONL writes are guaranteed complete — this is the
                        // authoritative sync that captures the final state.
                        flushSync(autoSyncWebUI);

                        claudeProcess = null;
                    });

                    claudeProcess.on('error', (error: Error) => {
                        console.error(`WebSocket: claude process error — ${error.message}`.red);
                        sendError(webSocket, `Failed to spawn claude: ${error.message}`);
                        claudeProcess = null;
                    });
                    break;
                }

                case 'edit_session': {
                    // Kill existing claude process if active (live chat edit scenario)
                    if (claudeProcess) {
                        console.log('WebSocket: edit_session — killing active claude process before forking'.yellow);
                        killClaudeProcess(claudeProcess);
                        claudeProcess = null;
                    }

                    const editMsg: IEditSessionMessage = clientMessage as IEditSessionMessage;

                    if (!editMsg.text || !editMsg.text.trim()) {
                        sendError(webSocket, 'Message text is required!');
                        return;
                    }

                    if (!editMsg.sessionId) {
                        sendError(webSocket, 'sessionId is required for edit_session!');
                        return;
                    }

                    // Fetch parent session + full message history from MongoDB
                    const {session: parentSession, messages: rawMessages, error: sessionError} = await SessionService.getSessionBySessionId(editMsg.sessionId);
                    if (sessionError || !parentSession) {
                        sendError(webSocket, `Session not found: ${editMsg.sessionId}`);
                        break;
                    }

                    const oldSessionId: string = editMsg.sessionId;
                    const oldTitle: string = parentSession.title;
                    let newSessionId: string | null = null;
                    let parentSessionIdSet: boolean = false;

                    // Capture new session_id from the system event + register for tool approval
                    const captureSessionId = (event: Record<string, unknown>): void => {
                        if (event.type === 'system') {
                            newSessionId = event.session_id as string;
                            activeSessionId = newSessionId;
                            registerSession(activeSessionId, webSocket);
                            console.log(`WebSocket: edit_session — new session_id captured: ${newSessionId}`.cyan);
                        }
                    };

                    // After each sync: set parentSessionId + inherit title on the new session
                    const afterEditSync = async (): Promise<void> => {
                        await autoSyncWebUI();
                        if (newSessionId && !parentSessionIdSet) {
                            parentSessionIdSet = true;
                            try {
                                const updated = await SessionModel.findOneAndUpdate(
                                    {sessionId: newSessionId},
                                    {$set: {parentSessionId: oldSessionId, title: oldTitle}},
                                );
                                if (!updated) {
                                    // Race condition: session not yet synced — retry after 2 seconds
                                    setTimeout(async () => {
                                        await SessionModel.findOneAndUpdate(
                                            {sessionId: newSessionId!},
                                            {$set: {parentSessionId: oldSessionId, title: oldTitle}},
                                        );
                                    }, 2000);
                                }
                                console.log(`WebSocket: edit_session — set parentSessionId=${oldSessionId} on ${newSessionId}`.cyan);
                            } catch (err: unknown) {
                                console.error(`WebSocket: edit_session — failed to set parentSessionId: ${err}`.red);
                            }
                        }
                    }

                    // Build context: apply getActiveBranch then slice at editAtUuid (or take all for regenerate)
                    const activeMessages: IMessage[] = getActiveBranch(rawMessages || []);
                    let contextMessages: IMessage[];
                    if (editMsg.editAtUuid) {
                        const cutIndex: number = activeMessages.findIndex((m: IMessage) => m.uuid === editMsg.editAtUuid);
                        contextMessages = cutIndex >= 0 ? activeMessages.slice(0, cutIndex + 1) : activeMessages;
                        console.log(`WebSocket: edit_session — edit mode, cutIndex: ${cutIndex}, contextMessages: ${contextMessages.length}`.cyan);
                    } else {
                        contextMessages = activeMessages;
                        console.log(`WebSocket: edit_session — regenerate mode, contextMessages: ${contextMessages.length}`.cyan);
                    }

                    const contextNdjson: string | undefined = contextMessages.length > 0 ? toContextNdjson(contextMessages) : undefined;
                    const contextUserCount: number = contextMessages.filter((m: IMessage) => m.role === 'user').length;
                    const spawnMsg: INewSessionMessage = {
                        type: 'new_session',
                        text: editMsg.text,
                        projectDir: editMsg.projectDir || parentSession.rawProjectDir,
                    };

                    console.log(`WebSocket: edit_session — spawning fresh session (cwd: ${spawnMsg.projectDir}, contextUserCount: ${contextUserCount})`.cyan);
                    claudeProcess = spawnClaude(spawnMsg, webSocket, (resultEvent: Record<string, unknown>) => {
                        persistResultContext(resultEvent);
                        scheduleSync(async (): Promise<void> => {
                            await afterEditSync();
                            await persistResultContext(resultEvent);
                        });
                    }, captureSessionId, contextNdjson, contextUserCount);

                    claudeProcess.on('exit', (code: number | null) => {
                        console.log(`WebSocket: edit_session claude process exited with code ${code}`.cyan);
                        if (webSocket.readyState === WebSocket.OPEN) {
                            webSocket.send(JSON.stringify({type: 'process_exit', code}));
                        }
                        flushSync(afterEditSync);
                        claudeProcess = null;
                    });

                    claudeProcess.on('error', (error: Error) => {
                        console.error(`WebSocket: edit_session claude process error — ${error.message}`.red);
                        sendError(webSocket, `Failed to spawn claude: ${error.message}`);
                        claudeProcess = null;
                    });
                    break;
                }

                case 'send_message': {
                    if (!claudeProcess) {
                        sendError(webSocket, 'No active session. Send new_session or resume_session first!');
                        return;
                    }

                    if (!clientMessage.text || !clientMessage.text.trim()) {
                        sendError(webSocket, 'Message text is required!');
                        return;
                    }

                    console.log('WebSocket: Sending follow-up message to existing claude process'.cyan);
                    sendMessage(claudeProcess, clientMessage.text);
                    break;
                }

                case 'stop_execution': {
                    if (!claudeProcess) {
                        sendError(webSocket, 'No active session to stop!');
                        break;
                    }
                    console.log('WebSocket: Received stop_execution — killing claude process (SIGTERM → SIGKILL)'.yellow);
                    killClaudeProcess(claudeProcess);
                    if (webSocket.readyState === WebSocket.OPEN) {
                        webSocket.send(JSON.stringify({type: 'session_stopped'}));
                    }
                    break;
                }

                case 'tool_approval_response': {
                    const approvalMsg: IToolApprovalResponseMessage = clientMessage as IToolApprovalResponseMessage;
                    console.log(`WebSocket: Received tool_approval_response (requestId: ${approvalMsg.requestId}, decision: ${approvalMsg.decision})`.cyan);
                    const resolved: boolean = resolveApproval(approvalMsg.requestId, {
                        permissionDecision: approvalMsg.decision,
                        permissionDecisionReason: approvalMsg.reason,
                    });
                    if (!resolved) {
                        console.warn(`WebSocket: No pending approval found for requestId: ${approvalMsg.requestId}`.yellow);
                    }
                    break;
                }

                default: {
                    sendError(webSocket, `Unknown message type: ${(clientMessage as any).type}`);
                }
            }
        });

        webSocket.on('close', () => {
            console.log('WebSocket: Client disconnected'.yellow);
            if (activeSessionId) {
                cleanupSession(activeSessionId);
                activeSessionId = null;
            }
            if (claudeProcess) {
                console.log('WebSocket: Killing claude process (SIGTERM → SIGKILL)'.yellow);
                killClaudeProcess(claudeProcess);
                claudeProcess = null;
            }
        });

        webSocket.on('error', (error: Error) => {
            console.error(`WebSocket: Connection error — ${error.message}`.red);
        });
    });

    console.log('WebSocket: WebSocketServer attached at /ws'.green.bold);

    return webSocketServer;
}

/**
 * Send an error message to the client
 */
function sendError(webSocket: WebSocket, message: string): void {
    if (webSocket.readyState === WebSocket.OPEN) {
        webSocket.send(JSON.stringify({type: 'error', message}));
    }
}

/**
 * Trigger a full sync after each completed turn (result event).
 * Runs in the background — does not block the WebSocket connection.
 */
async function autoSync(): Promise<void> {
    try {
        console.log('WebSocket: Auto-syncing conversation to MongoDB...'.cyan);
        const result = await SyncService.sync({});
        console.log('WebSocket: Auto-sync complete'.green, result);
    } catch (error: unknown) {
        console.error(`WebSocket: Auto-sync failed — ${error}`.red);
    }
}

export {attachWebSocket};
