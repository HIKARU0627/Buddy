import { spawnSync } from 'node:child_process';
const result = spawnSync(
  'git',
  ['config', '--local', 'core.hooksPath', '.githooks'],
  { stdio: 'inherit' },
);
if (result.error || result.status !== 0)
  throw new Error('Git hook の設定に失敗しました。');
console.log(
  'Local Git hooks enabled: staged privacy/secret checks and pre-push checks.',
);
