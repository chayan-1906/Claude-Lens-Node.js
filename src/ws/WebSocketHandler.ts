import "colors";
import {ChildProcess} from "child_process";
import {WebSocket, WebSocketServer} from "ws";
import {IncomingMessage, Server as HttpServer} from "http";
import {ClientMessage} from "../types/ws";
import SyncService from "../services/SyncService";
import {spawnClaude, sendMessage} from "./claudeSpawner";

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

        webSocket.on('message', (raw: Buffer) => {
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

                    claudeProcess = spawnClaude(clientMessage, webSocket);

                    claudeProcess.on('exit', (code: number | null) => {
                        console.log(`WebSocket: claude process exited with code ${code}`.cyan);

                        if (webSocket.readyState === WebSocket.OPEN) {
                            webSocket.send(JSON.stringify({type: 'process_exit', code}));
                        }

                        claudeProcess = null;

                        // Auto-sync conversation to MongoDB after process exits
                        autoSync();
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
 * Trigger a full sync after a claude process exits.
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