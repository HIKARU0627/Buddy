import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectPublicContent } from './public-content.mjs';

test('非公開資料・実データ・資格情報ファイルを拒否する', () => {
  for (const path of [
    'docs/design/notion/01.md',
    '.local/design/source.md',
    '.env',
    '.env.local',
    'data/mail.eml',
    'data/buddy.sqlite-wal',
    'keys/client.pem',
  ]) {
    assert.ok(
      inspectPublicContent(path, Buffer.from('sample')).includes(
        'private-path',
      ),
      path,
    );
  }
});
test('Notion 内部リンクと実メール形式を拒否し、合成例は許可する', () => {
  const notion = ['https://app.', 'notion.com/p/', 'synthetic-page'].join('');
  const mail = ['person', 'private.test'].join('@');
  assert.ok(
    inspectPublicContent('docs/a.md', Buffer.from(notion)).includes(
      'private-notion-link',
    ),
  );
  assert.ok(
    inspectPublicContent('docs/a.md', Buffer.from(mail)).includes(
      'personal-email',
    ),
  );
  assert.deepEqual(
    inspectPublicContent('.env.example', Buffer.from('BUDDY_MODE=mock\n')),
    [],
  );
  assert.deepEqual(
    inspectPublicContent(
      'tests/fixture.json',
      Buffer.from('user@example.invalid'),
    ),
    [],
  );
});
test('バイナリを無検査で公開しない', () => {
  assert.ok(
    inspectPublicContent('image.png', Buffer.from([0, 1, 2])).includes(
      'binary-needs-review',
    ),
  );
});

test('作業ツリーで消してもステージ済みの非公開リンクを拒否し、値を出力しない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-privacy-test-'));
  try {
    await mkdir(join(root, 'scripts'));
    for (const file of ['check-public-content.mjs', 'public-content.mjs']) {
      await copyFile(
        new URL(file, import.meta.url),
        join(root, 'scripts', file),
      );
    }
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    const internal = [
      'https://app.',
      'notion.com/p/',
      'synthetic-hidden-reference',
    ].join('');
    await writeFile(join(root, 'example.md'), internal);
    execFileSync('git', ['add', 'example.md'], { cwd: root });
    await writeFile(join(root, 'example.md'), 'Public example');
    const result = spawnSync(
      process.execPath,
      ['scripts/check-public-content.mjs', '--staged'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /private-notion-link/u);
    assert.ok(!result.stderr.includes(internal));
    assert.ok(!result.stdout.includes(internal));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('push する途中のコミットにだけ残る非公開情報も拒否する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-push-test-'));
  try {
    await mkdir(join(root, 'scripts'));
    for (const file of [
      'check-push.mjs',
      'check-public-content.mjs',
      'public-content.mjs',
    ]) {
      await copyFile(
        new URL(file, import.meta.url),
        join(root, 'scripts', file),
      );
    }
    const git = (...args) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '--quiet');
    git('config', 'user.name', 'Test User');
    git('config', 'user.email', 'user@example.invalid');
    const commit = async (text) => {
      await writeFile(join(root, 'example.md'), text);
      git('add', 'example.md');
      git('commit', '--quiet', '-m', 'Test fixture');
      return git('rev-parse', 'HEAD');
    };
    const base = await commit('Public example');
    const clean = await commit('Updated public example');
    const push = (head) =>
      spawnSync(process.execPath, ['scripts/check-push.mjs'], {
        cwd: root,
        encoding: 'utf8',
        input: `refs/heads/main ${head} refs/heads/main ${base}\n`,
      });
    assert.equal(push(clean).status, 0);
    const internal = [
      'https://app.',
      'notion.com/p/',
      'synthetic-deleted-reference',
    ].join('');
    await commit(internal);
    const removed = await commit('Public example restored');
    const result = push(removed);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /private-notion-link/u);
    assert.ok(!result.stderr.includes(internal));
    assert.ok(!result.stdout.includes(internal));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
