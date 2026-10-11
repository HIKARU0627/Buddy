import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const updates = readFileSync(0, 'utf8').trim().split('\n').filter(Boolean);
const scanner = fileURLToPath(
  new URL('check-public-content.mjs', import.meta.url),
);
for (const line of updates) {
  const [, local, , remote] = line.trim().split(/\s+/u);
  if (
    !/^[a-f0-9]{40}$/u.test(local ?? '') ||
    !/^[a-f0-9]{40}$/u.test(remote ?? '')
  ) {
    throw new Error('Unexpected pre-push input');
  }
  if (/^0+$/u.test(local)) continue;
  const range = /^0+$/u.test(remote) ? local : `${remote}..${local}`;
  const result = spawnSync(process.execPath, [scanner, `--commits=${range}`], {
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) process.exit(1);
}
