// 記録しない会話の発言を RAM だけで扱う（B06-07a-2 の 2c、ADR 0190）の試験。Core は同じプロセスの startCore（HTTPS は
// 127.0.0.1、鍵は模擬の KeyStore）、解釈は模擬（モデルを使わない。呼ばれた入力を控える包み）、provider は合成の読み取り専用。
// 目印は試験の回ごとに作る合成の ASCII（B06-09 の目印の探し方に合わせ、データディレクトリの全ファイル（DB・WAL・時計の
// 状態ファイル）とログから平文のバイト列を探す）。期待値（状態・件数・文・版・理由）は ADR 0190 と ADR 0045 の許可表から
// 手で書いた値で、実装の関数から作らない。模擬の試験だけで、実機・実 API は未実施。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type {
  CanvasDocument,
  StreamTurnResponse,
  TurnResponse,
} from '@buddy/contracts';
import { openWriteConnection, storagePlatform } from '@buddy/storage';
import { sharedApiContract } from './api-test-support.js';
import type { TestDevice } from './api-test-support.js';
import { API_ROUTES } from './api-routes.js';
import { createTurnRoutes } from './api-turns.js';
import type { TurnRouteStore } from './api-turns.js';
import { PreviewRegistry } from './previews.js';
import { A, SCOPE_A } from './voice-rig-test-support.js';
import {
  DATA_KEY_MATERIAL,
  bootstrap,
  getJson,
  insertDevice,
  postJson,
  startEventCore,
} from './event-test-support.js';
import type { EventCore, MutableEnvironment } from './event-test-support.js';
import { DB_FILE } from './paths.js';
import { TEST_TURN_POLICY, createMockInterpreter } from './turn-ports.js';
import type {
  InterpretationContext,
  Interpreter,
  ProviderEvent,
  ProviderReader,
} from './turn-ports.js';

const contract = sharedApiContract();

// 設計 09 §2 の時計（2026-10-05T09:00:00+09:00 ＝ 2026-10-05T00:00:00Z）。
const CLOCK = new Date('2026-10-05T09:00:00+09:00');
const ACCOUNT = '00000000-0000-4000-8000-000000000002';

// 手で写した決まった文（api-turns.ts の聞き返しの文）。
const UNCLEAR =
  'すみません、どうしたいのか分かりませんでした。言い換えてください。';
const PRIVATE_UNSUPPORTED =
  '記録しない会話では、この依頼はまだ受け付けられません。記録しない会話を終えてから、もう一度お願いします。';

// 保存先の表（ADR 0045 の「保存先の分類」のうち、発言から書かれ得るもの）。記録しない間に 1 行も増えないことを見る。
const TABLES = [
  'sessions',
  'turns',
  'sealed_blobs',
  'input_snapshots',
  'turn_responses',
  'command_receipts',
  'workflows',
  'operations',
  'event_outbox',
  'intent_shadow',
  'memories',
  'user_directives',
] as const;

const EVENTS: ProviderEvent[] = [
  {
    event_id: 'ev-1',
    title: '合成の予定1',
    start: '2026-10-05T09:30:00+09:00',
    end: '2026-10-05T10:30:00+09:00',
  },
  {
    event_id: 'ev-2',
    title: '合成の予定2',
    start: '2026-10-05T11:00:00+09:00',
    end: '2026-10-05T12:00:00+09:00',
  },
];

const provider: ProviderReader = {
  connection: () =>
    Promise.resolve({
      provider: 'mock' as const,
      account_id: ACCOUNT,
      account_label: '合成の口座',
      status: 'active' as const,
      access: 'read_write' as const,
    }),
  readPermission: (accountId) =>
    Promise.resolve(
      accountId === ACCOUNT
        ? {
            account_id: ACCOUNT,
            permission_revision: '1',
            scopes: ['mail.read', 'mail.labels'],
          }
        : null,
    ),
  readTarget: () => Promise.resolve(null),
  listEvents: () => Promise.resolve(EVENTS),
};

// 模擬の解釈の包み。渡された入力を控え、決めた文では止めておく（処理の途中で区切りを変えるため）。
class RecordingInterpreter implements Interpreter {
  readonly contexts: InterpretationContext[] = [];
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
    this.contexts.push(context);
    const hold = this.#holds.get(context.text);
    if (hold !== undefined) {
      hold.started();
      await hold.release;
    }
    return this.#inner.interpret(context);
  }
}

interface Rig {
  readonly core: EventCore;
  readonly device: TestDevice;
  readonly scope: string;
  readonly interpreter: RecordingInterpreter;
  readonly logs: string[];
}

async function startRig(
  t: test.TestContext,
  options: {
    readonly now?: () => Date;
    readonly env?: MutableEnvironment;
    readonly dataDir?: string;
    readonly tlsKeyStore?: EventCore['tlsKeyStore'];
  } = {},
): Promise<Rig> {
  const interpreter = new RecordingInterpreter();
  const logs: string[] = [];
  const core = await startEventCore(t, {
    previewValid: false,
    now: options.now ?? (() => CLOCK),
    log: (message) => logs.push(String(message)),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.tlsKeyStore === undefined
      ? {}
      : { tlsKeyStore: options.tlsKeyStore }),
    turns: {
      provider,
      interpreter,
      candidates: { mailCandidates: () => Promise.resolve([]) },
      utcOffset: '+09:00',
    },
  });
  const device = await insertDevice(core.handle.store);
  const scope = await bootstrap(core, device);
  return { core, device, scope, interpreter, logs };
}

const say = (rig: Rig, text: string, requestId: string = randomUUID()) =>
  postJson(rig.core, rig.device, '/v1/stream/turns', {
    request_id: requestId,
    command_scope_id: rig.scope,
    text,
    input_kind: 'text',
    expected_canvas_revision: '0',
  });

const switchMode = (rig: Rig, storageMode: 'normal' | 'private') =>
  postJson(
    rig.core,
    rig.device,
    '/v1/stream/storage-mode',
    {
      request_id: randomUUID(),
      command_scope_id: rig.scope,
      storage_mode: storageMode,
    },
    { 'buddy-input-origin': 'screen' },
  );

const canvasOf = async (rig: Rig) => {
  const response = await getJson(rig.core, rig.device, '/v1/canvas');
  assert.equal(response.status, 200, response.text);
  return response.json as unknown as CanvasDocument;
};

const streamBody = (response: { json: unknown; text: string }) => {
  assert(contract.valid('StreamTurnResponse', response.json), response.text);
  return response.json as unknown as StreamTurnResponse;
};

const countRows = (dataDir: string): Record<string, number> => {
  const db = openWriteConnection(join(dataDir, DB_FILE), {
    platform: storagePlatform(),
  });
  try {
    return Object.fromEntries(
      TABLES.map((table) => [
        table,
        Number(
          (
            db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
              n: number;
            }
          ).n,
        ),
      ]),
    );
  } finally {
    db.close();
  }
};

// データディレクトリの全ファイルとログから、目印の平文のバイト列を探す（B06-09 の findResidue と同じ考え方）。
const residue = (
  dataDir: string,
  logs: readonly string[],
  needle: string,
): string[] => {
  const value = Buffer.from(needle, 'utf8');
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      // 制御チャネルのソケットなど、通常のファイルでないものは読まない。
      else if (stat.isFile() && readFileSync(path).indexOf(value) >= 0)
        found.push(name);
    }
  };
  walk(dataDir);
  if (logs.join('\n').includes(needle)) found.push('logs');
  return found;
};

// 記録しない会話から出ると、出る先の会話を 1 つ作る（sessions と、その作成の受付 command_receipts が 1 件ずつ増える。
// ADR 0060 の 2b）。発言の保存先（turns など）は増えない。
const afterExit = (rows: Record<string, number>): Record<string, number> => ({
  ...rows,
  sessions: (rows['sessions'] ?? 0) + 1,
  command_receipts: (rows['command_receipts'] ?? 0) + 1,
});

const marker = (label: string) =>
  `B06-SYNTH-${label}-${randomUUID().slice(0, 8)}`;

test('a private turn is answered from RAM: replays come from RAM, nothing is written to the DB, files or logs, and leaving drops the RAM and closes the temporary canvas', async (t) => {
  const rig = await startRig(t);
  const secret = marker('private');

  // 通常の発言（キャンバスには何も置かない聞き返し）。
  const normal = await say(rig, '合成の通常の発言');
  assert.equal(normal.status, 200, normal.text);
  assert.equal(rig.interpreter.contexts[0]?.recent_turns, undefined);
  assert.deepEqual(await canvasOf(rig), {
    canvas_revision: '0',
    items: [],
    reading_order: [],
  });
  const before = countRows(rig.core.dataDir);

  assert.equal((await switchMode(rig, 'private')).status, 200);
  assert.equal(rig.core.handle.storage.privateConversation(), true);

  // 1. 参照（予定の照会）は答え、カードは一時の記述に置く。
  const first = streamBody(await say(rig, '今日の用事を見せて'));
  assert.equal(first.segment.storage_mode, 'private');
  assert.equal(first.status, 'answered');
  assert.equal(first.result_view?.kind, 'schedule_cards');
  assert.equal(first.canvas?.canvas_revision, '1');
  assert.deepEqual(
    (await canvasOf(rig)).items.map((item) => item.item_id),
    ['errands'],
  );

  // 2. 目印を含む発言は聞き返し。直前のやりとり（本人の発言 1 件。予定の照会は返事の文を持たない）が解釈の入力に添えられる。
  const secretRequest = randomUUID();
  const second = streamBody(await say(rig, `目印 ${secret}`, secretRequest));
  assert.equal(second.status, 'clarification');
  assert.equal(second.reply_text, UNCLEAR);
  assert.deepEqual(rig.interpreter.contexts.at(-1)?.recent_turns, [
    { role: 'user', text: '今日の用事を見せて', at: '2026-10-05T00:00:00Z' },
  ]);

  // 3. 同じ要求の再送は RAM の控えから同じ応答（解釈を呼ばない）。照合値が違えば 409。
  const calls = rig.interpreter.contexts.length;
  const replayed = streamBody(await say(rig, `目印 ${secret}`, secretRequest));
  assert.equal(replayed.turn_id, second.turn_id);
  assert.equal(rig.interpreter.contexts.length, calls);
  const changed = await say(rig, '別の発言', secretRequest);
  assert.equal(changed.status, 409, changed.text);

  // 4. 保存を伴う依頼（用事の登録）は作らず、決まった文で断る（依頼・操作の ID も持たない）。
  const third = streamBody(await say(rig, '「牛乳を買う」を用事に登録して'));
  assert.equal(third.status, 'clarification');
  assert.equal(third.reply_text, PRIVATE_UNSUPPORTED);
  assert.equal(third.workflow_id, null);
  assert.equal(third.result_view, null);

  // DB の保存先は 1 行も増えない。目印はデータディレクトリ（DB・WAL を含む）にもログにもない。
  assert.deepEqual(countRows(rig.core.dataDir), before);
  assert.deepEqual(residue(rig.core.dataDir, rig.logs, secret), []);
  // RAM: 応答の控え 3 件、直前のやりとり 5 件（本人 3・返事 2）、流れの表示の控え 3 件、一時のキャンバス。
  assert.deepEqual(rig.core.handle.privateConversation?.held(), {
    replays: 3,
    recent_turns: 5,
    discards: 0,
    last_discard: null,
    stream_turns: 3,
    canvas_private: true,
  });

  // 終えると RAM を捨て、一時の記述を閉じて入る前の記述へ戻す（版は進める）。
  assert.equal((await switchMode(rig, 'normal')).status, 200);
  assert.deepEqual(rig.core.handle.privateConversation?.held(), {
    replays: 0,
    recent_turns: 0,
    discards: 1,
    last_discard: 'private_ended',
    stream_turns: 0,
    canvas_private: false,
  });
  assert.deepEqual(await canvasOf(rig), {
    canvas_revision: '2',
    items: [],
    reading_order: [],
  });

  // 終えた後の同じ要求の再送は 409 で、保存しない。
  const late = await say(rig, `目印 ${secret}`, secretRequest);
  assert.equal(late.status, 409, late.text);
  assert.deepEqual(countRows(rig.core.dataDir), afterExit(before));

  // 終えた後の発言は保存される（陽性の対照）。
  const after = await say(rig, '合成の通常の発言');
  assert.equal(after.status, 200, after.text);
  assert.equal(
    countRows(rig.core.dataDir)['turns'],
    (before['turns'] ?? 0) + 1,
  );

  await rig.core.handle.stop('test');
  assert.deepEqual(residue(rig.core.dataDir, rig.logs, secret), []);
});

test('a private result that arrives after leaving is neither held nor shown, and a normal result that arrives after entering is not saved', async (t) => {
  const rig = await startRig(t);
  const before = countRows(rig.core.dataDir);

  // 記録しない間に始めた発言の解釈を止めておき、その間に終える。
  assert.equal((await switchMode(rig, 'private')).status, 200);
  const held = rig.interpreter.hold('遅れる発言');
  const pending = say(rig, '遅れる発言');
  await held.started;
  // 終える要求は、終えた後に旧区切りの発言の終わりを待つので、ここでは待たない。
  const exiting = switchMode(rig, 'normal');
  while (rig.core.handle.storage.privateConversation())
    await new Promise((resolve) => setTimeout(resolve, 5));
  held.release();
  const lateResponse = await pending;
  assert.equal(lateResponse.status, 409, lateResponse.text);
  assert.equal((await exiting).status, 200);
  // 遅れた結果はキャンバスにも RAM にもない（一時の記述は閉じて版 1）。
  assert.deepEqual(await canvasOf(rig), {
    canvas_revision: '1',
    items: [],
    reading_order: [],
  });
  assert.deepEqual(rig.core.handle.privateConversation?.held(), {
    replays: 0,
    recent_turns: 0,
    discards: 1,
    last_discard: 'private_ended',
    stream_turns: 0,
    canvas_private: false,
  });
  assert.deepEqual(countRows(rig.core.dataDir), afterExit(before));

  // 通常の区切りで始めた発言の解釈を止めておき、その間に記録しないへ入る。保存の直前の照合で保存しない。
  const normalHeld = rig.interpreter.hold('入る前の発言');
  const normalPending = say(rig, '入る前の発言');
  await normalHeld.started;
  const sessionsBefore = countRows(rig.core.dataDir)['sessions'];
  assert.equal((await switchMode(rig, 'private')).status, 200);
  normalHeld.release();
  const normalLate = await normalPending;
  assert.equal(normalLate.status, 409, normalLate.text);
  const now = countRows(rig.core.dataDir);
  assert.equal(now['turns'], before['turns']);
  assert.equal(now['sessions'], sessionsBefore);
  assert.equal(now['turn_responses'], before['turn_responses']);
});

test('the recent turns passed to the interpretation keep 6 entries and are dropped 30 minutes after the last exchange', async (t) => {
  let at = CLOCK.getTime();
  const rig = await startRig(t, { now: () => new Date(at) });
  assert.equal((await switchMode(rig, 'private')).status, 200);
  for (let index = 1; index <= 4; index += 1)
    assert.equal((await say(rig, `やりとり${String(index)}`)).status, 200);
  // 5 回目: 直前の 3 回（本人と返事で 6 件）だけ。最初のやりとりは落ちている。
  assert.equal((await say(rig, 'やりとり5')).status, 200);
  assert.deepEqual(
    rig.interpreter.contexts.at(-1)?.recent_turns?.map((turn) => turn.text),
    ['やりとり2', UNCLEAR, 'やりとり3', UNCLEAR, 'やりとり4', UNCLEAR],
  );
  // 最後のやりとりから 29 分 59.999 秒後は残る（6 件）。
  at += 30 * 60 * 1000 - 1;
  assert.equal((await say(rig, 'やりとり6')).status, 200);
  assert.deepEqual(
    rig.interpreter.contexts.at(-1)?.recent_turns?.map((turn) => turn.text),
    ['やりとり3', UNCLEAR, 'やりとり4', UNCLEAR, 'やりとり5', UNCLEAR],
  );
  // そこからちょうど 30 分で捨てる（記録しない区切りのまま）。
  at += 30 * 60 * 1000;
  assert.equal((await say(rig, 'やりとり7')).status, 200);
  assert.deepEqual(rig.interpreter.contexts.at(-1)?.recent_turns, []);
  assert.equal(rig.core.handle.storage.privateConversation(), true);
});

test('a lock reported by a device or a forget notice drops the private RAM and closes the temporary canvas, but stays private', async (t) => {
  const env: MutableEnvironment = { home: true, lock: 'unlocked' };
  const rig = await startRig(t, { env });
  assert.equal((await switchMode(rig, 'private')).status, 200);
  assert.equal((await say(rig, '今日の用事を見せて')).status, 200);
  const lockedRequest = randomUUID();
  assert.equal((await say(rig, '合成の発言', lockedRequest)).status, 200);
  assert.equal(rig.core.handle.privateConversation?.held().recent_turns, 3);

  // ロック中の端末の要求（断られる）で、記録しない区切りの中身を捨てる。
  env.lock = 'locked';
  const refused = await getJson(
    rig.core,
    rig.device,
    '/v1/stream/storage-mode',
  );
  assert.notEqual(refused.status, 200, refused.text);
  env.lock = 'unlocked';
  assert.deepEqual(rig.core.handle.privateConversation?.held(), {
    replays: 0,
    recent_turns: 0,
    discards: 1,
    last_discard: 'locked',
    stream_turns: 0,
    canvas_private: true,
  });
  assert.equal(rig.core.handle.storage.privateConversation(), true);
  // 一時の記述は閉じて入り直す（予定のカードは消え、版は 1 → 2）。
  assert.deepEqual(await canvasOf(rig), {
    canvas_revision: '2',
    items: [],
    reading_order: [],
  });
  // 次の発言は前の文脈なしで始まる。
  assert.equal((await say(rig, '合成の発言2')).status, 200);
  assert.deepEqual(rig.interpreter.contexts.at(-1)?.recent_turns, []);

  // 忘却の知らせでも捨てる（記録しない区切りのまま）。
  assert.equal(rig.core.handle.privateConversation?.held().recent_turns, 2);
  await rig.core.handle.notices.publish({
    schema: 'buddy.retention-notice.v1',
    notice_id: randomUUID(),
    occurred_at: '2026-10-05T00:00:00Z',
    kind: 'forgotten',
    reason: 'forgotten',
    forgetting_generation: '1',
    items: [{ item_kind: 'memory', item_id: randomUUID() }],
  });
  const afterForget = rig.core.handle.privateConversation?.held();
  assert.equal(afterForget?.recent_turns, 0);
  assert.equal(afterForget?.replays, 0);
  assert.equal(afterForget?.last_discard, 'forgotten');
  assert.equal(rig.core.handle.storage.privateConversation(), true);

  // 捨てた後に終えても、記録しない間の要求の再送は通常の区切りへ保存しない（元の記録しない区切りへ送って 409）。
  const before = countRows(rig.core.dataDir);
  assert.equal((await switchMode(rig, 'normal')).status, 200);
  const resent = await say(rig, '合成の発言', lockedRequest);
  assert.equal(resent.status, 409, resent.text);
  assert.deepEqual(countRows(rig.core.dataDir), afterExit(before));
});

test('a restart loses the private RAM, returns to a normal segment, and leaves the marker nowhere', async (t) => {
  const rig = await startRig(t);
  const secret = marker('restart');
  assert.equal((await switchMode(rig, 'private')).status, 200);
  const answered = await say(rig, `目印 ${secret}`);
  assert.equal(answered.status, 200, answered.text);
  assert.equal((answered.json as unknown as TurnResponse).reply_text, UNCLEAR);
  assert.equal(rig.core.handle.privateConversation?.held().replays, 1);
  const dataDir = rig.core.dataDir;
  await rig.core.handle.stop('test');

  const again = await startRig(t, {
    dataDir,
    tlsKeyStore: rig.core.tlsKeyStore,
  });
  assert.equal(again.core.handle.storage.privateConversation(), false);
  assert.deepEqual(again.core.handle.privateConversation?.held(), {
    replays: 0,
    recent_turns: 0,
    discards: 0,
    last_discard: null,
    stream_turns: 0,
    canvas_private: false,
  });
  assert.deepEqual(residue(dataDir, [...rig.logs, ...again.logs], secret), []);
});

// --- 発言の処理（api-turns）を直接呼ぶ。DB・provider・裏の受付に触れたかを数える ---

const touchedStore = () => {
  const calls: string[] = [];
  const store = new Proxy(
    {},
    {
      get: (_target, property) => () => {
        calls.push(String(property));
        throw new Error('store_touched');
      },
    },
  ) as unknown as TurnRouteStore;
  return { store, calls };
};

const countingProvider = () => {
  const calls: string[] = [];
  const reader: ProviderReader = {
    connection: () => {
      calls.push('connection');
      return provider.connection();
    },
    readPermission: (accountId) => {
      calls.push('readPermission');
      return provider.readPermission(accountId);
    },
    readTarget: (remoteId) => {
      calls.push('readTarget');
      return provider.readTarget(remoteId);
    },
    listEvents: () => {
      calls.push('listEvents');
      return provider.listEvents();
    },
  };
  return { reader, calls };
};

const PRIVATE_SEGMENT = '00000000-0000-4000-8000-00000000a001';

test('in a private segment the turn routes never touch the DB; reads go to the provider, while tasks, labels and research are refused without any call', async () => {
  const touched = touchedStore();
  const reads = countingProvider();
  const accepted: string[] = [];
  const routes = createTurnRoutes({
    store: touched.store,
    keyStore: {
      loadDataKey: () =>
        Promise.resolve({ ok: true as const, dataKey: DATA_KEY_MATERIAL }),
    },
    interpreter: createMockInterpreter(),
    provider: reads.reader,
    candidates: { mailCandidates: () => Promise.resolve([]) },
    policy: TEST_TURN_POLICY,
    previews: new PreviewRegistry(),
    storage: {
      mode: 'private',
      origin: () => ({ segment_id: PRIVATE_SEGMENT, segment_generation: '2' }),
    },
    utcOffset: '+09:00',
    now: () => CLOCK.getTime(),
    backgroundJobs: {
      acceptResearch: (job) => {
        accepted.push(job.workflow_id);
        return Promise.resolve({
          kind: 'accepted' as const,
          workflow_id: job.workflow_id,
        });
      },
    },
  });
  const route = API_ROUTES.find((entry) => entry.operationId === 'postTurn');
  assert(route !== undefined);
  const turn = (
    text: string,
    origin: { segment_id: string; segment_generation: string },
  ) =>
    routes.handlers['postTurn']?.({
      route,
      device: A,
      body: {
        request_id: randomUUID(),
        command_scope_id: SCOPE_A,
        text,
        input_kind: 'text',
        origin,
      },
      params: { session_id: PRIVATE_SEGMENT },
      remoteAddress: '127.0.0.1',
      query: {},
      declaredLockState: 'unlocked',
    });
  const current = { segment_id: PRIVATE_SEGMENT, segment_generation: '2' };

  for (const text of [
    '「牛乳を買う」を用事に登録して',
    'mail-001 に follow-up を付けて',
    '合成の話題について調べて',
  ]) {
    const response = await turn(text, current);
    assert.equal(response?.status, 200, JSON.stringify(response?.body));
    assert(contract.valid('TurnResponse', response?.body));
    const body = response?.body as TurnResponse;
    assert.equal(body.reply_text, PRIVATE_UNSUPPORTED);
    assert.equal(body.workflow_id, null);
  }
  assert.deepEqual(reads.calls, []);
  assert.deepEqual(accepted, []);

  // 参照（予定の照会）は provider の読み取り（接続の状態と予定の一覧）だけを行う。
  const read = await turn('今日の予定を見せて', current);
  assert.equal(read?.status, 200);
  assert.equal(
    (read?.body as TurnResponse).result_view?.kind,
    'schedule_cards',
  );
  assert.deepEqual(reads.calls, ['connection', 'listEvents']);

  // 古い世代・別の区切りの由来は 409。
  assert.equal(
    (
      await turn('今日の予定を見せて', {
        segment_id: PRIVATE_SEGMENT,
        segment_generation: '1',
      })
    )?.status,
    409,
  );
  assert.equal(
    (
      await turn('今日の予定を見せて', {
        segment_id: randomUUID(),
        segment_generation: '2',
      })
    )?.status,
    409,
  );
  assert.deepEqual(touched.calls, []);
  assert.equal(routes.privateConversation.held().replays, 4);

  // 記録しない区切りの間に届いた Live の委譲は保存しない（DB に触れない）。
  const live = await routes.commitLive({
    session_id: randomUUID(),
    command_scope_id: SCOPE_A,
    request_id: randomUUID(),
    identity: 'live-1',
    text: '今日の予定を見せて',
    audio_epoch: '1',
    policy_version: '1',
    interpreted: {
      kind: 'plan',
      plan: { kind: 'clarify', reason: 'unclear', intent: null },
    },
    outcome: 'sealed',
    workflow_id: randomUUID(),
    precommit: () => true,
  });
  assert.deepEqual(live, { kind: 'failed', status: 409 });
  assert.deepEqual(touched.calls, []);
});
