import "colors";
import {WebSocket} from "ws";
import {spawn, ChildProcess} from "child_process";
import {INewSessionMessage, IResumeSessionMessage} from "../types/ws";

/**
 * Build the argument list for spawning the claude CLI.
 * Common flags: -p --verbose --output-format stream-json
 */
function buildArgs(message: INewSessionMessage | IResumeSessionMessage): string[] {
    const args: string[] = ['-p', '--verbose', '--output-format', 'stream-json'];

    if (message.type === 'resume_session') {
        args.push('--resume', message.sessionId);
    } else if (message.projectDir) {
        args.push('--project-dir', message.projectDir);
    }

    return args;
}

/**
 * Spawn the claude CLI process, pipe stdin, and stream stdout lines to the WebSocket.
 * Returns the spawned ChildProcess so the caller can manage its lifecycle.
 */
function spawnClaude(message: INewSessionMessage | IResumeSessionMessage, webSocket: WebSocket): ChildProcess {
    const args: string[] = buildArgs(message);
    console.log(`WebSocket: Spawning claude ${args.join(' ')}`.cyan);

    const process: ChildProcess = spawn('claude', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Send the user prompt via stdin then close it
    process.stdin!.write(message.text + '\n');
    process.stdin!.end();

    // Line-buffered stdout → parse JSON lines → forward to WebSocket
    let buffer: string = '';
    process.stdout!.on('data', (chunk: Buffer) => {
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
            } catch {
                // Skip non-JSON lines (e.g. claude startup text)
            }
        }
    });

    // Forward stderr as error messages
    process.stderr!.on('data', (chunk: Buffer) => {
        const text: string = chunk.toString().trim();
        if (text && webSocket.readyState === WebSocket.OPEN) {
            console.error(`WebSocket: claude stderr — ${text}`.yellow);
        }
    });

    return process;
}

export {spawnClaude};
