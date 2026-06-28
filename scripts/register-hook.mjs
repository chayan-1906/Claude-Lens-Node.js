import {dirname, join, resolve} from 'path';
import {fileURLToPath} from 'url';
import {homedir} from 'os';
import {readFileSync, writeFileSync} from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
// Resolve hook path dynamically from the project root — works on any machine
const HOOK_COMMAND = resolve(__dirname, '..', 'hooks', 'pretooluse-approval.sh');
const MATCHER = 'Read|Edit|Write|NotebookEdit|Bash|WebSearch|WebFetch|mcp__.*';
const TIMEOUT = 86_400_000; // 24h — match hook curl --max-time and approve native Claude Code's effectively-unlimited prompt wait

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
        const existingHook = settings.hooks.PreToolUse[existingIndex].hooks[0] ?? {};
        const existingCommand = existingHook.command;
        const existingTimeout = existingHook.timeout;
        // Re-write the entry if EITHER the command path OR the timeout differ from the desired
        // values. Previously this only checked command, so a stale TIMEOUT (e.g. an older
        // 600000 from a previous version of this script) silently persisted in settings.json.
        if (existingCommand === HOOK_COMMAND && existingTimeout === TIMEOUT) {
            console.log('[register-hook] PreToolUse approval hook already registered.');
        } else {
            settings.hooks.PreToolUse[existingIndex] = targetHookEntry;
            writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
            const reasons = [];
            if (existingCommand !== HOOK_COMMAND) {
                reasons.push(`command: ${existingCommand} → ${HOOK_COMMAND}`);
            }
            if (existingTimeout !== TIMEOUT) {
                reasons.push(`timeout: ${existingTimeout} → ${TIMEOUT}`);
            }
            console.log(`[register-hook] Updated hook entry — ${reasons.join(', ')}`);
        }
    } else {
        settings.hooks.PreToolUse.push(targetHookEntry);
        writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
        console.log('[register-hook] PreToolUse approval hook registered in ~/.claude/settings.json');
    }
} catch (error) {
    console.error('[register-hook] Failed to register hook:', error.message);
    process.exit(1);
}
