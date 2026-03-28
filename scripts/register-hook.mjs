import {dirname, join, resolve} from 'path';
import {fileURLToPath} from 'url';
import {homedir} from 'os';
import {readFileSync, writeFileSync} from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
// Resolve hook path dynamically from the project root — works on any machine
const HOOK_COMMAND = resolve(__dirname, '..', 'hooks', 'pretooluse-approval.sh');
const MATCHER = 'Read|Edit|Write|NotebookEdit|Bash|WebSearch|WebFetch|mcp__.*';
const TIMEOUT = 600000;

const targetHookEntry = {
    matcher: MATCHER,
    hooks: [
        {
            type: 'command',
            command: HOOK_COMMAND,
            timeout: TIMEOUT,
        },
    ],
};

try {
    const raw = readFileSync(SETTINGS_PATH, 'utf-8');
    const settings = JSON.parse(raw);

    if (!settings.hooks) {
        settings.hooks = {};
    }

    if (!Array.isArray(settings.hooks.PreToolUse)) {
        settings.hooks.PreToolUse = [];
    }

    // Check if any existing entry points to the same hook script (by filename match)
    const hookBaseName = 'pretooluse-approval.sh';
    const existingIndex = settings.hooks.PreToolUse.findIndex((entry) =>
        entry.hooks?.some((h) => h.command?.endsWith(hookBaseName))
    );

    if (existingIndex !== -1) {
        const existingCommand = settings.hooks.PreToolUse[existingIndex].hooks[0]?.command;
        if (existingCommand === HOOK_COMMAND) {
            console.log('[register-hook] PreToolUse approval hook already registered.');
        } else {
            // Path changed (e.g. different machine) — update in place
            settings.hooks.PreToolUse[existingIndex] = targetHookEntry;
            writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
            console.log(`[register-hook] Updated hook path: ${existingCommand} → ${HOOK_COMMAND}`);
        }
    } else {
        settings.hooks.PreToolUse.push(targetHookEntry);
        writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
        console.log('[register-hook] PreToolUse approval hook registered in ~/.claude/settings.json');
    }
} catch (err) {
    console.error('[register-hook] Failed to register hook:', err.message);
    process.exit(1);
}
