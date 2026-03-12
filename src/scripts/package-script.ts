import path from "path";
import {platform} from "os";
import {execSync} from "child_process";
import {existsSync, readdirSync, readFileSync, writeFileSync} from "fs";

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

/**
 * Find a file inside node-pty's prebuilds/{platform}-{arch}/ directory.
 * Falls back to build/Release/{name} for compiled-from-source installations.
 */
function findNptyFile(name: string): string {
    const nptyRoot: string = path.join(projectRoot, 'node_modules', 'node-pty');
    const prebuildsDir: string = path.join(nptyRoot, 'prebuilds');
    const platformArch: string = `${platform()}-${process.arch}`;

    if (existsSync(prebuildsDir)) {
        const dirs: string[] = readdirSync(prebuildsDir).filter((d: string) => d.startsWith(platformArch));
        for (const dir of dirs) {
            const candidate: string = path.join(prebuildsDir, dir, name);
            if (existsSync(candidate)) return candidate;
        }
    }

    const fallback: string = path.join(nptyRoot, 'build', 'Release', name);
    if (existsSync(fallback)) return fallback;

    console.error(`Error: Could not find node-pty file: ${name}`);
    process.exit(1);
}

const nativeAddonSrc: string = findNptyFile('pty.node');
const spawnHelperSrc: string = findNptyFile('spawn-helper');

/**
 * Embed both node-pty native files as Base64 strings in the bundle preamble.
 * This bypasses pkg's asset system entirely.
 *
 * At runtime inside the pkg binary:
 *   1. Decode and write pty.node + spawn-helper to os.tmpdir().
 *   2. chmod 0o755 spawn-helper so posix_spawn can execute it.
 *   3. Patch Module._load to redirect require('*.node') to the extracted pty.node.
 *   4. Wrap the native pty module's fork() to replace helperPath with the extracted spawn-helper.
 *   5. Clean up both temp files on process exit.
 */
const nativeAddonBase64: string = readFileSync(nativeAddonSrc).toString('base64');
const spawnHelperBase64: string = readFileSync(spawnHelperSrc).toString('base64');

console.log(`Embedded pty.node      (${(nativeAddonBase64.length * 0.75 / 1024).toFixed(0)} KB): ${nativeAddonSrc}`);
console.log(`Embedded spawn-helper  (${(spawnHelperBase64.length * 0.75 / 1024).toFixed(0)} KB): ${spawnHelperSrc}`);

const nativePatch: string = `
if (process.pkg) {
  const _fs = require('fs');
  const _os = require('os');
  const _path = require('path');
  const _module = require('module');

  const _tmpDir    = _os.tmpdir();
  const _pid       = process.pid;
  const _tmpNative = _path.join(_tmpDir, 'claude-lens-pty-'    + _pid + '.node');
  const _tmpHelper = _path.join(_tmpDir, 'claude-lens-helper-' + _pid);

  _fs.writeFileSync(_tmpNative, Buffer.from(${JSON.stringify(nativeAddonBase64)}, 'base64'));
  _fs.writeFileSync(_tmpHelper, Buffer.from(${JSON.stringify(spawnHelperBase64)}, 'base64'));
  _fs.chmodSync(_tmpHelper, 0o755);

  process.on('exit', function() {
    try { _fs.unlinkSync(_tmpNative); } catch (_) {}
    try { _fs.unlinkSync(_tmpHelper); } catch (_) {}
  });

  const _originalLoad = _module._load.bind(_module);
  _module._load = function(request) {
    if (typeof request === 'string' && request.endsWith('.node')) {
      const _nativeMod = _originalLoad(_tmpNative, ...Array.prototype.slice.call(arguments, 1));
      // Wrap fork() so node-pty uses our extracted spawn-helper (it must be on real filesystem + executable)
      if (_nativeMod && typeof _nativeMod.fork === 'function') {
        const _origFork = _nativeMod.fork.bind(_nativeMod);
        _nativeMod.fork = function(file, args, env, cwd, cols, rows, uid, gid, utf8, _helperPath, onexit) {
          return _origFork(file, args, env, cwd, cols, rows, uid, gid, utf8, _tmpHelper, onexit);
        };
      }
      return _nativeMod;
    }
    return _originalLoad.apply(this, arguments);
  };
}`;

const bundlePath: string = path.join(projectRoot, 'build', 'index.js');
const bundleContent: string = readFileSync(bundlePath, 'utf-8');
writeFileSync(bundlePath, envPreamble + '\n' + nativePatch + '\n' + bundleContent, 'utf-8');

console.log(`Injected ${envLines.length} env vars into bundle`);
console.log('Injected node-pty extraction patch (pty.node + spawn-helper, Base64-embedded)');

/** Package with pkg */
execSync(
    `npx @yao-pkg/pkg build/index.js --target ${targets} --output dist/claude-lens-backend`,
    {stdio: 'inherit'}
);

console.log('Build complete — dist/claude-lens-backend is fully self-contained');
