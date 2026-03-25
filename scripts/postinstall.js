/**
 * Generates type declarations for packages that don't ship their own.
 * Runs automatically after `npm install` via the "postinstall" script in package.json.
 */
const fs = require('fs');
const path = require('path');

const declarations = [
    {
        file: path.join(__dirname, '..', 'node_modules', 'heic-convert', 'index.d.ts'),
        content: [
            'declare function convert(options: {buffer: Buffer; format: \'JPEG\' | \'PNG\'; quality?: number}): Promise<ArrayBuffer>;',
            '',
            'export = convert;',
            '',
        ].join('\n'),
    },
];

for (const decl of declarations) {
    try {
        fs.writeFileSync(decl.file, decl.content, 'utf8');
        console.log(`postinstall: wrote ${path.relative(process.cwd(), decl.file)}`);
    } catch (err) {
        console.warn(`postinstall: skipped ${path.basename(decl.file)} — ${err.message}`);
    }
}
