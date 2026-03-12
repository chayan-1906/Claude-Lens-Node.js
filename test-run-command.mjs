import { WebSocket } from 'ws';

const ws = new WebSocket('ws://localhost:20261/ws');

ws.on('open', () => {
    console.log('connected — sending /context');
    ws.send(JSON.stringify({ type: 'run_command', command: '/context' }));
});

ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'command_output') {
        // Show escaped so ANSI codes don't mess up terminal
        console.log('[output]', JSON.stringify(msg.data));
    }
    if (msg.type === 'command_done') { console.log('--- done, exitCode:', msg.exitCode); ws.close(); }
    if (msg.type === 'error') { console.error('ERROR:', msg.message); ws.close(); }
});