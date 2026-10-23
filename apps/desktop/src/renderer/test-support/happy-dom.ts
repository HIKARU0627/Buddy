// 画面の操作の試験だけが使う、happy-dom の文書（UI-06、PR #121 のレビュー）。製品の画面からは読み込まない（vite の入口
// main.tsx から辿らない）。試験の最初に import し、React と画面より先に window・document などを用意する（読み込みの時点で
// window を見る部品があるため）。窓 1280 × 800、画面の作業領域も同じ（作業領域の外の幅は 0）。
import { Window } from 'happy-dom';

export const happy = new Window({ width: 1280, height: 800 });

for (const key of Object.getOwnPropertyNames(happy)) {
  if (key in globalThis && !['window', 'document', 'navigator'].includes(key))
    continue;
  Object.defineProperty(globalThis, key, {
    value: (happy as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  });
}
(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] =
  true;
for (const [key, value] of Object.entries({
  availLeft: 0,
  availTop: 0,
  availWidth: 1280,
  availHeight: 800,
}))
  Object.defineProperty(happy.screen, key, { value, configurable: true });
