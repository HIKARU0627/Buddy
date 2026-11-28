// 記録しない会話の独立した確認を画面に出して承認を受ける経路（ADR 0197、U503）の試験。製品の Core の HTTPS（127.0.0.1・
// 模擬の鍵）、解釈は模擬、provider は合成の読み書きの口（対象のメールのラベル・件名・差出人を持ち、変更のたびに版を 1 つ進める）。
// 確認の画面の口は試験の組み立てだけが開く（製品は閉じたまま）。
// 期待値（状態・件数・応答の欄・理由）は ADR 0045・0192・0197 から手で書いた値。内容の hash は、この試験の中のキーを並べ替える
// JSON と SHA-256 で別に求め、実装の関数から作らない。目印は試験の回ごとに作る合成の ASCII。模擬の試験だけで、実機・実 API は
// 未実施。

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { openWriteConnection, storagePlatform } from '@buddy/storage';
import { pinnedRequest, sharedApiContract } from './api-test-support.js';
import type { TestDevice } from './api-test-support.js';
import { bearer, insertDevice, startEventCore } from './event-test-support.js';
import type { EventCore, MutableEnvironment } from './event-test-support.js';
import { DB_FILE } from './paths.js';
import type {
  ProviderMailTarget,
  ProviderReader,
  ProviderWriter,
} from './turn-ports.js';

const contract = sharedApiContract();
const CLOCK = new Date('2026-10-05T09:00:00+09:00');
const ACCOUNT = '00000000-0000-4000-8000-000000000002';
const ACCOUNT_LABEL = 'synthetic-account';
const MAIL = 'mail-001';
const SUBJECT = 'B06-SYNTH 合成の件名';
const SENDER = 'sender@example.invalid';
const RECEIVED = '2026-10-04T08:00:00Z';
const MAIL_CANDIDATE = '00000000-0000-4000-8000-0000000000c1';

interface FakeMail {
  labels: string[];
  revision: number;
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
    subject: SUBJECT,
    sender: SENDER,
    received_at: RECEIVED,
  });
  return {
    reader: {
      connection: () =>
        Promise.resolve({
          provider: 'mock',
          account_id: ACCOUNT,
          account_label: ACCOUNT_LABEL,
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
                permission_revision: '1',
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

interface Client {
  readonly device: TestDevice;
  readonly scope: string;
}

interface Rig {
  readonly core: EventCore;
  readonly env: MutableEnvironment;
  readonly a: Client;
  readonly b: Client;
  readonly mail: FakeMail;
}

async function startRig(
  t: test.TestContext,
  options: { readonly open?: boolean } = {},
): Promise<Rig> {
  const mail: FakeMail = { labels: ['inbox'], revision: 1, changes: [] };
  const ports = fakeProvider(mail);
  const env: MutableEnvironment = { home: true, lock: 'unlocked' };
  const core = await startEventCore(t, {
    now: () => CLOCK,
    env,
    turns: {
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
  const client = async (): Promise<Client> => {
    const device = await insertDevice(core.handle.store);
    const boot = await pinnedRequest(core.target, {
      method: 'GET',
      path: '/v1/bootstrap',
      headers: bearer(device.token),
    });
    assert.equal(boot.status, 200, boot.text);
    return { device, scope: String(boot.json?.['command_scope_id']) };
  };
  return { core, env, a: await client(), b: await client(), mail };
}

const switchMode = async (rig: Rig, storageMode: 'normal' | 'private') => {
  const response = await pinnedRequest(rig.core.target, {
    method: 'POST',
    path: '/v1/stream/storage-mode',
    headers: {
      ...bearer(rig.a.device.token),
      'content-type': 'application/json',
      'buddy-input-origin': 'screen',
    },
    body: JSON.stringify({
      request_id: randomUUID(),
      command_scope_id: rig.a.scope,
      storage_mode: storageMode,
    }),
  });
  assert.equal(response.status, 200, response.text);
};

const say = async (rig: Rig, client: Client, text: string) => {
  const response = await pinnedRequest(rig.core.target, {
    method: 'POST',
    path: '/v1/stream/turns',
    headers: {
      ...bearer(client.device.token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      request_id: randomUUID(),
      command_scope_id: client.scope,
      text,
      input_kind: 'text',
      expected_canvas_revision: '0',
    }),
  });
  assert.equal(response.status, 200, response.text);
  return response.json as Record<string, unknown>;
};

const list = async (rig: Rig, client: Client) => {
  const response = await pinnedRequest(rig.core.target, {
    method: 'GET',
    path: '/v1/private-confirmations',
    headers: bearer(client.device.token),
  });
  if (response.status === 200)
    assert(
      contract.valid('PrivateConfirmationList', response.json),
      response.text,
    );
  return response;
};

const decide = async (
  rig: Rig,
  client: Client,
  action: 'approve' | 'decline',
  confirmationId: string,
  body: Record<string, unknown>,
  origin = 'screen',
) => {
  const response = await pinnedRequest(rig.core.target, {
    method: 'POST',
    path: `/v1/private-confirmations/${confirmationId}/${action}`,
    headers: {
      ...bearer(client.device.token),
      'content-type': 'application/json',
      'buddy-input-origin': origin,
    },
    body: JSON.stringify({ command_scope_id: client.scope, ...body }),
  });
  if (response.status === 202)
    assert(
      contract.valid('PrivateConfirmationResult', response.json),
      response.text,
    );
  return response;
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

// 操作の記録の行数（操作・承認）。
const recorded = (rig: Rig) =>
  sql(rig, (db) => ({
    operations: Number(
      (
        db.prepare('SELECT count(*) AS n FROM operations').get() as {
          n: number;
        }
      ).n,
    ),
    approvals: Number(
      (db.prepare('SELECT count(*) AS n FROM approvals').get() as { n: number })
        .n,
    ),
  }));

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

// 発言で確認を 1 件作り、確認の ID を返す（応答の item_refs）。
const ask = async (rig: Rig, client: Client, label: string) => {
  const answered = await say(rig, client, `${MAIL} に ${label} を付けて`);
  const refs = (answered['result_view'] as Record<string, unknown>)[
    'item_refs'
  ] as { kind: string; id: string }[];
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.kind, 'private_confirmation');
  return refs[0]?.id as string;
};

test('the requesting device sees only what to change, approves once by screen, and the minimal record runs the external change exactly once', async (t) => {
  const rig = await startRig(t);
  const label = marker();
  await switchMode(rig, 'private');
  const before = recorded(rig);
  const confirmationId = await ask(rig, rig.a, label);

  // 一覧は頼んだ端末の確認だけで、画面で承認に要る値だけ。区切りの ID・世代・操作の ID・発言は返さない。
  const internal = rig.core.handle.privateConfirmations?.list()[0];
  assert(internal !== undefined);
  const operation = {
    schema: 'buddy.operation.v1',
    operation_id: internal.view.operation.operation_id,
    content_version: '1',
    permission_revision: '1',
    provider: 'mock',
    account_id: ACCOUNT,
    target: { remote_id: MAIL, source_revision: 'r1' },
    action: { kind: 'mail.labels.change', add: [label], remove: [] },
    effects: { external_recipients: [], reconcile_scope: 'exact_target' },
  };
  const hash = sha256(canonical(operation));
  const listed = await list(rig, rig.a);
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(listed.json, {
    confirmations: [
      {
        confirmation_id: confirmationId,
        intent: 'label_mail',
        service: 'mock',
        account_label: ACCOUNT_LABEL,
        target: { subject: SUBJECT, sender: SENDER, received_at: RECEIVED },
        add: [label],
        remove: [],
        content_version: '1',
        content_hash: hash,
        conversation_saved: false,
      },
    ],
  });
  assert(!listed.text.includes(internal.segment_generation + '"'));
  assert(!listed.text.includes(operation.operation_id));
  // 他の端末には出さない（U600）。
  assert.deepEqual((await list(rig, rig.b)).json, { confirmations: [] });

  const approval = {
    request_id: randomUUID(),
    content_version: '1',
    content_hash: hash,
  };
  // 他の端末からの承認・声の起点・内容の違う承認・古い版は通らない（記録も外部変更も作らない）。
  assert.equal(
    (await decide(rig, rig.b, 'approve', confirmationId, approval)).status,
    409,
  );
  const voice = await decide(
    rig,
    rig.a,
    'approve',
    confirmationId,
    { ...approval, request_id: randomUUID() },
    'voice',
  );
  assert.equal(voice.status, 403);
  assert.equal(voice.json?.['code'], 'screen_operation_required');
  assert.equal(
    (
      await decide(rig, rig.a, 'approve', confirmationId, {
        ...approval,
        request_id: randomUUID(),
        content_hash: 'f'.repeat(64),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await decide(rig, rig.a, 'approve', confirmationId, {
        ...approval,
        request_id: randomUUID(),
        content_version: '2',
      })
    ).status,
    409,
  );
  // 本文で端末を名乗る承認は形の違い（422）。
  assert.equal(
    (
      await decide(rig, rig.a, 'approve', confirmationId, {
        ...approval,
        request_id: randomUUID(),
        device_id: rig.b.device.device.device_id,
      })
    ).status,
    422,
  );
  assert.deepEqual(recorded(rig), before);
  assert.deepEqual(rig.mail.changes, []);

  // 頼んだ端末の画面の一度の承認で、最小の操作記録を書き、外部の変更を 1 回だけ行う。
  const approved = await decide(
    rig,
    rig.a,
    'approve',
    confirmationId,
    approval,
  );
  assert.equal(approved.status, 202, approved.text);
  assert.deepEqual(approved.json, {
    request_id: approval.request_id,
    confirmation_id: confirmationId,
    result: 'recorded',
  });
  await rig.core.handle.runner?.idle();
  assert.deepEqual(rig.mail.changes, [{ add: [label], remove: [] }]);
  assert.deepEqual(recorded(rig), {
    operations: before.operations + 1,
    approvals: before.approvals + 1,
  });
  assert.deepEqual(
    sql(rig, (db) => ({
      ...(db
        .prepare(
          'SELECT record_kind, workflow_id, state FROM operations WHERE operation_id = ?',
        )
        .get(operation.operation_id) as object),
    })),
    { record_kind: 'private_minimal', workflow_id: null, state: 'succeeded' },
  );
  // 承認の端末は認証した要求の端末（U503）。
  assert.equal(
    sql(
      rig,
      (db) =>
        (
          db
            .prepare('SELECT device_id FROM approvals WHERE operation_id = ?')
            .get(operation.operation_id) as { device_id: string }
        ).device_id,
    ),
    rig.a.device.device.device_id,
  );
  assert.deepEqual((await list(rig, rig.a)).json, { confirmations: [] });

  // 同じ要求の再送は同じ応答。別の request_id の二重の承認も最初の結果で、記録も外部変更も増えない。
  const resent = await decide(rig, rig.a, 'approve', confirmationId, approval);
  assert.equal(resent.status, 202);
  assert.deepEqual(resent.json, approved.json);
  const again = await decide(rig, rig.a, 'approve', confirmationId, {
    ...approval,
    request_id: randomUUID(),
  });
  assert.equal(again.status, 202);
  assert.equal(again.json?.['result'], 'recorded');
  // 同じ request_id で内容が違えば 409。承認した確認は断れない。他の端末の二重の承認も通らない。
  assert.equal(
    (
      await decide(rig, rig.a, 'approve', confirmationId, {
        ...approval,
        content_hash: 'e'.repeat(64),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await decide(rig, rig.a, 'decline', confirmationId, {
        request_id: randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await decide(rig, rig.b, 'approve', confirmationId, {
        ...approval,
        request_id: randomUUID(),
      })
    ).status,
    409,
  );
  await rig.core.handle.runner?.idle();
  assert.equal(rig.mail.changes.length, 1);
  assert.equal(recorded(rig).operations, before.operations + 1);

  // 記録しない会話を出た後の承認は通らない（確認も控えも捨てた）。
  await switchMode(rig, 'normal');
  assert.equal(
    (
      await decide(rig, rig.a, 'approve', confirmationId, {
        ...approval,
        request_id: randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal(rig.mail.changes.length, 1);
});

test('a decline, a lock report and leaving drop the confirmation; later approvals are refused and nothing is recorded or sent', async (t) => {
  const rig = await startRig(t);
  await switchMode(rig, 'private');
  const before = recorded(rig);
  const hashOf = async (client: Client) => {
    const listed = await list(rig, client);
    const first = (
      listed.json?.['confirmations'] as Record<string, unknown>[]
    )[0];
    assert(first !== undefined, listed.text);
    return String(first['content_hash']);
  };

  // 1. 断る。他の端末からは断れない。断った確認への再送は declined、後の承認は 409。
  const declinedId = await ask(rig, rig.a, marker());
  const declinedHash = await hashOf(rig.a);
  assert.equal(
    (
      await decide(rig, rig.b, 'decline', declinedId, {
        request_id: randomUUID(),
      })
    ).status,
    409,
  );
  const declined = await decide(rig, rig.a, 'decline', declinedId, {
    request_id: randomUUID(),
  });
  assert.equal(declined.status, 202, declined.text);
  assert.equal(declined.json?.['result'], 'declined');
  const declinedAgain = await decide(rig, rig.a, 'decline', declinedId, {
    request_id: randomUUID(),
  });
  assert.equal(declinedAgain.json?.['result'], 'declined');
  assert.equal(
    (
      await decide(rig, rig.a, 'approve', declinedId, {
        request_id: randomUUID(),
        content_version: '1',
        content_hash: declinedHash,
      })
    ).status,
    409,
  );

  // 2. ロックの申告: ロック中は一覧も承認も 403、ロックで取り下げた確認は解除後も承認できない。
  const lockedId = await ask(rig, rig.a, marker());
  const lockedHash = await hashOf(rig.a);
  rig.env.lock = 'locked';
  const hidden = await list(rig, rig.a);
  assert.equal(hidden.status, 403);
  assert.equal(hidden.json?.['code'], 'device_locked');
  const whileLocked = await decide(rig, rig.a, 'approve', lockedId, {
    request_id: randomUUID(),
    content_version: '1',
    content_hash: lockedHash,
  });
  assert.equal(whileLocked.status, 403);
  rig.env.lock = 'unlocked';
  assert.deepEqual((await list(rig, rig.a)).json, { confirmations: [] });
  assert.equal(
    (
      await decide(rig, rig.a, 'approve', lockedId, {
        request_id: randomUUID(),
        content_version: '1',
        content_hash: lockedHash,
      })
    ).status,
    409,
  );

  // 3. 承認の前に記録しない会話を出て入り直す: 古い確認への承認は通らない。
  const leftId = await ask(rig, rig.a, marker());
  const leftHash = await hashOf(rig.a);
  await switchMode(rig, 'normal');
  await switchMode(rig, 'private');
  assert.deepEqual((await list(rig, rig.a)).json, { confirmations: [] });
  assert.equal(
    (
      await decide(rig, rig.a, 'approve', leftId, {
        request_id: randomUUID(),
        content_version: '1',
        content_hash: leftHash,
      })
    ).status,
    409,
  );

  // どの場合も操作の記録は増えず、外部へも送っていない。
  assert.deepEqual(recorded(rig), before);
  assert.deepEqual(rig.mail.changes, []);
});

test('with the screen gate closed the list is empty and approvals are refused', async (t) => {
  const rig = await startRig(t, { open: false });
  await switchMode(rig, 'private');
  const answered = await say(rig, rig.a, `${MAIL} に ${marker()} を付けて`);
  assert.equal(answered['status'], 'clarification');
  const listed = await list(rig, rig.a);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json, { confirmations: [] });
  assert.equal(
    (
      await decide(rig, rig.a, 'approve', randomUUID(), {
        request_id: randomUUID(),
        content_version: '1',
        content_hash: 'a'.repeat(64),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await decide(rig, rig.a, 'decline', randomUUID(), {
        request_id: randomUUID(),
      })
    ).status,
    409,
  );
  assert.deepEqual(rig.mail.changes, []);
});
