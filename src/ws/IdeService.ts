import "colors";
import fs from "fs";
import path from "path";
import {WebSocket} from "ws";
import {IdeEventCallback, IIdeLockFile, IIdeLockFileJson, IPendingCall} from "../types/ide";

const CALL_TIMEOUT_MS: number = 10_000;
const CONNECT_TIMEOUT_MS: number = 5_000;

/**
 * MCP client for the JetBrains Claude Code plugin.
 * Reads ~/.claude/ide/*.lock to discover the IDE WebSocket port + auth token,
 * connects with the `mcp` subprotocol and `X-Claude-Code-Ide-Authorization` header,
 * performs the MCP initialize handshake, responds to pings, forwards
 * selection_changed notifications, and exposes typed tool-call helpers.
 */
class IdeService {
    private ws: WebSocket | null = null;
    private port: number | null = null;
    private ideName: string | null = null;
    private nextId: number = 1;
    private pendingCalls: Map<number, IPendingCall> = new Map();
    private connected: boolean = false;
    private readonly onEvent: IdeEventCallback;

    constructor(onEvent: IdeEventCallback) {
        this.onEvent = onEvent;
    }

    get isConnected(): boolean {
        return this.connected;
    }

    // ─── Lock file ────────────────────────────────────────────────────────────

    /**
     * Scan ~/.claude/ide/ for .lock files, return the most recently modified one.
     * Returns null when the IDE is not running or the plugin is not installed.
     */
    private findLockFile(): IIdeLockFile | null {
        const ideDir: string = path.join(process.env.HOME || '~', '.claude', 'ide');
        if (!fs.existsSync(ideDir)) return null;

        const files: string[] = fs.readdirSync(ideDir).filter((f: string) => f.endsWith('.lock'));
        if (files.length === 0) return null;

        const sorted: string[] = files.sort((a: string, b: string) => {
            const aStat = fs.statSync(path.join(ideDir, a));
            const bStat = fs.statSync(path.join(ideDir, b));
            return bStat.mtimeMs - aStat.mtimeMs;
        });

        try {
            const raw: string = fs.readFileSync(path.join(ideDir, sorted[0]), 'utf-8');
            const json: IIdeLockFileJson = JSON.parse(raw) as IIdeLockFileJson;

            // Port is encoded in the filename (e.g., "51735.lock") — NOT in the JSON
            const port: number = parseInt(path.basename(sorted[0], '.lock'), 10);
            if (isNaN(port) || port <= 0) return null;

            return {port, authToken: json.authToken, ideName: json.ideName};
        } catch {
            return null;
        }
    }

    // ─── Connection ───────────────────────────────────────────────────────────

    /**
     * Connect to the IDE WebSocket server, perform the MCP handshake, and
     * resolve once the connection is established.
     * Throws if no lock file is found, connection times out, or handshake fails.
     */
    async connect(): Promise<void> {
        if (this.connected) return;

        const lockFile: IIdeLockFile | null = this.findLockFile();
        if (!lockFile) {
            throw new Error('No IDE lock file found — is IntelliJ running with the Claude Code plugin?');
        }

        this.port = lockFile.port;
        this.ideName = lockFile.ideName;

        return new Promise<void>((resolve, reject) => {
            let handshakeDone: boolean = false;

            const ws: WebSocket = new WebSocket(`ws://localhost:${this.port}`, ['mcp'], {
                headers: {'X-Claude-Code-Ide-Authorization': lockFile.authToken},
            });

            const connectTimeout: ReturnType<typeof setTimeout> = setTimeout(() => {
                if (!handshakeDone) {
                    ws.terminate();
                    reject(new Error(`IdeService: Connection to ${this.ideName} timed out after ${CONNECT_TIMEOUT_MS / 1000}s`));
                }
            }, CONNECT_TIMEOUT_MS);

            ws.on('open', () => {
                console.log(`IdeService: WebSocket open — sending MCP initialize to ${this.ideName}:${this.port}`.cyan);
                this.ws = ws;
                const initId: number = this.nextId++;
                this.sendRaw({
                    jsonrpc: '2.0',
                    id: initId,
                    method: 'initialize',
                    params: {
                        protocolVersion: '2024-11-05',
                        capabilities: {},
                        clientInfo: {name: 'claude-lens', version: '1.0.0'},
                    },
                });

                // Resolve once we receive the initialize response
                const initPendingCall: IPendingCall = {
                    resolve: (_result: unknown) => {
                        clearTimeout(connectTimeout);
                        handshakeDone = true;
                        this.connected = true;
                        // Send notifications/initialized to complete the handshake
                        this.sendRaw({jsonrpc: '2.0', method: 'notifications/initialized'});
                        console.log(`IdeService: Connected to ${this.ideName} on port ${this.port}`.green.bold);
                        this.onEvent({type: 'ide_connected', ideName: this.ideName, port: this.port});
                        resolve();

                        // Fetch and log available tools (non-blocking — just for debugging)
                        this.listTools().then((tools: unknown) => {
                            console.log(`IdeService: [tools/list] ${JSON.stringify(tools, null, 2)}`.cyan);
                        }).catch((err: unknown) => {
                            console.warn(`IdeService: [tools/list] failed — ${err}`.yellow);
                        });
                    },
                    reject: (err: Error) => {
                        clearTimeout(connectTimeout);
                        reject(err);
                    },
                    timeout: setTimeout(() => {/* handled by connectTimeout */}, CONNECT_TIMEOUT_MS),
                };
                this.pendingCalls.set(initId, initPendingCall);
            });

            ws.on('message', (data: Buffer) => {
                try {
                    const msg: Record<string, unknown> = JSON.parse(data.toString());
                    this.handleMessage(msg);
                } catch {
                    console.warn('IdeService: Received non-JSON message — ignoring'.yellow);
                }
            });

            ws.on('error', (err: Error) => {
                if (!handshakeDone) {
                    clearTimeout(connectTimeout);
                    reject(new Error(`IdeService: WebSocket error — ${err.message}`));
                } else {
                    console.error(`IdeService: WebSocket error — ${err.message}`.red);
                    this.handleDisconnect(err.message);
                }
            });

            ws.on('close', () => {
                if (!handshakeDone) {
                    clearTimeout(connectTimeout);
                    reject(new Error('IdeService: WebSocket closed before MCP handshake completed'));
                } else {
                    this.handleDisconnect('Connection closed by IDE');
                }
            });
        });
    }

    disconnect(): void {
        this.connected = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    // ─── Message handling ─────────────────────────────────────────────────────

    private handleMessage(msg: Record<string, unknown>): void {
        // Ping — respond immediately or the IDE will close the connection
        if (msg.method === 'ping') {
            this.sendRaw({jsonrpc: '2.0', id: msg.id, result: {}});
            return;
        }

        // selection_changed notification — forward to WebSocketHandler as ide_selection_changed
        if (msg.method === 'selection_changed') {
            const params = (msg.params as Record<string, unknown>) ?? {};
            const filePath: string = (params.path as string) ?? '';
            this.onEvent({
                type: 'ide_selection_changed',
                filePath,
                fileName: path.basename(filePath),
                lineNumber: (params.lineNumber as number) ?? 0,
            });
            return;
        }

        // Log all non-ping messages for debugging
        console.log(`IdeService: [RECV] ${JSON.stringify(msg).slice(0, 500)}`.gray);

        // JSON-RPC response to a pending call
        const id: number | undefined = msg.id as number | undefined;
        if (id !== undefined) {
            const pending: IPendingCall | undefined = this.pendingCalls.get(id);
            if (pending) {
                clearTimeout(pending.timeout);
                this.pendingCalls.delete(id);
                if (msg.error) {
                    const err = msg.error as Record<string, unknown>;
                    console.warn(`IdeService: [RESPONSE id=${id}] ERROR — ${JSON.stringify(err)}`.yellow);
                    pending.reject(new Error(String(err.message ?? 'Unknown MCP error')));
                } else {
                    console.log(`IdeService: [RESPONSE id=${id}] OK — ${JSON.stringify(msg.result).slice(0, 300)}`.green);
                    pending.resolve(msg.result ?? null);
                }
            } else {
                console.log(`IdeService: [RESPONSE id=${id}] No pending call found (already resolved/timed out?)`.yellow);
            }
        }
    }

    private handleDisconnect(reason: string): void {
        if (!this.connected) return;
        this.connected = false;
        this.ws = null;
        // Reject all in-flight calls
        for (const [, pending] of this.pendingCalls.entries()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('IdeService: IDE disconnected'));
        }
        this.pendingCalls.clear();
        console.log(`IdeService: Disconnected — ${reason}`.yellow);
        this.onEvent({type: 'ide_disconnected', reason});
    }

    // ─── Low-level transport ──────────────────────────────────────────────────

    private sendRaw(msg: Record<string, unknown>): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            const payload: string = JSON.stringify(msg);
            // Log non-ping outgoing messages
            if ((msg.result as Record<string, unknown>) === undefined || msg.method !== undefined) {
                console.log(`IdeService: [SEND] ${payload.slice(0, 500)}`.gray);
            }
            this.ws.send(payload);
        } else {
            console.warn(`IdeService: [SEND] Cannot send — WebSocket not open (readyState: ${this.ws?.readyState})`.yellow);
        }
    }

    // ─── MCP tool call ────────────────────────────────────────────────────────

    /**
     * Call any IntelliJ MCP tool by name with the given arguments.
     * Returns the tool result or throws on error / timeout.
     */
    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        if (!this.connected || !this.ws) {
            throw new Error('IdeService: Not connected to IDE');
        }
        const id: number = this.nextId++;
        return new Promise<unknown>((resolve, reject) => {
            const timeout: ReturnType<typeof setTimeout> = setTimeout(() => {
                this.pendingCalls.delete(id);
                reject(new Error(`IdeService: Tool call '${name}' timed out after ${CALL_TIMEOUT_MS / 1000}s`));
            }, CALL_TIMEOUT_MS);

            this.pendingCalls.set(id, {resolve, reject, timeout});
            this.sendRaw({jsonrpc: '2.0', id, method: 'tools/call', params: {name, arguments: args}});
            console.log(`IdeService: Calling tool '${name}' (id: ${id})`.cyan);
        });
    }

    // ─── Typed tool helpers ───────────────────────────────────────────────────

    /**
     * Fetch the list of available tools from the IDE.
     * Called once after connection to verify tool names and parameter schemas.
     */
    async listTools(): Promise<unknown> {
        if (!this.connected || !this.ws) {
            throw new Error('IdeService: Not connected to IDE');
        }
        const id: number = this.nextId++;
        return new Promise<unknown>((resolve, reject) => {
            const timeout: ReturnType<typeof setTimeout> = setTimeout(() => {
                this.pendingCalls.delete(id);
                reject(new Error('IdeService: tools/list timed out'));
            }, CALL_TIMEOUT_MS);
            this.pendingCalls.set(id, {resolve, reject, timeout});
            this.sendRaw({jsonrpc: '2.0', id, method: 'tools/list'});
        });
    }

    /**
     * Open a diff in the IDE (fire-and-forget).
     * IntelliJ reads old content from old_file_path on disk — no need to pass it.
     * For new files, IntelliJ shows an empty left side.
     *
     * Fire-and-forget because IntelliJ's openDiff blocks until the user clicks
     * Apply/Reject in the IDE. Actual approval happens via the web UI buttons,
     * not through IntelliJ — the diff is shown for review/viewing only.
     */
    openDiff(filePath: string, newContent: string, tabName?: string): void {
        if (!this.connected || !this.ws) return;
        const args: Record<string, unknown> = {
            old_file_path: filePath,
            new_file_path: filePath,
            new_file_contents: newContent,
            tab_name: tabName ?? path.basename(filePath),
        };
        const id: number = this.nextId++;
        console.log(`IdeService: openDiff → path: ${filePath}, newContent length: ${newContent.length}, tab: ${args.tab_name} (fire-and-forget, id: ${id})`.cyan);
        this.sendRaw({jsonrpc: '2.0', id, method: 'tools/call', params: {name: 'openDiff', arguments: args}});
    }

    /** Close a diff/editor tab in the IDE (fire-and-forget). Accepts tab_name from openDiff or absolute path. */
    closeTab(tabName: string): void {
        if (!this.connected || !this.ws) return;
        const id: number = this.nextId++;
        console.log(`IdeService: closeTab → tab_name: ${tabName} (fire-and-forget, id: ${id})`.cyan);
        this.sendRaw({jsonrpc: '2.0', id, method: 'tools/call', params: {name: 'close_tab', arguments: {tab_name: tabName}}});
    }

    /** Open a file in the IDE, optionally scrolling to a line */
    async openFile(filePath: string, lineNumber?: number): Promise<void> {
        const args: Record<string, unknown> = {filePath};
        if (lineNumber !== undefined) args.lineNumber = lineNumber;
        await this.callTool('openFile', args);
    }

    /** Get all diagnostics (errors/warnings) from the IDE */
    async getDiagnostics(): Promise<unknown> {
        return this.callTool('getDiagnostics', {});
    }

    /** Get paths of all currently open files in the IDE */
    async getOpenFiles(): Promise<unknown> {
        return this.callTool('get_all_opened_file_paths', {});
    }
}

export {IdeService};
