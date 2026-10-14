// D6: tsx 経由の .ts デバッグ。BP 行は d2 が `// BP` を読む。
interface Item {
  id: number;
  label: string;
}

function build(n: number): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < n; i++) items.push({ id: i, label: `item-${i}` }); // BP
  return items;
}

const out = build(3);
console.log('ts result', out.length);
setTimeout(() => console.log('bye'), 200);
