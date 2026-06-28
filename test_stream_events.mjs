import { spawn } from 'child_process';

const claude = spawn('claude', ['-p', '--verbose', '--output-format', 'stream-json', '--max-turns', '1'], {
    stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';

claude.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const obj = JSON.parse(line);
            const type = obj.type || '?';
            console.log(`type: ${type}`);

            if (type === 'result') {
                console.log('  >>> RESULT EVENT FOUND <<<');
                console.log('  usage:', JSON.stringify(obj.usage, null, 2));
                console.log('  modelUsage:', JSON.stringify(obj.modelUsage, null, 2));
            }

            if (type === 'assistant' && obj.message?.usage) {
                console.log('  assistant.message.usage:', JSON.stringify(obj.message.usage, null, 2));
            }
        } catch {}
    }
});

claude.stderr.on('data', (chunk) => {
    console.error('STDERR:', chunk.toString().trim());
});

claude.on('close', (code) => {
    console.log(`\nProcess exited with code ${code}`);
});

claude.stdin.write('hello\n');
claude.stdin.end();
