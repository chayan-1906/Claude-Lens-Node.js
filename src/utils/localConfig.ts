import fs from "fs";
import path from "path";

// --- Constants ---

const CONFIG_DIR: string = path.join(process.env.HOME || '~', '.claude-lens');
const CONFIG_FILE: string = path.join(CONFIG_DIR, 'config.json');

// --- Types ---

interface ILocalConfig {
    MONGO_URI: string;
}

// --- Functions ---

/**
 * Read ~/.claude-lens/config.json
 * Returns the parsed config, or null if the file does not exist
 */
function getLocalConfig(): ILocalConfig | null {
    if (!fs.existsSync(CONFIG_FILE)) {
        return null;
    }

    const raw: string = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as ILocalConfig;
}

/**
 * Write config to ~/.claude-lens/config.json
 * Creates the ~/.claude-lens/ directory if it does not exist
 */
function saveLocalConfig(config: ILocalConfig): void {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, {recursive: true});
    }

    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

export {getLocalConfig, saveLocalConfig};
export type {ILocalConfig};
