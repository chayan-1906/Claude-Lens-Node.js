import "colors";
import path from "path";
import fs from "fs/promises";
import {IPermissionsSettings} from "../types/permissions";

/** In-process mutex keyed by absolute settings-file path — serializes concurrent writes. */
const fileWriteMutex: Map<string, Promise<void>> = new Map();

function resolveSettingsPath(projectDir: string): string {
    return path.join(projectDir, '.claude', 'settings.local.json');
}

async function readSettings(settingsPath: string): Promise<IPermissionsSettings> {
    try {
        const raw: string = await fs.readFile(settingsPath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as IPermissionsSettings;
        }
        return {};
    } catch (error: unknown) {
        const code: string | undefined = (error as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') return {};
        throw error;
    }
}

/** Atomic write: write to .tmp sibling and rename — never leaves a half-written JSON. */
async function atomicWriteJson(settingsPath: string, settings: IPermissionsSettings): Promise<void> {
    const dir: string = path.dirname(settingsPath);
    await fs.mkdir(dir, {recursive: true});
    const tmpPath: string = `${settingsPath}.tmp`;
    const json: string = `${JSON.stringify(settings, null, 2)}\n`;
    await fs.writeFile(tmpPath, json, 'utf-8');
    await fs.rename(tmpPath, settingsPath);
}

/**
 * Append a tool rule (e.g. 'Read', 'TodoWrite', 'mcp__github__get-file-content')
 * to the target project's .claude/settings.local.json → permissions.allow.
 * Set-like: duplicates are skipped. Unrelated top-level keys are preserved.
 * Serialized per settings-file path to avoid lost updates from concurrent sessions.
 */
async function addToolToProjectAllowList(projectDir: string, toolName: string): Promise<void> {
    if (!projectDir) throw new Error('addToolToProjectAllowList: projectDir is required');
    if (!toolName) throw new Error('addToolToProjectAllowList: toolName is required');

    const settingsPath: string = resolveSettingsPath(projectDir);

    const previous: Promise<void> = fileWriteMutex.get(settingsPath) ?? Promise.resolve();
    const next: Promise<void> = previous.then(async (): Promise<void> => {
        const settings: IPermissionsSettings = await readSettings(settingsPath);
        const permissions = settings.permissions ?? {};
        const allow: string[] = Array.isArray(permissions.allow) ? [...permissions.allow] : [];

        if (allow.includes(toolName)) {
            console.log(`AllowList: '${toolName}' already present in ${settingsPath} — skip write`.cyan);
            return;
        }

        allow.push(toolName);
        const nextSettings: IPermissionsSettings = {
            ...settings,
            permissions: {
                ...permissions,
                allow,
            },
        };

        await atomicWriteJson(settingsPath, nextSettings);
        console.log(`AllowList: Added '${toolName}' to ${settingsPath}`.green);
    }).catch((error: unknown): void => {
        console.error(`AllowList: Failed to update ${settingsPath} — ${error}`.red);
        throw error;
    });

    const tracked: Promise<void> = next.finally((): void => {
        if (fileWriteMutex.get(settingsPath) === tracked) {
            fileWriteMutex.delete(settingsPath);
        }
    });
    fileWriteMutex.set(settingsPath, tracked);

    await tracked;
}

/**
 * Read the current allow list from the project's settings.local.json.
 * Returns an empty array if the file is missing or has no allow entries.
 * Used at session start to pre-populate the in-memory sessionAllowAll cache
 * so tools persisted in a previous session are auto-approved immediately.
 */
async function readProjectAllowList(projectDir: string): Promise<string[]> {
    if (!projectDir) return [];
    const settingsPath: string = resolveSettingsPath(projectDir);
    const settings: IPermissionsSettings = await readSettings(settingsPath);
    const allow = settings.permissions?.allow;
    return Array.isArray(allow) ? allow : [];
}

export {addToolToProjectAllowList, readProjectAllowList, resolveSettingsPath};
