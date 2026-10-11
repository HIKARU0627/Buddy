import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const root = new URL('../.local/design/notion/', import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL('manifest.json', root), 'utf8'),
);
for (const source of manifest.sources) {
  const bytes = await readFile(new URL(source.file, root));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== source.sha256) {
    throw new Error(
      `設計スナップショットの変更を検出: ${source.file}。元の Notion と取得記録を確認してください。`,
    );
  }
}
console.log(
  `${manifest.sources.length} design snapshots verified (integrity only; not freshness or product conformance).`,
);
