import "colors";
import fs from "fs";
import path from "path";
import {IPty} from "node-pty";
import {ChildProcess} from "child_process";
import {WebSocket, WebSocketServer} from "ws";
import {IncomingMessage, Server as HttpServer} from "http";
import {IMessage} from "../models/Message";
import {ISession} from "../models/Session";
import {spawnCommand} from "./commandSpawner";
import SyncService from "../services/SyncService";
import SessionService from "../services/SessionService";
import {sendMessage, spawnClaude} from "./claudeSpawner";
import {NON_ALPHANUMERIC_REGEX} from "../utils/constants";
import {ClientMessage, INewSessionMessage, IResumeSessionMessage} from "../types/ws";

/**
 * Check if the local JSONL session file exists for the given projectDir + sessionId.
 * Claude stores sessions at ~/.claude/projects/{projectDirHash}/{sessionId}.jsonl
 * where projectDirHash replaces all non-alphanumeric chars with '-'.
 */
function isLocalSessionAvailable(projectDir: string, sessionId: string): boolean {
    const claudeProjectsDir: string = path.join(process.env.HOME || '~', '.claude', 'projects');
    const projectDirHash: string = projectDir.replace(NON_ALPHANUMERIC_REGEX, '-');
    const jsonlPath: string = path.join(claudeProjectsDir, projectDirHash, `${sessionId}.jsonl`);
    return fs.existsSync(jsonlPath);
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

    const lines: string[] = messages.map((message) => JSON.stringify({
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

    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n', 'utf-8');
    console.log(`WebSocket: Reconstructed session JSONL at ${jsonlPath} (${lines.length} messages)`.cyan);
}

/**
 * Attach a WebSocketServer to the given HTTP server at path /ws.
 * Handles message routing, claude process lifecycle, and auto-sync.
 * No auth needed — both servers always run locally on the same Mac inside the .app bundle.
 *
 * Protocol:
 *   new_session / resume_session  → spawns a persistent claude process, sends first message
 *   send_message                  → writes follow-up message to the same process stdin (no re-spawn)
 *   run_command                   → spawns a separate PTY for a slash command, streams output back
 *   command_input                 → forwards raw keystrokes to the running PTY (interactive TUI support)
 *   ping                          → pong
 *   WS close                      → kills the process and any active PTY, triggers auto-sync
 */
function attachWebSocket(httpServer: HttpServer): WebSocketServer {
    const webSocketServer: WebSocketServer = new WebSocketServer({server: httpServer, path: '/ws'});

    webSocketServer.on('connection', (webSocket: WebSocket, _req: IncomingMessage) => {
        console.log('WebSocket: Client connected'.green.bold);

        let claudeProcess: ChildProcess | null = null;
        let commandPty: IPty | null = null;

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
                        const {session, messages, error} = await SessionService.getSessionBySessionId(clientMessage.sessionId);

                        if (!error && session && !isLocalSessionAvailable(session.projectDir, clientMessage.sessionId)) {
                            if (!messages || messages.length === 0) {
                                sendError(webSocket, `Cannot resume: session ${clientMessage.sessionId} has no messages in MongoDB and local files are missing.`);
                                break;
                            }
                            try {
                                reconstructAndSaveJsonl(session, messages);
                            } catch (reconstructionError: unknown) {
                                sendError(webSocket, `Failed to reconstruct session files: ${reconstructionError}`);
                                break;
                            }
                            // Set cwd so claude --resume hashes the correct project dir
                            clientMessage.projectDir = session.rawProjectDir;
                            // JSONL reconstructed — fall through to spawn with --resume as normal
                        }
                        // MongoDB error or session not in DB — fall through and let claude handle it
                    }

                    const spawnMessage: INewSessionMessage | IResumeSessionMessage = (clientMessage.type === 'resume_session' && clientMessage.newProjectDir)
                        ? ({type: 'new_session', text: clientMessage.text, projectDir: clientMessage.newProjectDir} as INewSessionMessage)
                        : clientMessage;

                    claudeProcess = spawnClaude(spawnMessage, webSocket, autoSync);

                    claudeProcess.on('exit', (code: number | null) => {
                        console.log(`WebSocket: claude process exited with code ${code}`.cyan);

                        if (webSocket.readyState === WebSocket.OPEN) {
                            webSocket.send(JSON.stringify({type: 'process_exit', code}));
                        }

                        claudeProcess = null;
                    });

                    claudeProcess.on('error', (error: Error) => {
                        console.error(`WebSocket: claude process error — ${error.message}`.red);
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

                case 'run_command': {
                    if (commandPty) {
                        sendError(webSocket, 'A command is already running. Wait for it to finish or close and reconnect!');
                        return;
                    }

                    if (!clientMessage.command || !clientMessage.command.trim()) {
                        sendError(webSocket, 'Command is required!');
                        return;
                    }

                    console.log(`WebSocket: Running command "${clientMessage.command}"`.cyan);
                    commandPty = spawnCommand(clientMessage.command, clientMessage.projectDir, webSocket);

                    commandPty.onExit(() => {
                        commandPty = null;
                    });
                    break;
                }

                case 'command_input': {
                    if (!commandPty) {
                        sendError(webSocket, 'No active command PTY. Send run_command first!');
                        return;
                    }

                    commandPty.write(clientMessage.data);
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
            if (commandPty) {
                console.log('WebSocket: Killing command PTY'.yellow);
                commandPty.kill();
                commandPty = null;
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
