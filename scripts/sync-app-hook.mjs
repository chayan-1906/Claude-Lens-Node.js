import {fileURLToPath} from "url";
import {dirname, resolve} from "path";
import {copyFileSync, existsSync, chmodSync} from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(__dirname, '..', 'hooks', 'pretooluse-approval.sh');
const APP_ROOT = '/Applications/Claude Lens.app';
const DEST = `${APP_ROOT}/Contents/Resources/hooks/pretooluse-approval.sh`;

if (!existsSync(APP_ROOT)) {
    console.log(`[sync-app-hook] ${APP_ROOT} not found — skipping (only needed when the .app is installed).`);
    process.exit(0);
}

if (!existsSync(SOURCE)) {
    console.error(`[sync-app-hook] Source hook not found at ${SOURCE}`);
    process.exit(1);
}

try {
    copyFileSync(SOURCE, DEST);
    chmodSync(DEST, 0o755);
    console.log(`[sync-app-hook] Synced hook → ${DEST}`);
} catch (error) {
    console.error(`[sync-app-hook] Failed to sync hook: ${error.message}`);
    process.exit(1);
}
