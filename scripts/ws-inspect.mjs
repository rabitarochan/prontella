// Attach-only inspector: dump status flags and the stripped scrollback tail
// of every live terminal session. Sends no input.
import WebSocket from 'ws';

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

const sessions = await (await fetch('http://localhost:3711/api/terminals')).json();

for (const s of sessions) {
  console.log('='.repeat(70));
  console.log(`id=${s.id} status=${s.status} claudeDetected=${s.claudeDetected}`);
  console.log(`cwd=${s.cwd}`);
  console.log(`lastOutputAt=${new Date(s.lastOutputAt).toISOString()}`);
  const tail = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:3711/ws/term?id=${s.id}`);
    const timer = setTimeout(() => {
      ws.close();
      resolve('(no snapshot)');
    }, 3000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'snapshot') {
        clearTimeout(timer);
        ws.close();
        resolve(msg.data.replace(ANSI_RE, ''));
      }
    });
    ws.on('error', () => {
      clearTimeout(timer);
      resolve('(ws error)');
    });
  });
  console.log('--- stripped tail (last 1200 chars) ---');
  console.log(JSON.stringify(tail.slice(-1200)));
}
process.exit(0);
