// 記録しない会話の独立した確認と最小の操作記録（B06-07a-2 の 2d、ADR 0192）の試験。Core は同じプロセスの startCore（HTTPS は
// 127.0.0.1、鍵は模擬の KeyStore）、解釈は模擬（モデルを使わない）、provider は合成の読み書きの口（対象のメールのラベルを
// 持ち、変更のたびに版を 1 つ進める）。独立した確認の口は試験の組み立てだけが開く（製品は閉じたまま。U503）。
// 期待値（状態・件数・文・理由・確定済みの変更・内容の hash）は ADR 0045 の確認の中身と最小の操作記録、0010 の制約、
// ADR 0192 から手で書いた値。内容の hash は、この試験の中のキーを並べ替える JSON と SHA-256 で別に求め、実装の関数から
// 作らない。目印は試験の回ごとに作る合成の ASCII。模擬の試験だけで、実機・実 API は未実施。

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { StreamTurnResponse } from '@buddy/contracts';
import { openWriteConnection, storagePlatform } from '@buddy/storage';
import { pinnedRequest, sharedApiContract } from './api-test-support.js';
import type { TestDevice } from './api-test-support.js';
import { API_ROUTES } from './api-routes.js';
import { createTurnRoutes } from './api-turns.js';
import type { TurnRouteStore } from './api-turns.js';
import {
  DATA_KEY_MATERIAL,
  bearer,
  insertDevice,
  startEventCore,
} from './event-test-support.js';
import type { EventCore, MutableEnvironment } from './event-test-support.js';
import { DB_FILE } from './paths.js';
import { PRIVATE_CONFIRMATION_SCREEN_OPEN } from './private-confirmations.js';
import type { PrivateConfirmationHandle } from './core.js';
import { PreviewRegistry } from './previews.js';
import { TEST_TURN_POLICY, createMockInterpreter } from './turn-ports.js';
import type {
  InterpretationContext,
  Interpreter,
  ProviderMailTarget,
  ProviderReader,
  ProviderWriter,
} from './turn-ports.js';
import { A, SCOPE_A } from './voice-rig-test-support.js';

const contract = sharedApiContract();
const CLOCK = new Date('2026-10-05T09:00:00+09:00');
const ACCOUNT = '00000000-0000-4000-8000-000000000002';
const MAIL = 'mail-001';
const MAIL_CANDIDATE = '00000000-0000-4000-8000-0000000000c1';

// 手で写した決まった文（api-turns.ts の文）。
const PRIVATE_UNSUPPORTED =
  '記録しない会話では、この依頼はまだ受け付けられません。記録しない会話を終えてから、もう一度お願いします。';
const PRIVATE_CONFIRMATION =
  '記録しない会話なので、この変更は確認の画面で一度承認してから行います。会話の内容は保存しません。';
const BLOCKED = '今は進められません。少し待ってからもう一度お願いします。';

// 合成の提供元。対象のメールのラベルを持ち、ラベルの変更を受けるたびに版を 1 つ進める。
interface FakeMail {
  labels: string[];
  revision: number;
  // 許可の版（試験の途中で変える）。
  permission: string;
  readonly changes: { add: readonly string[]; remove: readonly string[] }[];
}

function fakeProvider(mail: FakeMail): {
  reader: ProviderReader;
  writer: ProviderWriter;
} {
  const target = (): ProviderMailTarget => ({
    remote_id: MAIL,
    source_revision: `r${mail.revision}`,
    mailbox: 'inbox',
    labels: [...mail.labels],
  });
  return {
    reader: {
      connection: () =>
        Promise.resolve({
          provider: 'mock',
          account_id: ACCOUNT,
          status: 'active',
          access: 'read_write',
          writable_kinds: ['mail.labels.change', 'mail.draft.create'],
          readable_kinds: ['mail.message'],
        }),
      readPermission: (accountId) =>
        Promise.resolve(
          accountId === ACCOUNT
            ? {
                account_id: ACCOUNT,
                permission_revision: mail.permission,
                scopes: ['mail.read', 'mail.labels.change'],
              }
            : null,
        ),
      readTarget: (remoteId) =>
        Promise.resolve(remoteId === MAIL ? target() : null),
      listEvents: () => Promise.resolve([]),
    },
    writer: {
      changeLabels: (_identity, change) => {
        mail.changes.push({ add: change.add, remove: change.remove });
        mail.labels = [
          ...mail.labels.filter((label) => !change.remove.includes(label)),
          ...change.add.filter((label) => !mail.labels.includes(label)),
        ];
        mail.revision += 1;
        return Promise.resolve({
          kind: 'applied',
          status: 200,
          value: target(),
        });
      },
    },
  };
}

interface Rig {
  readonly core: EventCore;
  readonly device: TestDevice;
  readonly scope: string;
  readonly mail: FakeMail;
  readonly logs: string[];
  readonly desk: PrivateConfirmationHandle;
}

async function startRig(
  t: test.TestContext,
  options: {
    readonly open?: boolean;
    readonly env?: MutableEnvironment;
    readonly interpreter?: Interpreter;
  } = {},
): Promise<Rig> {
  const mail: FakeMail = {
    labels: ['inbox'],
    revision: 1,
    permission: '1',
    changes: [],
  };
  const ports = fakeProvider(mail);
  const logs: string[] = [];
  const core = await startEventCore(t, {
    now: () => CLOCK,
    log: (message) => logs.push(String(message)),
    ...(options.env === undefined ? {} : { env: options.env }),
    turns: {
      ...(options.interpreter === undefined
        ? {}
        : { interpreter: options.interpreter }),
      provider: ports.reader,
      writer: ports.writer,
      candidates: {
        mailCandidates: () =>
          Promise.resolve([{ candidate_id: MAIL_CANDIDATE, remote_id: MAIL }]),
      },
      utcOffset: '+09:00',
      ...(options.open === false
        ? {}
        : { privateConfirmationScreen: () => true }),
    },
  });
  const device = await insertDevice(core.handle.store);
  const boot = await pinnedRequest(core.target, {
    method: 'GET',
    path: '/v1/bootstrap',
    headers: bearer(device.token),
  });
  assert.equal(boot.status, 200, boot.text);
  const desk = core.handle.privateConfirmations;
  assert(desk !== null);
  return {
    core,
    device,
    scope: String(boot.json?.['command_scope_id']),
    mail,
    logs,
    desk,
  };
}

const say = async (rig: Rig, text: string) => {
  const response = await pinnedRequest(rig.core.target, {
    method: 'POST',
    path: '/v1/stream/turns',
    headers: {
      ...bearer(rig.device.token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      request_id: randomUUID(),
      command_scope_id: rig.scope,
      text,
      input_kind: 'text',
      expected_canvas_revision: '0',
    }),
  });
  assert.equal(response.status, 200, response.text);
  assert(contract.valid('StreamTurnResponse', response.json), response.text);
  return response.json as unknown as StreamTurnResponse;
};

const switchMode = async (rig: Rig, storageMode: 'normal' | 'private') => {
  const response = await pinnedRequest(rig.core.target, {
    method: 'POST',
    path: '/v1/stream/storage-mode',
    headers: {
      ...bearer(rig.device.token),
      'content-type': 'application/json',
      'buddy-input-origin': 'screen',
    },
    body: JSON.stringify({
      request_id: randomUUID(),
      command_scope_id: rig.scope,
      storage_mode: storageMode,
    }),
  });
  assert.equal(response.status, 200, response.text);
};

const sql = <T>(
  rig: Rig,
  body: (db: ReturnType<typeof openWriteConnection>) => T,
): T => {
  const db = openWriteConnection(join(rig.core.dataDir, DB_FILE), {
    platform: storagePlatform(),
  });
  try {
    return body(db);
  } finally {
    db.close();
  }
};

// DB のすべての表の行数（sqlite_master から表を数え直す）。
const countRows = (rig: Rig): Record<string, number> =>
  sql(rig, (db) =>
    Object.fromEntries(
      (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((row) => [
        row.name,
        Number(
          (
            db.prepare(`SELECT count(*) AS n FROM "${row.name}"`).get() as {
              n: number;
            }
          ).n,
        ),
      ]),
    ),
  );

// 行数が変わった表と、その増えた数。
const grown = (
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> =>
  Object.fromEntries(
    Object.keys(after)
      .filter((table) => after[table] !== before[table])
      .map((table) => [table, (after[table] ?? 0) - (before[table] ?? 0)]),
  );

// データディレクトリの全ファイルとログから、目印の平文を探す（ADR 0190 の試験と同じ考え方）。
const residue = (rig: Rig, needle: string): string[] => {
  const value = Buffer.from(needle, 'utf8');
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && readFileSync(path).indexOf(value) >= 0)
        found.push(name);
    }
  };
  walk(rig.core.dataDir);
  if (rig.logs.join('\n').includes(needle)) found.push('logs');
  return found;
};

// 内容の hash を実装とは別に求める（キーを並べ替えた区切りのない JSON。値は文字列・配列・物だけ）と SHA-256。
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : typeof value === 'object' && value !== null
      ? `{${Object.keys(value)
          .sort()
          .map(
            (key) =>
              `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
          )
          .join(',')}}`
      : JSON.stringify(value);
const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

const marker = () => `B06-SYNTH-label-${randomUUID().slice(0, 8)}`;

// 承認の入力（画面が見た確認の値をそのまま返す）。
const approvalOf = (
  rig: Rig,
  entry: ReturnType<PrivateConfirmationHandle['list']>[number],
) => ({
  confirmation_id: entry.confirmation_id,
  device_id: rig.device.device.device_id,
  segment_generation: entry.segment_generation,
  operation_id: entry.view.operation.operation_id,
  content_version: entry.view.operation.content_version,
  content_hash: entry.view.content_hash,
});

test('the product keeps the independent confirmation closed', () => {
  assert.equal(PRIVATE_CONFIRMATION_SCREEN_OPEN, false);
});

test('a label change in a private conversation becomes an independent confirmation in RAM; one screen approval writes only the minimal record, which the runner executes once', async (t) => {
  const rig = await startRig(t);
  const label = marker();
  await switchMode(rig, 'private');
  const before = countRows(rig);

  const asked = await say(rig, `${MAIL} に ${label} を付けて`);
  assert.equal(asked.segment.storage_mode, 'private');
  assert.equal(asked.status, 'answered');
  assert.equal(asked.reply_text, PRIVATE_CONFIRMATION);
  assert.equal(asked.result_view?.kind, 'approval_link');
  assert.equal(asked.result_view?.status, 'needs_review');
  assert.equal(asked.canvas, null);
  const listed = rig.desk.list();
  assert.equal(listed.length, 1);
  const entry = listed[0];
  assert(entry !== undefined);
  assert.deepEqual(asked.result_view?.item_refs, [
    { kind: 'private_confirmation', id: entry.confirmation_id },
  ]);
  // 確認の中身: Core が解決した確定済みの変更と内容の hash と「会話の内容は保存されない」こと。区切りの世代は入って 1 進めた値。
  const operationId = entry.view.operation.operation_id;
  const operation = {
    schema: 'buddy.operation.v1',
    operation_id: operationId,
    content_version: '1',
    permission_revision: '1',
    provider: 'mock',
    account_id: ACCOUNT,
    target: { remote_id: MAIL, source_revision: 'r1' },
    action: { kind: 'mail.labels.change', add: [label], remove: [] },
    effects: { external_recipients: [], reconcile_scope: 'exact_target' },
  };
  assert.deepEqual(entry.view, {
    intent: 'label_mail',
    operation,
    content_hash: sha256(canonical(operation)),
    conversation_saved: false,
  });
  assert.equal(
    entry.segment_generation,
    rig.core.handle.storage.origin().segment_generation,
  );
  // 確認を出しただけでは、DB に 1 行も書かず、外部へも送らない。
  assert.deepEqual(countRows(rig), before);
  assert.deepEqual(rig.mail.changes, []);
  assert.deepEqual(rig.desk.held(), { pending: 1, decided: 0 });

  // 内容の hash が違う承認は通らない（記録も外部変更も作らない）。
  const wrong = await rig.desk.approve({
    ...approvalOf(rig, entry),
    content_hash: 'f'.repeat(64),
  });
  assert.deepEqual(wrong, {
    kind: 'refused',
    reason: 'approval_mismatch',
    errors: ['content_hash_mismatch'],
  });
  assert.deepEqual(countRows(rig), before);

  // 画面での一度の承認で、最小の操作記録を書いて実行担当へ渡す。
  const approved = await rig.desk.approve(approvalOf(rig, entry));
  assert.deepEqual(approved, { kind: 'recorded', operation_id: operationId });
  await rig.core.handle.runner?.idle();
  assert.deepEqual(rig.mail.changes, [{ add: [label], remove: [] }]);
  assert.deepEqual(rig.desk.list(), []);
  assert.deepEqual(rig.desk.held(), { pending: 0, decided: 1 });

  // 書いた先は操作の記録だけ（操作・内容版・承認・試行・暗号文・受付・イベント）。発言・依頼・入力・応答・記憶・影モードは
  // 1 行も増えない。
  const added = grown(before, countRows(rig));
  assert.deepEqual(
    Object.keys(added)
      .filter(
        (table) =>
          ![
            'operations',
            'operation_versions',
            'approvals',
            'operation_attempts',
            'operation_steps',
            'sealed_blobs',
            'command_receipts',
            'event_outbox',
          ].includes(table),
      )
      .sort(),
    [],
  );
  assert.equal(added['operations'], 1);
  assert.equal(added['operation_versions'], 1);
  assert.equal(added['approvals'], 1);
  assert.equal(added['sealed_blobs'], 1);
  assert.deepEqual(
    sql(rig, (db) => ({
      ...(db
        .prepare(
          'SELECT workflow_id, kind, effect_route, state, record_kind FROM operations WHERE operation_id = ?',
        )
        .get(operationId) as object),
    })),
    {
      workflow_id: null,
      kind: 'mail.labels.change',
      effect_route: 'remote_mutation',
      state: 'succeeded',
      record_kind: 'private_minimal',
    },
  );
  assert.deepEqual(
    sql(rig, (db) => ({
      ...(db
        .prepare(
          'SELECT route, device_id, content_hash FROM approvals WHERE operation_id = ?',
        )
        .get(operationId) as object),
    })),
    {
      route: 'screen',
      device_id: rig.device.device.device_id,
      content_hash: sha256(canonical(operation)),
    },
  );
  // 画面の承認の preview_id は記録のために新しく作った値で、確認の ID（応答で端末へ返した値）ではない（U506）。
  const previewId = sql(
    rig,
    (db) =>
      (
        db
          .prepare('SELECT preview_id FROM approvals WHERE operation_id = ?')
          .get(operationId) as { preview_id: string }
      ).preview_id,
  );
  assert.match(previewId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/u);
  assert.notEqual(previewId, entry.confirmation_id);

  // 同じ承認の再送は、記録を書き直さずに最初の結果を返す（外部へも送り直さない）。
  const rows = countRows(rig);
  assert.deepEqual(await rig.desk.approve(approvalOf(rig, entry)), approved);
  await rig.core.handle.runner?.idle();
  assert.deepEqual(countRows(rig), rows);
  assert.equal(rig.mail.changes.length, 1);

  // ラベル（確定済みの変更の中身）は暗号化して置き、平文はデータディレクトリ（DB・WAL）にもログにもない。
  if (process.platform !== 'win32') assert.deepEqual(residue(rig, label), []);

  // 終えると承認の結果の控えも捨てる。終えた後の承認は、出た区切りの確認が無いので通らない（記録も外部変更も増えない）。
  await switchMode(rig, 'normal');
  assert.deepEqual(rig.desk.held(), { pending: 0, decided: 0 });
  const rowsAfterExit = countRows(rig);
  assert.deepEqual(await rig.desk.approve(approvalOf(rig, entry)), {
    kind: 'refused',
    reason: 'confirmation_not_found',
    errors: [],
  });
  assert.deepEqual(countRows(rig), rowsAfterExit);
  assert.equal(rig.mail.changes.length, 1);

  await rig.core.handle.stop('test');
  await rig.core.handle.closed;
  assert.deepEqual(residue(rig, label), []);
  // 確認の ID は DB（WAL を含む）・データディレクトリのどのファイルにもログにもない（操作から記録しない会話へたどれない）。
  assert.deepEqual(residue(rig, entry.confirmation_id), []);
});

test('leaving, a lock report or a decline before the approval drops the confirmation: a later approval writes nothing and sends nothing', async (t) => {
  const env: MutableEnvironment = { home: true, lock: 'unlocked' };
  const rig = await startRig(t, { env });
  await switchMode(rig, 'private');
  const before = countRows(rig);

  // 1. 取り下げ。
  await say(rig, `${MAIL} に ${marker()} を付けて`);
  const declined = rig.desk.list()[0];
  assert(declined !== undefined);
  assert.deepEqual(await rig.desk.decline(declined.confirmation_id), {
    ok: true,
  });
  assert.deepEqual(await rig.desk.approve(approvalOf(rig, declined)), {
    kind: 'refused',
    reason: 'confirmation_not_found',
    errors: [],
  });

  // 2. ロックの申告（記録しない区切りのまま、承認前の確認を取り下げる）。
  await say(rig, `${MAIL} に ${marker()} を付けて`);
  const locked = rig.desk.list()[0];
  assert(locked !== undefined);
  env.lock = 'locked';
  const refused = await pinnedRequest(rig.core.target, {
    method: 'GET',
    path: '/v1/stream/storage-mode',
    headers: bearer(rig.device.token),
  });
  assert.notEqual(refused.status, 200, refused.text);
  env.lock = 'unlocked';
  assert.deepEqual(rig.desk.list(), []);
  assert.equal(rig.core.handle.storage.privateConversation(), true);
  assert.deepEqual(await rig.desk.approve(approvalOf(rig, locked)), {
    kind: 'refused',
    reason: 'confirmation_not_found',
    errors: [],
  });
  assert.deepEqual(rig.desk.held(), { pending: 0, decided: 0 });

  // 3. 承認の前に記録しない会話を終える（確認は捨てる。U65）。入り直した後の古い承認も当たらない。
  await say(rig, `${MAIL} に ${marker()} を付けて`);
  const left = rig.desk.list()[0];
  assert(left !== undefined);
  await switchMode(rig, 'normal');
  assert.deepEqual(rig.desk.list(), []);
  await switchMode(rig, 'private');
  assert.deepEqual(await rig.desk.approve(approvalOf(rig, left)), {
    kind: 'refused',
    reason: 'confirmation_not_found',
    errors: [],
  });

  // どの場合も、操作の記録は 1 行も増えず、外部へも送っていない。増えたのは、記録しない会話から出た先の会話の行と、その
  // 作成の受付だけ（ADR 0060 の 2b）。
  assert.deepEqual(grown(before, countRows(rig)), {
    command_receipts: 1,
    sessions: 1,
  });
  assert.deepEqual(rig.mail.changes, []);
});

test('an approval from another segment generation, a malformed device or an unregistered device is refused, and a failed record is not retried', async (t) => {
  const rig = await startRig(t);
  await switchMode(rig, 'private');
  await say(rig, `${MAIL} に ${marker()} を付けて`);
  const entry = rig.desk.list()[0];
  assert(entry !== undefined);
  const before = countRows(rig);

  // 確認を出した世代と違う世代の承認。
  assert.deepEqual(
    await rig.desk.approve({
      ...approvalOf(rig, entry),
      segment_generation: String(BigInt(entry.segment_generation) + 1n),
    }),
    {
      kind: 'refused',
      reason: 'approval_mismatch',
      errors: ['segment_generation_mismatch'],
    },
  );
  // 形の違う端末の ID（承認の形の検査）。
  const malformed = await rig.desk.approve({
    ...approvalOf(rig, entry),
    device_id: 'not-a-device',
  });
  assert.equal(malformed.kind, 'refused');
  assert.equal(
    malformed.kind === 'refused' ? malformed.reason : '',
    'approval_invalid',
  );
  assert.deepEqual(countRows(rig), before);

  // 登録されていない端末の承認は、保存層が記録を断る。外部へは送らず、同じ承認の再送も書き直さない（U505）。
  const unknownDevice = await rig.desk.approve({
    ...approvalOf(rig, entry),
    device_id: randomUUID(),
  });
  assert.deepEqual(unknownDevice, {
    kind: 'record_failed',
    reasons: ['device_not_registered'],
  });
  assert.deepEqual(
    await rig.desk.approve(approvalOf(rig, entry)),
    unknownDevice,
  );
  await rig.core.handle.runner?.idle();
  assert.deepEqual(countRows(rig), before);
  assert.deepEqual(rig.mail.changes, []);
});

test('a reply draft is refused in a private conversation even with the confirmation open, and a closed confirmation refuses a label change without any confirmation', async (t) => {
  const open = await startRig(t);
  await switchMode(open, 'private');
  const before = countRows(open);
  const draft = await say(
    open,
    `${MAIL} に「合成の本文」と返信の下書きを保存して`,
  );
  assert.equal(draft.status, 'clarification');
  assert.equal(draft.reply_text, PRIVATE_UNSUPPORTED);
  assert.equal(draft.workflow_id, null);
  assert.deepEqual(open.desk.list(), []);
  assert.deepEqual(countRows(open), before);

  const closed = await startRig(t, { open: false });
  await switchMode(closed, 'private');
  const closedBefore = countRows(closed);
  const label = await say(closed, `${MAIL} に ${marker()} を付けて`);
  assert.equal(label.status, 'clarification');
  assert.equal(label.reply_text, PRIVATE_UNSUPPORTED);
  assert.deepEqual(closed.desk.list(), []);
  assert.deepEqual(closed.desk.held(), { pending: 0, decided: 0 });
  // 口が閉じていれば、操作・承認・受付を含めて DB の行は 1 行も増えない。
  const closedAfter = countRows(closed);
  assert.deepEqual(grown(closedBefore, closedAfter), {});
  assert.equal(closedAfter['operations'], 0);
  assert.equal(closedAfter['approvals'], 0);
  assert.equal(
    closedAfter['command_receipts'],
    closedBefore['command_receipts'],
  );
  assert.deepEqual(closed.mail.changes, []);
});

test('with the confirmation open, a label change in a normal segment stays a normal operation awaiting approval', async (t) => {
  const rig = await startRig(t);
  const response = await say(rig, `${MAIL} に ${marker()} を付けて`);
  assert.equal(response.segment.storage_mode, 'normal');
  assert.equal(response.result_view?.kind, 'approval_link');
  const ref = response.result_view?.item_refs[0];
  assert.equal(ref?.kind, 'operation');
  assert.deepEqual(rig.desk.list(), []);
  assert.deepEqual(
    sql(rig, (db) => ({
      ...(db
        .prepare(
          'SELECT state, record_kind, workflow_id IS NOT NULL AS has_workflow FROM operations WHERE operation_id = ?',
        )
        .get(ref?.id) as object),
    })),
    { state: 'awaiting_approval', record_kind: 'normal', has_workflow: 1 },
  );
});

test('two approvals of the same confirmation arriving at once write one minimal record and both get the same result', async (t) => {
  const rig = await startRig(t);
  await switchMode(rig, 'private');
  await say(rig, `${MAIL} に ${marker()} を付けて`);
  const entry = rig.desk.list()[0];
  assert(entry !== undefined);
  const [first, second] = await Promise.all([
    rig.desk.approve(approvalOf(rig, entry)),
    rig.desk.approve(approvalOf(rig, entry)),
  ]);
  const operationId = entry.view.operation.operation_id;
  assert.deepEqual(first, { kind: 'recorded', operation_id: operationId });
  assert.deepEqual(second, first);
  await rig.core.handle.runner?.idle();
  assert.equal(rig.mail.changes.length, 1);
  assert.equal(
    sql(
      rig,
      (db) =>
        (
          db
            .prepare(
              "SELECT count(*) AS n FROM operations WHERE record_kind = 'private_minimal'",
            )
            .get() as { n: number }
        ).n,
    ),
    1,
  );
});

test('a forget notice before the approval drops the confirmation and stays private; a later approval writes nothing and sends nothing', async (t) => {
  const rig = await startRig(t);
  await switchMode(rig, 'private');
  await say(rig, `${MAIL} に ${marker()} を付けて`);
  const entry = rig.desk.list()[0];
  assert(entry !== undefined);
  const before = countRows(rig);
  await rig.core.handle.notices.publish({
    schema: 'buddy.retention-notice.v1',
    notice_id: randomUUID(),
    occurred_at: '2026-10-05T00:00:00Z',
    kind: 'forgotten',
    reason: 'forgotten',
    forgetting_generation: '1',
    items: [{ item_kind: 'memory', item_id: randomUUID() }],
  });
  assert.deepEqual(rig.desk.list(), []);
  assert.equal(rig.core.handle.storage.privateConversation(), true);
  assert.deepEqual(await rig.desk.approve(approvalOf(rig, entry)), {
    kind: 'refused',
    reason: 'confirmation_not_found',
    errors: [],
  });
  assert.deepEqual(rig.desk.held(), { pending: 0, decided: 0 });
  assert.deepEqual(countRows(rig), before);
  assert.deepEqual(rig.mail.changes, []);
});

// 模擬の解釈の包み。決めた文では、解釈の途中で止めておく（その間に許可の版を変える）。
class HoldingInterpreter implements Interpreter {
  readonly #inner = createMockInterpreter();
  readonly #holds = new Map<
    string,
    { started: () => void; release: Promise<void> }
  >();

  hold(text: string): { started: Promise<void>; release: () => void } {
    let started: () => void = () => undefined;
    let release: () => void = () => undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#holds.set(text, { started, release: releasePromise });
    return { started: startedPromise, release };
  }

  async interpret(context: InterpretationContext) {
    const hold = this.#holds.get(context.text);
    if (hold !== undefined) {
      hold.started();
      await hold.release;
    }
    return this.#inner.interpret(context);
  }
}

test('the permission revision is taken when the private turn arrives: a change observed by another turn during the interpretation makes it a "cannot proceed now" clarification, not a confirmation', async (t) => {
  const interpreter = new HoldingInterpreter();
  const rig = await startRig(t, { interpreter });
  await switchMode(rig, 'private');
  const slow = `${MAIL} に ${marker()} を付けて`;
  const held = interpreter.hold(slow);
  const pending = say(rig, slow);
  await held.started;
  // 解釈の間に許可の版が変わり、別の発言の計画が新しい版を読む（Core の控えの値が 2 になる）。
  rig.mail.permission = '2';
  const other = await say(rig, `${MAIL} に ${marker()} を付けて`);
  assert.equal(other.status, 'clarification');
  assert.equal(other.reply_text, BLOCKED);
  held.release();
  // 先に届いた発言は、届いた時点の版（1）と確定の直前の版（2）が違うので進めない（通常の経路と同じ聞き返し）。
  const slowResponse = await pending;
  assert.equal(slowResponse.status, 'clarification');
  assert.equal(slowResponse.reply_text, BLOCKED);
  assert.equal(slowResponse.result_view?.kind, 'clarification');
  assert.deepEqual(rig.desk.list(), []);
  // 新しい版を読んだ後に届いた発言は確認になる（陽性の対照）。
  const after = await say(rig, `${MAIL} に ${marker()} を付けて`);
  assert.equal(after.reply_text, PRIVATE_CONFIRMATION);
  assert.equal(rig.desk.list().length, 1);
});

// 確認を出す間にロック・終えるがあった場合（保存境界の保持者の待ち行列の中で起きる出来事を、確認を出す口の中で起こす）。
// 発言の処理は DB に触れない（触れたら例外）。
test('a lock or leaving while the confirmation is being shown makes the turn 409 and declines that confirmation; without either the confirmation is answered', async () => {
  const PRIVATE_SEGMENT = '00000000-0000-4000-8000-00000000a002';
  const CONFIRMATION = '00000000-0000-4000-8000-00000000c0f1';
  const touched: string[] = [];
  const store = new Proxy(
    {},
    {
      get: (_target, property) => () => {
        touched.push(String(property));
        throw new Error('store_touched');
      },
    },
  ) as unknown as TurnRouteStore;
  const mail: FakeMail = {
    labels: ['inbox'],
    revision: 1,
    permission: '1',
    changes: [],
  };
  const storage = {
    mode: 'private' as 'normal' | 'private',
    generation: '2',
    origin() {
      return {
        segment_id: PRIVATE_SEGMENT,
        segment_generation: this.generation,
      };
    },
  };
  const declined: string[] = [];
  let during: () => void = () => undefined;
  const routes = createTurnRoutes({
    store,
    keyStore: {
      loadDataKey: () =>
        Promise.resolve({ ok: true as const, dataKey: DATA_KEY_MATERIAL }),
    },
    interpreter: createMockInterpreter(),
    provider: fakeProvider(mail).reader,
    candidates: {
      mailCandidates: () =>
        Promise.resolve([{ candidate_id: MAIL_CANDIDATE, remote_id: MAIL }]),
    },
    policy: TEST_TURN_POLICY,
    previews: new PreviewRegistry(),
    storage,
    utcOffset: '+09:00',
    now: () => CLOCK.getTime(),
    privateConfirmations: {
      open: () => true,
      desk: {
        request: () => {
          during();
          return Promise.resolve({
            ok: true as const,
            confirmation_id: CONFIRMATION,
            segment_generation: '2',
          });
        },
        decline: (id: string) => {
          declined.push(id);
          return Promise.resolve({ ok: true as const });
        },
      },
    },
  });
  await routes.prime();
  const route = API_ROUTES.find((entry) => entry.operationId === 'postTurn');
  assert(route !== undefined);
  const turn = () =>
    routes.handlers['postTurn']?.({
      route,
      device: A,
      body: {
        request_id: randomUUID(),
        command_scope_id: SCOPE_A,
        text: `${MAIL} に ${marker()} を付けて`,
        input_kind: 'text',
        origin: { segment_id: PRIVATE_SEGMENT, segment_generation: '2' },
      },
      params: { session_id: PRIVATE_SEGMENT },
      remoteAddress: '127.0.0.1',
      query: {},
      declaredLockState: 'unlocked',
    });

  // ロックの申告（記録しない区切りの中身を捨てる）が確認を出す間に起きた。
  during = () => routes.privateConversation.discard('locked');
  assert.equal((await turn())?.status, 409);
  assert.deepEqual(declined, [CONFIRMATION]);

  // 何も起きなければ確認として答える（陽性の対照）。
  during = () => undefined;
  const answered = await turn();
  assert.equal(answered?.status, 200);
  assert.deepEqual(
    (answered?.body as { result_view: { item_refs: unknown } }).result_view
      .item_refs,
    [{ kind: 'private_confirmation', id: CONFIRMATION }],
  );
  assert.deepEqual(declined, [CONFIRMATION]);

  // 記録しない会話を終えた（区切りの世代が進み、通常の区切りになった）。
  during = () => {
    storage.mode = 'normal';
    storage.generation = '3';
  };
  assert.equal((await turn())?.status, 409);
  assert.deepEqual(declined, [CONFIRMATION, CONFIRMATION]);
  assert.deepEqual(touched, []);
  assert.deepEqual(mail.changes, []);
});
