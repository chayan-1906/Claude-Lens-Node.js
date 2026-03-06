import path from "path";
import {platform} from "os";
import {execSync} from "child_process";
import {readFileSync, writeFileSync} from "fs";

const isMacOS: boolean = platform() === 'darwin';

const targets: string = isMacOS
    ? 'node18-macos-arm64'
    : 'node18-win-x64';

/** Build TypeScript and bundle with ncc */
execSync('npm run build && npm run bundle', {stdio: 'inherit'});

/** Read .env and inject values into the bundle before pkg packages it */
const projectRoot: string = path.resolve(__dirname, '..', '..');
const envPath: string = path.join(projectRoot, '.env');
const envContent: string = readFileSync(envPath, 'utf-8');

const envLines: string[] = envContent
    .split('\n')
    .map((line: string) => line.trim())
    .filter((line: string) => line && !line.startsWith('#'));

const envPreamble: string = envLines
    .map((line: string) => {
        const eqIndex: number = line.indexOf('=');
        const key: string = line.substring(0, eqIndex);
        const value: string = line.substring(eqIndex + 1);
        return `process.env[${JSON.stringify(key)}] = process.env[${JSON.stringify(key)}] ?? ${JSON.stringify(value)};`;
    })
    .join('\n');

const bundlePath: string = path.join(projectRoot, 'build', 'index.js');
const bundleContent: string = readFileSync(bundlePath, 'utf-8');
writeFileSync(bundlePath, envPreamble + '\n' + bundleContent, 'utf-8');

console.log(`Injected ${envLines.length} env vars into bundle`);

/** Package with pkg */
execSync(`pkg build/index.js --target ${targets} --output dist/claude-lens-backend`, {stdio: 'inherit'});
