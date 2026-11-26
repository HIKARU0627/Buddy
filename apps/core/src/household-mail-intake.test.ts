// 利用通知メールの取り込みの試験（ADR 0160）。DB は一時ディレクトリに作り、Gmail は模擬の読み取りで返す。
// 送信元の一覧・メールの見出しと本文・店名・金額はすべて合成（例示用のドメイン）。実在のメールの写しは使わない。
// 期待値は ADR 0160 の判断（初回は過去のメールを読まない・Gmail が一番上に付けた認証結果だけを信じる・件名が利用の
// 通知のときだけ本文を読む・読み取りに失敗したメールは確かめ済みにしない）から手で書いた値。

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { HouseholdNoticeIssuer, StartupGateDecision } from '@buddy/domain';
import type {
  GoogleGmailMessage,
  GoogleGmailPart,
  GoogleGmailReader,
} from '@buddy/connectors';
import {
  applyMigrations,
  executeHouseholdOp,
  initStoreGeneration,
  openWriteConnection,
} from '@buddy/storage';
import type {
  ConnectionRecord,
  DataKeyMaterial,
  DbWorkerClient,
  HouseholdOp,
  SqliteDatabase,
} from '@buddy/storage';
import { readHouseholdMonths } from './household-ledger.js';
import {
  createHouseholdMailIntake,
  gmailAuthenticationResults,
  gmailNoticeText,
  householdHtmlToText,
  householdLocalDate,
} from './household-mail-intake.js';

const STORE_GENERATION = '00000000-0000-4000-8000-0000000000aa';
const NOW = new Date('2030-10-05T03:00:00.000Z');
const ISSUERS: readonly HouseholdNoticeIssuer[] = [
  {
    id: 'card_a',
    label: '合成カード',
    domains: ['example.invalid'],
    provisional_subject: /速報/u,
  },
];
const PASS =
  'mx.google.com; dkim=pass header.d=example.invalid; dmarc=pass (p=REJECT) header.from=example.invalid';

const b64 = (text: string): string =>
  Buffer.from(text, 'utf8').toString('base64url');

function part(
  mimeType: string,
  body: string | null,
  headers: { name: string; value: string }[] = [],
  parts: GoogleGmailPart[] = [],
): GoogleGmailPart {
  return {
    mimeType,
    filename: '',
    headers: [
      { name: 'Content-Type', value: `${mimeType}; charset=UTF-8` },
      ...headers,
    ],
    bodySize: body === null ? 0 : body.length,
    ...(body === null ? {} : { bodyData: b64(body) }),
    parts,
  };
}

function message(
  id: string,
  options: {
    from?: string;
    subject?: string;
    auth?: string[];
    text?: string;
    html?: string;
    internalDate?: string;
  },
): GoogleGmailMessage {
  const headers = [
    ...(options.auth ?? [PASS]).map((value) => ({
      name: 'Authentication-Results',
      value,
    })),
    {
      name: 'From',
      value: options.from ?? '合成カード <info@example.invalid>',
    },
    { name: 'Subject', value: options.subject ?? 'カードご利用のお知らせ' },
  ];
  const children: GoogleGmailPart[] = [];
  if (options.text !== undefined)
    children.push(part('text/plain', options.text));
  if (options.html !== undefined)
    children.push(part('text/html', options.html));
  return {
    id,
    labelIds: ['INBOX'],
    internalDate: options.internalDate ?? String(NOW.getTime()),
    payload: {
      mimeType: 'multipart/alternative',
      filename: '',
      headers,
      bodySize: 0,
      parts: children,
    },
  };
}

interface Fixture {
  readonly db: SqliteDatabase;
  readonly client: Pick<DbWorkerClient, 'household'>;
  readonly dataKey: DataKeyMaterial;
  readonly messages: Map<string, GoogleGmailMessage>;
  readonly calls: { id: string; format: string }[];
  failOn: string | null;
}

function setup(t: test.TestContext): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-household-mail-'));
  const db = openWriteConnection(join(dir, 'buddy.db'), { platform: 'macos' });
  applyMigrations(db);
  initStoreGeneration(db, STORE_GENERATION);
  db.prepare(
    "INSERT INTO connections (connection_id, provider, account_blob_id, credential_ref, status, access, granted_scopes, targets, permission_revision, scope_revision) VALUES ('c-1', 'google', NULL, NULL, 'disconnected', 'read', '[]', '[]', 0, 0)",
  ).run();
  db.prepare(
    "INSERT INTO sync_scopes (scope_id, connection_id, scope_revision, active_generation, executor_generation) VALUES ('sc-1', 'c-1', 0, 0, 0)",
  ).run();
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const client = {
    household: (op: HouseholdOp) =>
      Promise.resolve(
        executeHouseholdOp(db, op, { platform: 'macos', halted: false }).result,
      ),
  } as unknown as Pick<DbWorkerClient, 'household'>;
  return {
    db,
    client,
    dataKey: { keyId: 'k-test', key: randomBytes(32) },
    messages: new Map(),
    calls: [],
    failOn: null,
  };
}

function storeMail(
  fixture: Fixture,
  value: GoogleGmailMessage,
  fetchedAt: number,
): void {
  fixture.messages.set(value.id, value);
  fixture.db
    .prepare(
      "INSERT INTO source_items (provider, account_id, remote_id, source_revision, scope_id, published_generation, fetched_at, body_blob_id) VALUES ('google', 'acct-a', ?, 'rev-1', 'sc-1', 0, ?, NULL)",
    )
    .run(value.id, fetchedAt);
}

function intake(fixture: Fixture) {
  const gmail = {
    getMessage: ({ id, format }: { id: string; format: string }) => {
      fixture.calls.push({ id, format });
      if (fixture.failOn === id)
        return Promise.reject(new Error('provider_error'));
      const found = fixture.messages.get(id);
      if (found === undefined) return Promise.reject(new Error('not_found'));
      return Promise.resolve(found);
    },
  } as unknown as GoogleGmailReader;
  return createHouseholdMailIntake({
    store: fixture.client,
    gmailFor: () => gmail,
    dataKey: () => Promise.resolve(fixture.dataKey),
    timeZone: () => 'Asia/Tokyo',
    now: () => NOW,
    issuers: ISSUERS,
  });
}

const target = {
  connection: { connection_id: 'c-1', provider: 'google' } as ConnectionRecord,
  account_id: 'acct-a',
  scope_id: 'sc-1',
};

async function amounts(fixture: Fixture): Promise<number[]> {
  const read = await readHouseholdMonths(
    { client: fixture.client, dataKey: fixture.dataKey },
    '2030-10',
    '2030-10',
  );
  assert.equal(read.outcome, 'ok');
  if (read.outcome !== 'ok') throw new Error('unreachable');
  return (read.months[0]?.entries ?? []).map(
    (entry) => entry.content.amount_yen,
  );
}

const USAGE = '利用日: 2030/10/05 11:30\n利用先: 合成食堂\n利用金額: 1,280円';

test('初回は過去のメールを読まずに基準を作り、その後に届いた利用通知だけを記録する', async (t) => {
  const fixture = setup(t);
  storeMail(fixture, message('m-old', { text: USAGE }), 1000);
  const run = intake(fixture);
  assert.deepEqual(await run.run(target), {
    outcome: 'done',
    reason: null,
    baseline: true,
    checked: 0,
    recorded: 0,
  });
  assert.deepEqual(fixture.calls, []);
  storeMail(fixture, message('m-new', { text: USAGE }), 2000);
  assert.deepEqual(await run.run(target), {
    outcome: 'done',
    reason: null,
    baseline: false,
    checked: 1,
    recorded: 1,
  });
  assert.deepEqual(fixture.calls, [
    { id: 'm-new', format: 'metadata' },
    { id: 'm-new', format: 'full' },
  ]);
  assert.deepEqual(await amounts(fixture), [1280]);
  // 確かめ済みのメールは読み直さない。
  assert.equal((await run.run(target)).checked, 0);
  assert.equal(fixture.calls.length, 2);
});

test('知らない送り主・認証の不合格・利用の通知でない件名は、本文を読まずに確かめ済みにする', async (t) => {
  const fixture = setup(t);
  const run = intake(fixture);
  await run.run(target);
  storeMail(
    fixture,
    message('m-unknown', { from: 'info@example.com', text: USAGE }),
    2000,
  );
  storeMail(
    fixture,
    message('m-fail', {
      auth: [
        'mx.google.com; dkim=fail header.d=example.invalid; dmarc=fail header.from=example.invalid',
      ],
      text: USAGE,
    }),
    2001,
  );
  // 送り主が本文の先頭に偽の認証結果を入れても、一番上が Gmail のものでなければ信じない。
  storeMail(
    fixture,
    message('m-forged', {
      auth: ['attacker.invalid; dmarc=pass header.from=example.invalid', PASS],
      text: USAGE,
    }),
    2002,
  );
  storeMail(
    fixture,
    message('m-bill', { subject: 'ご請求金額確定のお知らせ', text: USAGE }),
    2003,
  );
  storeMail(
    fixture,
    message('m-quick', {
      subject: '【速報】カードご利用のお知らせ',
      text: USAGE,
    }),
    2004,
  );
  assert.deepEqual(await run.run(target), {
    outcome: 'done',
    reason: null,
    baseline: false,
    checked: 5,
    recorded: 0,
  });
  assert.ok(fixture.calls.every((call) => call.format === 'metadata'));
  assert.deepEqual(await amounts(fixture), []);
});

test('HTML だけの通知も読み、一通の複数の利用を別々に記録する。同じメールを二度記録しない', async (t) => {
  const fixture = setup(t);
  const run = intake(fixture);
  await run.run(target);
  storeMail(
    fixture,
    message('m-html', {
      html: '<html><head><style>p{}</style></head><body><table><tr><td>利用日</td><td>2030/10/03</td></tr><tr><td>利用先</td><td>合成&amp;書店</td></tr><tr><td>利用金額</td><td>2,420円</td></tr><tr><td>利用日</td><td>2030/10/04</td></tr><tr><td>利用金額</td><td>&yen;500</td></tr></table></body></html>',
    }),
    2000,
  );
  assert.equal((await run.run(target)).recorded, 2);
  assert.deepEqual(await amounts(fixture), [500, 2420]);
  // 確かめ済みの行が消えて（同期の作り直しなど）もう一度読んでも、出所の鍵で二つ目を作らない。
  fixture.db.prepare('DELETE FROM household_mail_checks').run();
  assert.deepEqual(await run.run(target), {
    outcome: 'done',
    reason: null,
    baseline: false,
    checked: 1,
    recorded: 0,
  });
  assert.deepEqual(await amounts(fixture), [500, 2420]);
});

test('メールの読み取りに失敗したら止め、そのメールは確かめ済みにせず次の公開の後にやり直す', async (t) => {
  const fixture = setup(t);
  const run = intake(fixture);
  await run.run(target);
  storeMail(fixture, message('m-1', { text: USAGE }), 2000);
  fixture.failOn = 'm-1';
  assert.deepEqual(await run.run(target), {
    outcome: 'stopped',
    reason: 'read_failed',
    baseline: false,
    checked: 0,
    recorded: 0,
  });
  fixture.failOn = null;
  assert.equal((await run.run(target)).recorded, 1);
});

test('Microsoft の接続・読み取りの口や鍵がないときは読まない', async (t) => {
  const fixture = setup(t);
  assert.equal(
    (
      await intake(fixture).run({
        ...target,
        connection: {
          connection_id: 'c-1',
          provider: 'microsoft',
        } as ConnectionRecord,
      })
    ).reason,
    'provider_unsupported',
  );
  const noKey = createHouseholdMailIntake({
    store: fixture.client,
    gmailFor: () => ({}) as GoogleGmailReader,
    dataKey: () => Promise.resolve(null),
    timeZone: () => 'Asia/Tokyo',
  });
  assert.equal((await noKey.run(target)).reason, 'key_unavailable');
  const noReader = createHouseholdMailIntake({
    store: fixture.client,
    gmailFor: () => null,
    dataKey: () => Promise.resolve(fixture.dataKey),
    timeZone: () => 'Asia/Tokyo',
  });
  assert.equal((await noReader.run(target)).reason, 'reader_unavailable');
});

test('掃除のゲートが閉じている・貸し出しが取れないときは読まず、取れたら読み終えてから返す', async (t) => {
  const fixture = setup(t);
  let reads = 0;
  const counting = {
    getMessage: () => {
      reads += 1;
      return Promise.reject(new Error('読まないはず'));
    },
  } as unknown as GoogleGmailReader;
  const closed = { search: false, auto_use: false } as StartupGateDecision;
  const open = { search: true, auto_use: true } as StartupGateDecision;
  const gated = (gate: StartupGateDecision, lease: () => (() => void) | null) =>
    createHouseholdMailIntake({
      store: fixture.client,
      gmailFor: () => counting,
      dataKey: () => Promise.resolve(fixture.dataKey),
      timeZone: () => 'Asia/Tokyo',
      retention: { ready: () => Promise.resolve(), gate: () => gate, lease },
    });
  assert.equal(
    (await gated(closed, () => () => undefined).run(target)).reason,
    'retention_closed',
  );
  assert.equal(
    (await gated(open, () => null).run(target)).reason,
    'retention_closed',
  );
  assert.equal(reads, 0);
  let released = 0;
  const done = await gated(open, () => () => {
    released += 1;
  }).run(target);
  // 初回は基準を作るだけで、メールは読まない。貸し出しは一度返す。
  assert.equal(done.outcome, 'done');
  assert.equal(done.baseline, true);
  assert.equal(released, 1);
  assert.equal(reads, 0);
});

test('見出し・本文・日付の補助: 一番上の認証結果だけ、text/plain を優先、HTML の表を行に、受信日は本人のタイムゾーン', () => {
  assert.deepEqual(gmailAuthenticationResults(message('a', {})), [PASS]);
  assert.deepEqual(
    gmailAuthenticationResults(
      message('b', { auth: ['other.invalid; dmarc=pass', PASS] }),
    ),
    [],
  );
  assert.equal(
    gmailNoticeText(message('c', { text: 'plain', html: '<p>html</p>' })),
    'plain',
  );
  assert.equal(
    gmailNoticeText(message('d', { html: '<p>a&lt;b</p><p>&#x5408;成</p>' })),
    'a<b\n合成\n',
  );
  assert.equal(gmailNoticeText(message('e', {})), null);
  assert.equal(
    householdHtmlToText('<tr><td>利用金額</td><td>1,000円</td></tr>'),
    '利用金額 1,000円\n',
  );
  // 2030-10-04T16:00Z は東京では 10 月 5 日。
  assert.equal(
    householdLocalDate(Date.parse('2030-10-04T16:00:00Z'), 'Asia/Tokyo'),
    '2030-10-05',
  );
  assert.equal(
    householdLocalDate(Date.parse('2030-10-04T16:00:00Z'), 'UTC'),
    '2030-10-04',
  );
});
