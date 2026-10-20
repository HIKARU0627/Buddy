import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readWorkspaces } from './workspaces.mjs';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const pinned = (await readFile(new URL('.node-version', root), 'utf8')).trim();
const [major, minor, patch] = process.versions.node.split('.').map(Number);
const [wantedMajor, wantedMinor, wantedPatch] = pinned.split('.').map(Number);
if (
  major !== wantedMajor ||
  minor < wantedMinor ||
  (minor === wantedMinor && patch < wantedPatch)
) {
  throw new Error(
    `Node.js ${pinned} 以上の 24 系を使用してください。現在: ${process.versions.node}`,
  );
}
const userAgent = process.env['npm_config_user_agent'];
const expectedPnpm = pkg.packageManager.replace(/^pnpm@/u, '');
const pnpmMatch = userAgent?.match(/^pnpm\/(\d+\.\d+\.\d+)(?:\s|$)/u);
if (userAgent && pnpmMatch?.[1] !== expectedPnpm) {
  throw new Error(`pnpm ${expectedPnpm} を使用してください。`);
}
const workspaces = await readWorkspaces();
for (const workspace of workspaces) {
  const manifest = JSON.parse(
    await readFile(new URL(`${workspace}/package.json`, root), 'utf8'),
  );
  if (!manifest.private) throw new Error(`${workspace} must be private`);
}
console.log(
  `Buddy: Node ${process.versions.node}, pnpm ${pnpmMatch?.[1] ?? '未確認'}, ${workspaces.length} workspaces`,
);
console.log(`Root: ${fileURLToPath(root)}`);
console.log(
  '環境検証です。B00 の契約は揃いましたが、製品機能と製品試験は未着手です。',
);
