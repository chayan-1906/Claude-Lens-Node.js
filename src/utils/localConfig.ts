import "colors";
import fs from "fs";
import path from "path";
import {ILocalConfig, IR2Config} from "../types/setup";

// --- Constants ---

const CONFIG_DIR: string = path.join(process.env.HOME || '~', '.claude-lens');
const CONFIG_FILE: string = path.join(CONFIG_DIR, 'config.json');

// --- Helpers ---

/** Generate a random hex color (e.g. "#4A90D9") */
function generateRandomColor(): string {
    const hex: string = Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0');
    return `#${hex}`;
}

// --- Functions ---

/**
 * Read ~/.claude-lens/config.json
 * Returns the parsed config, or null if the file does not exist
 */
function getLocalConfig(): ILocalConfig | null {
    if (!fs.existsSync(CONFIG_FILE)) {
        console.debug('DEBUG: Local config file not found'.cyan, {path: CONFIG_FILE});
        return null;
    }

    const raw: string = fs.readFileSync(CONFIG_FILE, 'utf-8');
    console.debug('DEBUG: Local config loaded'.cyan, {path: CONFIG_FILE});
    const parsed: unknown = JSON.parse(raw);

    return parsed as ILocalConfig;
}

/**
 * Write config to ~/.claude-lens/config.json
 * Creates the ~/.claude-lens/ directory if it does not exist
 */
function saveLocalConfig(config: ILocalConfig): void {
    if (!fs.existsSync(CONFIG_DIR)) {
        console.debug('DEBUG: Creating config directory'.cyan, {path: CONFIG_DIR});
        fs.mkdirSync(CONFIG_DIR, {recursive: true});
    }

    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    console.debug('DEBUG: Local config saved'.cyan, {path: CONFIG_FILE});
}

/**
 * Read the r2Config section from ~/.claude-lens/config.json
 * Returns the R2 config, or null if not configured
 */
function getR2Config(): IR2Config | null {
    const localConfig: ILocalConfig | null = getLocalConfig();
    if (!localConfig?.r2Config) {
        console.debug('DEBUG: R2 config not found in local config'.cyan);
        return null;
    }

    console.debug('DEBUG: R2 config loaded'.cyan);
    return localConfig.r2Config;
}

/**
 * Write r2Config into ~/.claude-lens/config.json
 * Preserves all other config keys
 */
function saveR2Config(config: IR2Config): void {
    const localConfig: ILocalConfig = getLocalConfig() ?? {configurations: [], activeConfigId: '', pathMappings: []};
    localConfig.r2Config = config;
    saveLocalConfig(localConfig);
    console.debug('DEBUG: R2 config saved'.cyan);
}

/**
 * Read ttsVoiceId and ttsRate from ~/.claude-lens/config.json
 * Returns the stored values, or the defaults if not set.
 */
function getTtsSettings(): {voiceId: string; rate: number} {
    const localConfig: ILocalConfig | null = getLocalConfig();
    return {
        voiceId: localConfig?.ttsVoiceId ?? 'en-US-AriaNeural',
        rate: localConfig?.ttsRate ?? 1,
    };
}

/**
 * Write ttsVoiceId and/or ttsRate into ~/.claude-lens/config.json
 * Only updates the supplied fields — preserves all other config keys.
 */
function saveTtsSettings({voiceId, rate}: {voiceId?: string; rate?: number}): void {
    const localConfig: ILocalConfig = getLocalConfig() ?? {configurations: [], activeConfigId: '', pathMappings: []};
    if (voiceId !== undefined) localConfig.ttsVoiceId = voiceId;
    if (rate !== undefined) localConfig.ttsRate = rate;
    saveLocalConfig(localConfig);
    console.debug('DEBUG: TTS settings saved'.cyan, {voiceId, rate});
}

/**
 * Read claudeConfigDir from ~/.claude-lens/config.json
 * Returns the stored value, or undefined if not set (use Claude CLI default).
 */
function getClaudeConfigDir(): string | undefined {
    const localConfig: ILocalConfig | null = getLocalConfig();
    return localConfig?.claudeConfigDir;
}

/**
 * Write claudeConfigDir into ~/.claude-lens/config.json
 * Preserves all other config keys.
 */
function saveClaudeConfigDir(configDir: string): void {
    const localConfig: ILocalConfig = getLocalConfig() ?? {configurations: [], activeConfigId: '', pathMappings: []};
    localConfig.claudeConfigDir = configDir;
    saveLocalConfig(localConfig);
    console.debug('DEBUG: claudeConfigDir saved'.cyan, {configDir});
}

/**
 * Remove claudeConfigDir from ~/.claude-lens/config.json (revert to system default).
 */
function clearClaudeConfigDir(): void {
    const localConfig: ILocalConfig | null = getLocalConfig();
    if (!localConfig) return;
    delete localConfig.claudeConfigDir;
    saveLocalConfig(localConfig);
    console.debug('DEBUG: claudeConfigDir cleared'.cyan);
}

export {getLocalConfig, saveLocalConfig, generateRandomColor, getR2Config, saveR2Config, getTtsSettings, saveTtsSettings, getClaudeConfigDir, saveClaudeConfigDir, clearClaudeConfigDir};
