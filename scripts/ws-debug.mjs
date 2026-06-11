// Debug helper: create a terminal, run a command, dump the stripped snapshot.
import WebSocket from 'ws';

const dir = process.argv[2] ?? process.cwd();
const run = process.argv[3];

const res = await fetch('http://localhost:3711/api/terminals', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ cwd: dir, run }),
});
const session = await res.json();
console.log('session:', session);

await new Promise((r) => setTimeout(r, 4000));

const ws = new WebSocket(`ws://localhost:3711/ws/term?id=${session.id}`);
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.type === 'snapshot') {
    const plain = msg.data.replace(
      // eslint-disable-next-line no-control-regex
      /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g,
      '',
    );
    console.log('--- stripped snapshot ---');
    console.log(JSON.stringify(plain.slice(-800)));
    console.log('--- match busy:', /esc to interrupt/i.test(plain));
  } else if (msg.type === 'status') {
    console.log('status:', msg.status);
  }
});

setTimeout(async () => {
  const list = await (await fetch('http://localhost:3711/api/terminals')).json();
  console.log('final:', list.find((s) => s.id === session.id));
  await fetch(`http://localhost:3711/api/terminals/${session.id}/kill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  process.exit(0);
}, 6000);
