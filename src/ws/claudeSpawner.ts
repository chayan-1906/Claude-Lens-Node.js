import "colors";
import {WebSocket} from "ws";
import {ChildProcess, spawn} from "child_process";
import {INewSessionMessage, IResumeSessionMessage} from "../types/ws";

/**
 * Build the argument list for spawning the claude CLI.
 * Flags: -p --verbose --output-format stream-json --input-format stream-json
 * --input-format stream-json keeps stdin open so follow-up messages can be
 * written as NDJSON lines without spawning a new process per message.
 */
function buildArgs(message: INewSessionMessage | IResumeSessionMessage): string[] {
    const args: string[] = [
        '-p',
        '--verbose',
        '--output-format', 'stream-json',
        '--input-format', 'stream-json',
    ];

    if (message.type === 'resume_session') {
        args.push('--resume', message.sessionId);
    }

    console.debug('args:'.cyan, args);
    return args;
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
    claudeProcess.stdin!.write(toNdjson(text));
}

/**
 * Spawn the claude CLI as a persistent process, send the first message via stdin,
 * and stream stdout lines to the WebSocket.
 * stdin is kept open — call sendMessage() for follow-up turns.
 * onResult is called after each completed turn (result event) for per-turn auto-sync.
 * Returns the spawned ChildProcess so the caller can manage its lifecycle.
 */
function spawnClaude(message: INewSessionMessage | IResumeSessionMessage, webSocket: WebSocket, onResult: () => void): ChildProcess {
    const args: string[] = buildArgs(message);
    console.log(`WebSocket: Spawning claude ${args.join(' ')}`.cyan);

    const claudeProcess: ChildProcess = spawn('claude', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: message.projectDir || undefined,
    });

    // Send the first user message as NDJSON — stdin stays open for follow-ups
    sendMessage(claudeProcess, message.text);

    // Line-buffered stdout → parse JSON lines → forward to WebSocket
    let buffer: string = '';
    claudeProcess.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines: string[] = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const event: Record<string, unknown> = JSON.parse(line);
                if (webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(JSON.stringify(event));
                }
                if (event.type === 'result') {
                    onResult();
                }
            } catch {
                // Skip non-JSON lines (e.g. claude startup text)
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

export {spawnClaude, sendMessage};
