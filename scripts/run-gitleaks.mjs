import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const executable = fileURLToPath(
  new URL(
    `../.local/tools/gitleaks/${process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks'}`,
    import.meta.url,
  ),
);
const config = fileURLToPath(new URL('../.gitleaks.toml', import.meta.url));
const staged = process.argv.includes('--staged');
let temporary;
try {
  let args;
  if (staged) {
    temporary = await mkdtemp(join(tmpdir(), 'buddy-staged-'));
    const checkout = spawnSync(
      'git',
      [
        'checkout-index',
        '--all',
        `--prefix=${(temporary + sep).replaceAll('\\', '/')}`,
      ],
      { cwd: root, stdio: 'pipe' },
    );
    if (checkout.status !== 0)
      throw new Error('ステージ済みファイルの取得に失敗しました。');
    args = ['dir', temporary];
  } else {
    const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: root,
      encoding: 'utf8',
    });
    if (shallow.status !== 0 || shallow.stdout.trim() !== 'false')
      throw new Error(
        '全履歴を取得してください（shallow clone では履歴検査しません）。',
      );
    args = ['git', '--log-opts=--all', root];
  }
  const result = spawnSync(
    executable,
    [
      ...args,
      '--config',
      config,
      '--redact=100',
      '--no-banner',
      '--log-level=error',
    ],
    { cwd: root, stdio: 'pipe', encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  // Never relay scanner output: log only the outcome, not matched values.
  if (result.error)
    throw new Error(
      'Gitleaks を実行できません。pnpm run security:setup を実行してください。',
    );
  if (result.status !== 0)
    throw new Error(
      'Gitleaks が秘密情報候補または検査エラーを検出しました。ローカルで redacted 診断を確認してください。',
    );
  console.log(
    staged
      ? 'Staged secret scan passed.'
      : 'Full fetched Git history secret scan passed.',
  );
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
