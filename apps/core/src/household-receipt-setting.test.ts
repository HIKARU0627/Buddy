// レシートの写真の読み取りの入・切の保存（ADR 0179）の試験。DB は一時ディレクトリに作り、保存の命令は同じプロセスで
// 実行する（worker の往復は保存層の試験で確かめている）。外部のモデルは模擬の読み取りの口だけで、実 API は呼ばない。
// 画像は合成の JPEG の頭だけ。期待値は ADR 0179 の判断（既定は切・入にすると起動し直しても入・版の照合・読み取りの口が
// なければ unavailable）から手で書いた。
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ModelUsage } from '@buddy/contracts';
import type { AdapterResult } from '@buddy/ai';
import { syntheticProfile } from '@buddy/ai/testing';
import {
  applyMigrations,
  executeHouseholdOp,
  initStoreGeneration,
  openWriteConnection,
} from '@buddy/storage';
import type {
  DbWorkerClient,
  HouseholdOp,
  SqliteDatabase,
} from '@buddy/storage';
import { onCleanup } from './api-test-support.js';
import { createApiContract } from './api-contract.js';
import { createHouseholdRoutes } from './api-household.js';
import type { ApiRouteHandler } from './api-server.js';
import { createHouseholdReceiptRoutes } from './household-receipt.js';
import type {
  ReceiptBudget,
  ReceiptImageReader,
  ReceiptReadingSetup,
} from './household-receipt.js';
import {
  memoryReceiptSettingStore,
  receiptSettingStoreOf,
} from './household-receipt-setting.js';
import type { ReceiptSettingStore } from './household-receipt-setting.js';
import type { JsonObject } from './strict-json.js';

type Json = Record<string, unknown>;
type Store = Pick<DbWorkerClient, 'household'>;

const STORE_GENERATION = '00000000-0000-4000-8000-0000000000aa';
// 2030-11-26 12:00（東京）。
const NOW = Date.parse('2030-11-26T03:00:00.000Z');
const ZONE = 'Asia/Tokyo';
const SCOPE = '00000000-0000-4000-8000-000000009002';
const contract = createApiContract();

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

function tempDir(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-receipt-setting-'));
  // 後入れ先出し: DB を閉じる後始末（後に登録）が、フォルダを消す後始末（先に登録）より先に動く（Windows は開いたままでは消せない）。
  onCleanup(t, () => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'buddy.db');
}

// DB を開く（中枢の起動に当たる）。閉じるのは呼び出し側。
function openDb(path: string): {
  readonly db: SqliteDatabase;
  readonly store: Store;
} {
  const db = openWriteConnection(path, { platform: 'macos' });
  applyMigrations(db);
  initStoreGeneration(db, STORE_GENERATION);
  const store = {
    household: (op: HouseholdOp) =>
      Promise.resolve(
        executeHouseholdOp(db, op, { platform: 'macos', halted: false }).result,
      ),
  } as unknown as Store;
  return { db, store };
}

const USAGE: ModelUsage = {
  input_tokens: 15,
  cached_input_tokens: 0,
  output_tokens: 5,
  reasoning_tokens: null,
  usage_complete: true,
};

// 合成の JPEG の頭（SOI・SOF0・SOS・EOI）。走査のデータは 0 で埋める。
function jpeg(width: number, height: number, size: number): Uint8Array {
  const be16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
  const bytes = [
    0xff,
    0xd8,
    0xff,
    0xc0,
    ...be16(17),
    8,
    ...be16(height),
    ...be16(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xda,
    ...be16(8),
    1,
    1,
    0,
    0,
    0x3f,
    0,
  ];
  const out = new Uint8Array(Math.max(size, bytes.length + 2));
  out.set(bytes);
  out.set([0xff, 0xd9], out.length - 2);
  return out;
}

const REPLY = JSON.stringify({
  readable: true,
  receipt_count: 1,
  currency: 'JPY',
  total: 1280,
  date: '2030-11-25',
  time: '12:34',
  merchant: '合成の商店',
  payment: '現金',
  items: [{ name: 'おにぎり', amount: 1280 }],
});

// 模擬の読み取りの口（送った回数だけを数える）。
class CountingReader implements ReceiptImageReader {
  sent = 0;
  read(): Promise<AdapterResult> {
    this.sent += 1;
    return Promise.resolve({
      kind: 'response',
      text: REPLY,
      usage: USAGE,
      provider_request_id: 'synthetic-request-1',
      refused: false,
      truncated: false,
    } as AdapterResult);
  }
}

// 模擬の予算の門。send を一度だけ呼ぶ。
const budget: ReceiptBudget = {
  async run(_requestId, send, signal) {
    if (signal.aborted) return { kind: 'released' };
    await send(signal);
    return { kind: 'settled' };
  },
};

const setupOf = (reader: ReceiptImageReader): ReceiptReadingSetup => ({
  reader,
  profile: syntheticProfile({
    profile_id: 'receipt.synthetic.v1',
    role: 'background_text',
    output_limit_tokens: 10,
  }),
  profile_revision: '1',
  price_key: 'synthetic.text',
  max_input_tokens: 20,
});

// 中枢の家計簿の経路を組み立てる（core.ts と同じく、入・切は家計簿の設定の行に保存する）。
function hub(
  store: Store,
  reader: ReceiptImageReader | null,
  settings: ReceiptSettingStore = receiptSettingStoreOf(store, () => NOW),
  log?: (message: string) => void,
) {
  const receipt = createHouseholdReceiptRoutes({
    setup: reader === null ? null : setupOf(reader),
    budget: reader === null ? null : budget,
    zone: () => ZONE,
    now: () => NOW,
    settings,
    ...(log === undefined ? {} : { log }),
  });
  const routes = createHouseholdRoutes({
    store,
    dataKey: () => Promise.resolve({ keyId: 'k-test', key: randomBytes(32) }),
    zone: () => ZONE,
    now: () => NOW,
    receipt,
  }).handlers;
  return {
    ...routes,
    closeWhenUnavailable: receipt.closeWhenUnavailable,
  };
}

const call = async (
  handler: ApiRouteHandler,
  body: JsonObject | null = null,
): Promise<{ status: number; body: Json }> => {
  const response = await handler({
    route: undefined as never,
    device: null,
    body,
    params: {},
    remoteAddress: '127.0.0.1',
    query: {},
    declaredLockState: null,
  } as Parameters<ApiRouteHandler>[0]);
  return { status: response.status, body: response.body as Json };
};

const settingBody = (
  value: string,
  revision: string,
  requestId = id(800),
): JsonObject => ({
  request_id: requestId,
  command_scope_id: SCOPE,
  expected_settings_revision: revision,
  receipt_reading: value,
});

const readBody = (requestId: string): JsonObject => ({
  request_id: requestId,
  command_scope_id: SCOPE,
  image: {
    media_type: 'image/jpeg',
    data_base64: Buffer.from(jpeg(960, 1280, 2048)).toString('base64'),
  },
});

async function overview(
  handlers: ReturnType<typeof hub>,
): Promise<{ readonly receipt: unknown; readonly settings: unknown }> {
  const listed = await call(handlers.listHouseholdMonths);
  assert.equal(listed.status, 200);
  assert(contract.valid('HouseholdOverview', listed.body));
  return {
    receipt: listed.body['receipt_reading'],
    settings: listed.body['settings'],
  };
}

test('既定は切。入にすると DB に保存し、中枢を起動し直しても入のまま読み取りを受ける', async (t) => {
  const path = tempDir(t);
  const first = openDb(path);
  const reader = new CountingReader();
  try {
    const handlers = hub(first.store, reader);
    assert.deepEqual(await overview(handlers), {
      receipt: 'off',
      settings: { mail_intake: 'on', settings_revision: '0' },
    });
    // 切のあいだは送らない。
    assert.equal(
      (await call(handlers.readHouseholdReceipt, readBody(id(1)))).status,
      403,
    );
    const on = await call(
      handlers.changeHouseholdReceiptSetting,
      settingBody('on', '0'),
    );
    assert.equal(on.status, 200);
    assert(contract.valid('HouseholdReceiptSetting', on.body));
    assert.deepEqual(on.body, {
      receipt_reading: 'on',
      settings_revision: '1',
    });
    assert.deepEqual(
      first.db
        .prepare(
          'SELECT mail_intake, receipt_reading, settings_revision FROM household_settings',
        )
        .all(),
      [{ mail_intake: 'on', receipt_reading: 'on', settings_revision: 1 }],
    );
  } finally {
    first.db.close();
  }
  // 起動し直す: DB を開き直し、経路を組み立て直す（メモリーの値は残っていない）。
  const second = openDb(path);
  try {
    const handlers = hub(second.store, reader);
    assert.deepEqual(await overview(handlers), {
      receipt: 'on',
      settings: { mail_intake: 'on', settings_revision: '1' },
    });
    const read = await call(handlers.readHouseholdReceipt, readBody(id(2)));
    assert.equal(read.status, 200);
    assert.equal(read.body['result'], 'candidate');
    assert.equal(reader.sent, 1);
    // 切にすると保存し、起動し直しても切のまま。
    const off = await call(
      handlers.changeHouseholdReceiptSetting,
      settingBody('off', '1', id(801)),
    );
    assert.deepEqual(off.body, {
      receipt_reading: 'off',
      settings_revision: '2',
    });
  } finally {
    second.db.close();
  }
  const third = openDb(path);
  try {
    const handlers = hub(third.store, reader);
    assert.equal((await overview(handlers)).receipt, 'off');
    assert.equal(
      (await call(handlers.readHouseholdReceipt, readBody(id(3)))).status,
      403,
    );
    assert.equal(reader.sent, 1);
  } finally {
    third.db.close();
  }
});

test('版の照合: 古い版・同じ要求の再送・取り込みの入・切を変えた後の古い版は 409。形の誤りは 422', async (t) => {
  const { db, store } = openDb(tempDir(t));
  onCleanup(t, () => db.close());
  const handlers = hub(store, new CountingReader());
  assert.equal(
    (await call(handlers.changeHouseholdReceiptSetting, settingBody('on', '0')))
      .status,
    200,
  );
  // 同じ要求の再送（版 0 のまま）は版が進んでいるので 409 で、二度は効かない。
  const resent = await call(
    handlers.changeHouseholdReceiptSetting,
    settingBody('on', '0'),
  );
  assert.equal(resent.status, 409);
  assert.equal(resent.body['code'], 'conflict');
  assert.equal(resent.body['request_id'], id(800));
  // 利用通知の取り込みの入・切を変えると版が進み、前の版でのレシートの設定の変更は 409。
  const intake = await call(handlers.changeHouseholdSettings, {
    request_id: id(810),
    command_scope_id: SCOPE,
    expected_settings_revision: '1',
    mail_intake: 'off',
  });
  assert.deepEqual(intake.body, { mail_intake: 'off', settings_revision: '2' });
  assert(contract.valid('HouseholdSettings', intake.body));
  // 入にする要求は版を照合するので、古い版（1）からは 409 で、保存した値は入のまま（取り込みの切は残る）。
  const staleOn = await call(
    handlers.changeHouseholdReceiptSetting,
    settingBody('on', '1', id(801)),
  );
  assert.equal(staleOn.status, 409);
  assert.deepEqual(await overview(handlers), {
    receipt: 'on',
    settings: { mail_intake: 'off', settings_revision: '2' },
  });
  // 切にする要求は安全な向きなので、版が違っても保存する（今の版 2 から 1 進めて 3）。
  const staleOff = await call(
    handlers.changeHouseholdReceiptSetting,
    settingBody('off', '1', id(802)),
  );
  assert.equal(staleOff.status, 200);
  assert.deepEqual(staleOff.body, {
    receipt_reading: 'off',
    settings_revision: '3',
  });
  assert.deepEqual(await overview(handlers), {
    receipt: 'off',
    settings: { mail_intake: 'off', settings_revision: '3' },
  });
  // 形の誤り（値・版の形・版がない）は 422 で、保存しない。
  for (const body of [
    settingBody('unavailable', '3', id(803)),
    settingBody('off', '02', id(804)),
    settingBody('off', '-1', id(805)),
    { request_id: id(806), command_scope_id: SCOPE, receipt_reading: 'off' },
  ]) {
    const bad = await call(
      handlers.changeHouseholdReceiptSetting,
      body as JsonObject,
    );
    assert.equal(bad.status, 422, JSON.stringify(body));
  }
  assert.equal((await overview(handlers)).receipt, 'off');
});

test('読み取りの口が使えないときは、保存が入でも unavailable。入にする要求は 503、切にする要求は保存する', async (t) => {
  const { db, store } = openDb(tempDir(t));
  onCleanup(t, () => db.close());
  // 読み取りの口があるときに入にしておく。
  assert.equal(
    (
      await call(
        hub(store, new CountingReader()).changeHouseholdReceiptSetting,
        settingBody('on', '0'),
      )
    ).status,
    200,
  );
  // 起動し直したら読み取りの口（鍵）がなかった。
  const handlers = hub(store, null);
  assert.deepEqual(await overview(handlers), {
    receipt: 'unavailable',
    settings: { mail_intake: 'on', settings_revision: '1' },
  });
  const read = await call(handlers.readHouseholdReceipt, readBody(id(4)));
  assert.equal(read.status, 503);
  assert.equal(read.body['code'], 'not_sent');
  const on = await call(
    handlers.changeHouseholdReceiptSetting,
    settingBody('on', '1', id(820)),
  );
  assert.equal(on.status, 503);
  assert.equal(on.body['code'], 'dependency_unavailable');
  // 切にする側は保存する（版は進む）。見せる値は unavailable のまま。
  const off = await call(
    handlers.changeHouseholdReceiptSetting,
    settingBody('off', '1', id(821)),
  );
  assert.equal(off.status, 200);
  assert.deepEqual(off.body, {
    receipt_reading: 'unavailable',
    settings_revision: '2',
  });
  assert(contract.valid('HouseholdReceiptSetting', off.body));
  // 読み取りの口が戻っても、切のまま。
  assert.equal(
    (await overview(hub(store, new CountingReader()))).receipt,
    'off',
  );
});

test('保存を読めなければ送らず、変更の成否が分からなければ 503（成功にも競合にも見せない）', async (t) => {
  const { db, store } = openDb(tempDir(t));
  onCleanup(t, () => db.close());
  const reader = new CountingReader();
  assert.equal(
    (
      await call(
        hub(store, reader).changeHouseholdReceiptSetting,
        settingBody('on', '0'),
      )
    ).status,
    200,
  );
  const real = store.household as (op: HouseholdOp) => Promise<unknown>;
  const broken: Store = {
    household: ((op: HouseholdOp) =>
      op.kind === 'household.settings_get'
        ? Promise.resolve({
            ok: false,
            outcome: 'rejected',
            reasons: ['database_busy'],
          })
        : op.kind === 'household.receipt_setting_set'
          ? Promise.resolve({
              ok: false,
              outcome: 'unknown',
              reasons: ['commit_failed'],
            })
          : real(op)) as Store['household'],
  };
  const handlers = hub(broken, reader);
  const read = await call(handlers.readHouseholdReceipt, readBody(id(5)));
  assert.equal(read.status, 503);
  assert.equal(read.body['code'], 'not_sent');
  assert.equal(reader.sent, 0);
  const lost = await call(
    handlers.changeHouseholdReceiptSetting,
    settingBody('off', '1', id(830)),
  );
  assert.equal(lost.status, 503);
  assert.equal(lost.body['code'], 'dependency_unavailable');
});

test('保存した値を読む間に切にされた読み取りは送らない', async (t) => {
  const { db, store } = openDb(tempDir(t));
  onCleanup(t, () => db.close());
  const reader = new CountingReader();
  const real = receiptSettingStoreOf(store, () => NOW);
  assert.equal((await real.write('0', 'on')).kind, 'written');
  // 読み取りの最初の読み出しだけを止めておく（その間に切にする）。
  let release: () => void = () => undefined;
  let held = true;
  const settings: ReceiptSettingStore = {
    read: async () => {
      if (held) {
        held = false;
        const value = await real.read();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return value;
      }
      return real.read();
    },
    write: (expected, value) => real.write(expected, value),
  };
  const handlers = hub(store, reader, settings);
  const running = call(handlers.readHouseholdReceipt, readBody(id(6)));
  await new Promise((resolve) => setImmediate(resolve));
  const off = await call(
    handlers.changeHouseholdReceiptSetting,
    settingBody('off', '1', id(840)),
  );
  assert.equal(off.status, 200);
  release();
  const result = await running;
  // 読み出した値は入でも、読み出しの間に切にされたので送らない。
  assert.equal(result.status, 403);
  assert.equal(result.body['code'], 'external_send_consent_required');
  assert.equal(reader.sent, 0);
});

test('中枢のメモリーにだけ持つ口（試験用）も版を照合する', async () => {
  const memory = memoryReceiptSettingStore();
  assert.deepEqual(await memory.read(), {
    receipt_reading: 'off',
    settings_revision: '0',
  });
  assert.deepEqual(await memory.write('1', 'on'), { kind: 'conflict' });
  // 切にする要求は版が違っても保存する。
  assert.deepEqual(await memory.write('7', 'off'), {
    kind: 'written',
    stored: { receipt_reading: 'off', settings_revision: '1' },
  });
  assert.deepEqual(await memory.write('x', 'on'), { kind: 'invalid' });
  assert.deepEqual(await memory.write('1', 'on'), {
    kind: 'written',
    stored: { receipt_reading: 'on', settings_revision: '2' },
  });
});

test('起動のとき読み取りの口がなければ、保存した入を切に倒して版を進める。口があるとき・切のときは何もしない', async (t) => {
  const { db, store } = openDb(tempDir(t));
  onCleanup(t, () => db.close());
  assert.equal(
    (
      await call(
        hub(store, new CountingReader()).changeHouseholdReceiptSetting,
        settingBody('on', '0'),
      )
    ).status,
    200,
  );
  // 口があるなら、入のまま。
  const present = hub(store, new CountingReader());
  assert.equal(await present.closeWhenUnavailable(), true);
  assert.deepEqual(await overview(present), {
    receipt: 'on',
    settings: { mail_intake: 'on', settings_revision: '1' },
  });
  // 口がないなら、切に倒して保存する（版は 1 進む）。口が戻っても切のまま。
  const logs: string[] = [];
  const missing = hub(store, null, undefined, (message) => logs.push(message));
  assert.equal(await missing.closeWhenUnavailable(), true);
  assert.deepEqual(logs, [
    '家計簿のレシートの写真の読み取りの設定を切にしました（receipt_reader_unavailable_at_start）。',
  ]);
  assert.deepEqual(await overview(hub(store, new CountingReader())), {
    receipt: 'off',
    settings: { mail_intake: 'on', settings_revision: '2' },
  });
  // もう切なので、何も書かず版も進めない。
  assert.equal(await missing.closeWhenUnavailable(), true);
  assert.deepEqual(await overview(hub(store, new CountingReader())), {
    receipt: 'off',
    settings: { mail_intake: 'on', settings_revision: '2' },
  });
  assert.equal(logs.length, 1);
});
