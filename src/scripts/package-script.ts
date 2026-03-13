import path from "path";
import {platform} from "os";
import {execSync} from "child_process";
import {existsSync, readFileSync, writeFileSync} from "fs";

const isMacOS: boolean = platform() === 'darwin';

const targets: string = isMacOS
    ? 'node22-macos-arm64'
    : 'node22-win-x64';

/** Build TypeScript and bundle with ncc */
execSync('npm run build && npm run bundle', {stdio: 'inherit'});

/** Read .env and inject values into the bundle before pkg packages it */
const projectRoot: string = path.resolve(__dirname, '..', '..');
const envPath: string = path.join(projectRoot, '.env');

if (!existsSync(envPath)) {
    console.error(`Error: .env file not found at ${envPath}`);
    process.exit(1);
}

const envContent: string = readFileSync(envPath, 'utf-8');

const envLines: string[] = envContent
    .split('\n')
    .map((line: string) => line.trim())
    .filter((line: string) => line && !line.startsWith('#') && line.includes('='));

const envPreamble: string = envLines
    .map((line: string) => {
        const eqIndex: number = line.indexOf('=');
        const key: string = line.substring(0, eqIndex);
        let value: string = line.substring(eqIndex + 1);

        // Strip surrounding quotes (single or double)
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        return `process.env[${JSON.stringify(key)}] = process.env[${JSON.stringify(key)}] ?? ${JSON.stringify(value)};`;
    })
    .join('\n');

const bundlePath: string = path.join(projectRoot, 'build', 'index.js');
const bundleContent: string = readFileSync(bundlePath, 'utf-8');
writeFileSync(bundlePath, envPreamble + '\n' + bundleContent, 'utf-8');

console.log(`Injected ${envLines.length} env vars into bundle`);

/** Package with pkg */
execSync(`npx @yao-pkg/pkg build/index.js --target ${targets} --output dist/claude-lens-backend`, {stdio: 'inherit'});