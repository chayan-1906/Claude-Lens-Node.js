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
import SessionModel, {ISession} from "../models/Session";
import {NON_ALPHANUMERIC_REGEX} from "../utils/constants";
import {sendMessage, spawnClaude, toContextNdjson} from "./claudeSpawner";
import {ClientMessage, IEditSessionMessage, INewSessionMessage, IResumeSessionMessage} from "../types/ws";

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
    // Return false so the caller falls back to reconstructing from MongoDB.
    try {
        const lines: string[] = fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean);
        console.log(`WebSocket: [TRACE] isLocalSessionAvailable — file found, validating ${lines.length} lines`.cyan);
        for (const line of lines) {
            const entry = JSON.parse(line) as Record<string, unknown>;
            if (entry.type === 'user' || entry.type === 'assistant') {
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
    } catch (err) {
        console.error(`WebSocket: [TRACE] isLocalSessionAvailable — parse error: ${err} → false`.red);
        return false;
    }

    console.log(`WebSocket: [TRACE] isLocalSessionAvailable — VALID → true`.cyan);
    return true;
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

    const lines: string[] = messages
        .filter((message) => {
            const content = message.content;
            if (Array.isArray(content) && content.length === 0) {
                console.warn(`WebSocket: Skipping ${message.role} message (uuid: ${message.uuid}) — empty content array`.yellow);
                return false;
            }
            return true;
        })
        .map((message) => JSON.stringify({
            type: message.role,
            uuid: message.uuid,
            sessionId: session.sessionId,
            timestamp: (message.timestamp as Date).toISOString(),
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

/**
 * Reconstruct MEMORY.md from MongoDB and write it to
 * ~/.claude/projects/{projectDir}/memory/MEMORY.md.
 * Skips if the file already exists on disk.
 * Returns true if the file was restored.
 */
async function reconstructAndSaveMemory(projectDir: string): Promise<boolean> {
    const claudeProjectsDir: string = path.join(process.env.HOME || '~', '.claude', 'projects');
    const memoryFilePath: string = path.join(claudeProjectsDir, projectDir, 'memory', 'MEMORY.md');

    // Skip if MEMORY.md already exists on disk
    if (fs.existsSync(memoryFilePath)) {
        return false;
    }

    const memory = await MemoryModel.findOne({projectDir});
    if (!memory) {
        return false;
    }

    fs.mkdirSync(path.dirname(memoryFilePath), {recursive: true});
    fs.writeFileSync(memoryFilePath, memory.content, 'utf-8');

    console.log(`WebSocket: Reconstructed MEMORY.md at ${memoryFilePath}`.cyan);
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
                                    console.error(`WebSocket: Failed to reconstruct MEMORY.md — ${memoryError}`.red);
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
                        }
                        // MongoDB error or session not in DB — fall through and let claude handle it
                    }

                    const spawnMessage: INewSessionMessage | IResumeSessionMessage = (clientMessage.type === 'resume_session' && clientMessage.newProjectDir)
                        ? ({type: 'new_session', text: clientMessage.text, projectDir: clientMessage.newProjectDir} as INewSessionMessage)
                        : clientMessage;

                    console.log(`WebSocket: [TRACE] Spawning claude — type: ${spawnMessage.type}, cwd: ${spawnMessage.projectDir ?? 'undefined (inherits server cwd)'}`.cyan);
                    claudeProcess = spawnClaude(spawnMessage, webSocket, autoSync);

                    claudeProcess.on('exit', (code: number | null) => {
                        console.log(`WebSocket: claude process exited with code ${code}`.cyan);

                        if (webSocket.readyState === WebSocket.OPEN) {
                            webSocket.send(JSON.stringify({type: 'process_exit', code}));
                        }

                        // Sync on exit guarantees all JSONL writes are complete.
                        // The per-turn result-event sync may fire before claude finishes
                        // writing assistant messages to the JSONL file, so this is the
                        // authoritative sync that captures the final state.
                        autoSync();

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
                        claudeProcess.kill('SIGTERM');
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

                    // Capture new session_id from the system event
                    const captureSessionId = (event: Record<string, unknown>): void => {
                        if (event.type === 'system') {
                            newSessionId = event.session_id as string;
                            console.log(`WebSocket: edit_session — new session_id captured: ${newSessionId}`.cyan);
                        }
                    };

                    // After each sync: set parentSessionId + inherit title on the new session
                    const afterEditSync = async (): Promise<void> => {
                        await autoSync();
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
                    };

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
                    claudeProcess = spawnClaude(spawnMsg, webSocket, afterEditSync, captureSessionId, contextNdjson, contextUserCount);

                    claudeProcess.on('exit', (code: number | null) => {
                        console.log(`WebSocket: edit_session claude process exited with code ${code}`.cyan);
                        if (webSocket.readyState === WebSocket.OPEN) {
                            webSocket.send(JSON.stringify({type: 'process_exit', code}));
                        }
                        afterEditSync();
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

                default: {
                    sendError(webSocket, `Unknown message type: ${(clientMessage as any).type}`);
                }
            }
        });

        webSocket.on('close', () => {
            console.log('WebSocket: Client disconnected'.yellow);
            if (claudeProcess) {
                console.log('WebSocket: Killing claude process (SIGTERM)'.yellow);
                claudeProcess.kill('SIGTERM');
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
