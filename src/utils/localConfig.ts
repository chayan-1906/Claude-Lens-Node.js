import "colors";
import fs from "fs";
import path from "path";
import {ILocalConfig} from "../types/setup";

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

export {getLocalConfig, saveLocalConfig, generateRandomColor};
