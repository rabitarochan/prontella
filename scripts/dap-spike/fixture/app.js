// DAP スパイク用の被デバッグプログラム。3 段の呼び出し + ループ + stdout/stderr + 子プロセス。
// 停止行 (ブレークポイント) は `// BP` の行番号を d1.mjs が読む。
import { spawnSync } from 'node:child_process';

function leaf(n) {
  const obj = { n, s: 'x'.repeat(n), arr: Array.from({ length: 50 }, (_, i) => i * n), nested: { deep: { deeper: n } } };
  const sum = obj.arr.reduce((a, b) => a + b, 0); // BP
  return sum;
}

function mid(n) {
  const acc = [];
  for (let i = 0; i < 3; i++) acc.push(leaf(n + i));
  return acc;
}

function top() {
  console.log('hello stdout');
  console.error('hello stderr');
  const r = mid(2);
  const child = spawnSync(process.execPath, ['-e', 'console.log("child ok")'], { encoding: 'utf8' });
  console.log('child:', child.stdout.trim());
  return r;
}

const result = top();
console.log('result', JSON.stringify(result));
// D7: 切断後に生き残るかを見るため、しばらく生存する
let ticks = 0;
const timer = setInterval(() => {
  if (++ticks >= 120) clearInterval(timer);
}, 500);
