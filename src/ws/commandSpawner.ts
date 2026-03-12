import "colors";
import {WebSocket} from "ws";
import {IPty, spawn as ptySpawn} from "node-pty";

/**
 * Spawn the claude CLI in an interactive PTY and send a slash command as the first input.
 * PTY output is streamed to the WebSocket as `command_output` events.
 * When the process exits, a `command_done` event is sent.
 *
 * A separate PTY is spawned per slash command — completely independent from the
 * existing `-p stream-json` chat process managed by claudeSpawner.ts.
 *
 * Returns the IPty instance so the caller can:
 *   - forward user keystrokes via pty.write(data) for interactive TUI commands
 *   - kill the process on WS close via pty.kill()
 */
function spawnCommand(command: string, projectDir: string | undefined, webSocket: WebSocket): IPty {
    const cwd: string = projectDir || process.env.HOME || '~';

    console.log(`CommandSpawner: Spawning PTY for command "${command}" in ${cwd}`.cyan);

    const pty: IPty = ptySpawn('claude', [], {
        name: 'xterm-color',
        cols: 220,
        rows: 50,
        cwd,
        env: process.env as Record<string, string>,
    });

    // Send the slash command as the first input to the interactive claude session
    pty.write(command + '\r');

    pty.onData((data: string) => {
        if (webSocket.readyState === WebSocket.OPEN) {
            webSocket.send(JSON.stringify({type: 'command_output', data}));
        }
    });

    pty.onExit(({exitCode}: {exitCode: number; signal?: number}) => {
        console.log(`CommandSpawner: PTY exited with code ${exitCode}`.cyan);
        if (webSocket.readyState === WebSocket.OPEN) {
            webSocket.send(JSON.stringify({type: 'command_done', exitCode}));
        }
    });

    return pty;
}

export {spawnCommand};
