// B06-07a-1: 起動・復帰の掃除が済むまで検索・送信させない入口の一覧（ADR 0053 の U108、ADR 0058）。
// 外部の読み取り・送出の口（provider・Live）を使う Core のモジュールを、手書きの表（gated / exempt / wiring）に
// 載せる。表にないモジュールが外部の口を使い始めたら、この試験が落ちる（入口の増やし忘れを CI で止める）。
// gated は、ゲートを通す記述（anchors）がそのファイルに残っていること。exempt は通さない理由を表に書く。

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url)).replace(
  /[\\/]dist$/u,
  `${process.platform === 'win32' ? '\\' : '/'}src`,
);

// 外部の読み取り・送出の口を使うモジュールの目印。
const OUTBOUND =
  /ProviderReader|ProviderWriter|LiveProvider|UsageReconciler|ReceiptImageReader|@buddy\/connectors|\bfetch\(/u;

type Entry =
  | {
      readonly kind: 'gated';
      readonly what: string;
      readonly anchors: readonly string[];
    }
  | { readonly kind: 'exempt'; readonly reason: string }
  | { readonly kind: 'wiring'; readonly reason: string };

const ENTRIES: Readonly<Record<string, readonly Entry[]>> = {
  'api-turns.ts': [
    {
      kind: 'gated',
      what: '発言の Read（予定の照会）・RemoteMutation の計画（下書き・ラベル）の検索と読み取り',
      anchors: ['options.retention.ready()', 'options.retention.lease()'],
    },
  ],
  'operation-runner.ts': [
    {
      kind: 'gated',
      what: '実行担当の送出（準備権の前・送出意図の前）と、対象・許可の確かめ直しの読み取り',
      anchors: ['recheckLeased', 'leaseSend', 'cloudGate'],
    },
    {
      kind: 'exempt',
      reason:
        '本人の照合（reconcile／lookup）。本人の操作で、結果不明の操作 1 件の対象だけを元サービスで確かめる参照で、検索でも個人の内容の送信でもない。結果不明の操作の本文は掃除が保留する（unknown_held）ので、掃除を待つ理由がなく、時計の保留（clock_regression など）の間に決着できなくなる害のほうが大きい。ADR 0058 の U138',
    },
  ],
  'voice-control.ts': [
    {
      kind: 'gated',
      what: 'Live の開始（外部への送信）',
      anchors: ['this.#retention.ready()', 'this.#retention.lease()'],
    },
  ],
  'budget-gate.ts': [
    {
      kind: 'exempt',
      reason:
        '利用量の照合（金額と ID だけ。個人の内容を送らず、検索もしない）。予算の記録の保持は掃除が月ごとに別に扱う',
    },
  ],
  'live-reconcile.ts': [
    {
      kind: 'exempt',
      reason:
        '再起動の後の Live の利用量の照合（セッションの ID と秒数だけ）。個人の内容を送らず、検索もしない',
    },
  ],
  'core.ts': [
    {
      kind: 'wiring',
      reason: '入口へゲートを渡す配線（retention.gate／lease／idle）',
    },
  ],
  'index.ts': [{ kind: 'wiring', reason: '型の再 export' }],
  'turn-ports.ts': [
    { kind: 'wiring', reason: 'ポートの型の定義（呼び出しはしない）' },
  ],
  'mock-mail-ports.ts': [
    { kind: 'wiring', reason: '模擬のポートの実装（試験・模擬起動用）' },
  ],
  'sync-executor.ts': [
    {
      kind: 'gated',
      what: '同期の走査（接続先からのメール・予定の読み取りと公開）',
      anchors: ['options.retention.ready()', 'options.retention.lease()'],
    },
  ],
  'graph-sync-executor.ts': [
    {
      kind: 'gated',
      what: '同期の走査（Outlook／Graph からのメールの読み取りと公開。B09-04）',
      anchors: ['options.retention.ready()', 'options.retention.lease()'],
    },
  ],
  'research-executor.ts': [
    {
      kind: 'gated',
      what: '公開 Web 調査の実行（検索・取得・要約の口への送出。B12-05）',
      anchors: ['options.retention.ready()', 'options.retention.lease()'],
    },
  ],
  'mail-attachments.ts': [
    {
      kind: 'gated',
      what: '添付の取得（Gmail からの添付の読み取りと抽出。B08-04）',
      anchors: ['options.retention.ready()', 'options.retention.lease()'],
    },
  ],
  'connection-discovery.ts': [
    {
      kind: 'exempt',
      reason:
        '選べる取得対象の発見（カレンダー・ラベル・フォルダーの一覧と Outlook のカテゴリ。ADR 0145）。中枢の画面での本人の操作で入れ物の名前を一度読んで返すだけで、何も保存せず、検索・クラウドへの送信・自動利用でもない。本文・添付は読まない',
    },
  ],
  'candidate-auto-execution.ts': [
    {
      kind: 'gated',
      what: '気づきの候補からのラベルの自動付与で、接続・許可の版・対象のメールを読み直す（B13-04、ADR 0150）',
      anchors: ['ports.retention.ready()', 'ports.retention.lease()'],
    },
  ],
  'api-auto-actions.ts': [
    {
      kind: 'gated',
      what: '自動実行の取り消しで、接続・許可の版・対象のメールを読み直す（B13-05、ADR 0153）',
      anchors: ['retention.ready()', 'retention.lease()'],
    },
  ],
  'household-mail-intake.ts': [
    {
      kind: 'gated',
      what: '家計簿の利用通知の取り込み（同期したメールの見出し・本文の読み取りと記録。ADR 0160）',
      anchors: ['options.retention.ready()', 'options.retention.lease()'],
    },
  ],
  'candidate-evidence.ts': [
    {
      kind: 'gated',
      what: '気づきの根拠の取り直し（控えた予定・メールの読み直し。保存はしない。ADR 0201）',
      anchors: ['options.retention.ready()', 'options.retention.lease()'],
    },
  ],
  'calendar-candidate-intake.ts': [
    {
      kind: 'gated',
      what: '予定の重複の気づきの取り込み（選んだカレンダーの予定の読み直しと候補の保存。ADR 0194）',
      anchors: ['options.retention.ready()', 'options.retention.lease()'],
    },
  ],
  'household-receipt.ts': [
    {
      kind: 'gated',
      what: 'レシートの写真の外部のモデルの画像の読み取りへの送信（ADR 0177）。掃除を待たず、送れないときは送らずに 503',
      anchors: ['options.cloudGate.open()', 'options.cloudGate.lease()'],
    },
  ],
  'household-receipt-reader.ts': [
    {
      kind: 'wiring',
      reason:
        '読み取りの口（ReceiptImageReader）の Gemini の実装と profile（ADR 0178）。呼ぶのは household-receipt.ts で、掃除のゲートはそこで通す',
    },
  ],
  'graph-mail-attachments.ts': [
    {
      kind: 'gated',
      what: '添付の取得（Outlook／Graph からの添付の読み取りと抽出。B09-03）',
      anchors: ['options.retention.ready()', 'options.retention.lease()'],
    },
  ],
};

async function sourceFiles(): Promise<string[]> {
  const names = await readdir(SOURCE_DIR);
  return names
    .filter(
      (name) =>
        name.endsWith('.ts') &&
        !name.endsWith('.test.ts') &&
        !name.includes('test-support'),
    )
    .sort();
}

test('every Core module that reaches a provider or Live is in the entry table', async () => {
  const unlisted: string[] = [];
  const stale: string[] = [];
  for (const name of await sourceFiles()) {
    const text = await readFile(join(SOURCE_DIR, name), 'utf8');
    const reaches = OUTBOUND.test(text);
    const listed = Object.hasOwn(ENTRIES, name);
    if (reaches && !listed) unlisted.push(name);
    if (!reaches && listed) stale.push(name);
  }
  assert.deepEqual(
    unlisted,
    [],
    '外部の口を使う新しいモジュールです。掃除のゲートを通すか、通さない理由を retention-entries.test.ts の表に書いてください',
  );
  assert.deepEqual(
    stale,
    [],
    '表にあるが外部の口を使っていないモジュールです。表から外してください',
  );
});

test('every gated entry still carries its gate (removing the gate fails)', async () => {
  for (const [name, entries] of Object.entries(ENTRIES)) {
    const text = await readFile(join(SOURCE_DIR, name), 'utf8');
    for (const entry of entries)
      if (entry.kind === 'gated')
        for (const anchor of entry.anchors)
          assert.ok(
            text.includes(anchor),
            `${name}: 「${entry.what}」のゲート（${anchor}）が見つかりません`,
          );
  }
});

test('exempt entries state their reason and name the call they exempt', async () => {
  for (const entries of Object.values(ENTRIES))
    for (const entry of entries)
      if (entry.kind !== 'gated') assert.ok(entry.reason.length >= 10);
  // 本人の照合は api-operations.ts の経路から runner.reconcile を呼ぶ。表の根拠（ゲートを通さない）と一致していること。
  const text = await readFile(join(SOURCE_DIR, 'api-operations.ts'), 'utf8');
  assert.ok(text.includes('runner.reconcile('));
  assert.equal(text.includes('retention'), false);
});

test('the Core hands the gate to every gated entry', async () => {
  const text = await readFile(join(SOURCE_DIR, 'core.ts'), 'utf8');
  // 発言の入口・実行担当・Live・同期の実行器（Google・Graph）・調査の実行器・自動実行の取り消し・家計簿の利用通知の取り込み・
  // レシートの写真の読み取り（ADR 0177）・予定の重複の気づきの取り込み（ADR 0194）・気づきの根拠の取り直し（ADR 0201）の 11 個に、
  // 同じ掃除の job の gate／lease を渡している。
  for (const anchor of [
    'retention: {',
    'cloudGate: {',
    'lease: () => (retention as RetentionSweeper).lease()',
  ])
    assert.ok(text.includes(anchor), anchor);
  assert.equal(
    text.split('lease: () => (retention as RetentionSweeper).lease()').length -
      1,
    11,
  );
});
