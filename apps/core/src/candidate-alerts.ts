// 気づきの OS 通知の配線（B11-05 の P2、Issue #283、ADR 0196。設計 11 §4・設計 04 通知の重複と再通知・設計 08 §7、
// ADR 0073・0117・0119）。
//
// - 入・切の設定（GET・POST /v1/candidates/alert-settings）: 正本は中枢の 1 行の表（マイグレーション 0025）。既定は切・版 0。
//   読み取りは端末の main が後ろで読むのでロック解除済みだけ、変更は本人の画面操作だけ（経路の検査は api-server が先に行う）。
//   版が今と違えば、入にするときも切にするときも 409（保存してよい記憶の種類の設定と同じ。U586）。
// - 通知を出すか: 候補の保存（DB worker の candidate.create・candidate.transition）が書けた後の知らせ（DbWorkerClient の
//   onCandidateWrite）を受け、まとめて 1 回だけ判定する。設定が切なら何もしない（知らせも送らない）。入なら、新しく作った
//   候補ごとに配信の記録を読み、domain の candidateAlertDecision（trigger は new_candidate）で出すかを決める。出すものは
//   送出意図を保存し（保存層が同じ transaction で設定の入と版・候補が閉じていないこと・同じ識別子の記録がないことを確かめる。
//   最後の保証）、開いている購読へ CandidateNotice（OS 通知を出す数だけ。題・候補 ID・識別子を入れない）を 1 通送る。
//   購読へ渡せたら delivered、購読がない・渡せなかったら delivery_unknown にし、どちらも鳴らし直さない（U583）。
//   1 回の取り込みで複数の新しい候補ができても、OS 通知は 1 通にまとめる（「新しい気づきが N 件あります」。U584）。
//   まとまりは取り込みの口（予定の重複の取り込みの回・調査の完了）が batch で明示し、終わり（例外でも）で 1 回だけ判定する。
//   DB worker の応答は 1 件ずつ届くので、時機（setImmediate）だけではまとまらない。明示のない書込み（画面の操作など）は
//   書込みごとに次の時機で判定する。まとまりの間の明示のない書込みも、まとまりの終わりの判定に入る。
// - 状態の遷移だけ（件数が変わった）のときは、OS 通知の数 0 の知らせを送る（端末がトレイの new の件数を読み直す）。
// - 記録しない会話の間は OS 通知を出さない（送出意図も書かない。件数の知らせだけ送る。U588）。
// - 本人の指定した再通知（スヌーズの終わり）の OS 通知はまだ出さない（根拠を取り直す経路が無く、candidateAlertDecision が
//   source_not_confirmed で止める。再通知の ID の作り方も未定。U587）。件数の知らせだけ送る。
// - ログは件数と理由のコードだけ（題・ID・識別子を出さない）。失敗は候補の保存の失敗にしない。

import type { CandidateAlertSettings, CandidateNotice } from '@buddy/contracts';
import { candidateAlertDecision } from '@buddy/domain';
import type {
  CandidateAlertSettingsValue,
  CandidateOpValues,
  CandidateWriteListener,
  DbWorkerClient,
} from '@buddy/storage';
import { apiErrorResponse } from './api-server.js';
import type { ApiRouteHandler } from './api-server.js';
import type { StreamNoticeMessage } from './notice-relay.js';

// 1 通の知らせで数える OS 通知の上限（契約の CandidateNotice.alert_count の最大）。超えた分は送出意図を書かない。
export const CANDIDATE_ALERT_MAX = 1000;

// 設定の版の形（保存層の candidate-store.ts と同じ 16 桁まで。超えれば 422）。
const REVISION = /^(0|[1-9][0-9]{0,15})$/u;

// --- 入・切の設定の経路 ---

export interface CandidateAlertRoutesOptions {
  readonly store: Pick<DbWorkerClient, 'candidate'>;
  readonly now: () => Date;
  // 設定を変えた後に呼ぶ（端末が設定とトレイの件数を読み直す知らせを送る）。
  readonly changed?: () => void;
}

export interface CandidateAlertRoutes {
  readonly handlers: {
    readonly getCandidateAlertSettings: ApiRouteHandler;
    readonly changeCandidateAlertSettings: ApiRouteHandler;
  };
}

const settingsBody = (
  value: CandidateAlertSettingsValue,
): CandidateAlertSettings => ({
  schema: 'buddy.candidate-alert-settings.v1',
  os_notification: value.os_notification,
  candidate_alert_settings_revision: value.settings_revision,
});

export function createCandidateAlertRoutes(
  options: CandidateAlertRoutesOptions,
): CandidateAlertRoutes {
  const getCandidateAlertSettings: ApiRouteHandler = async () => {
    const read = await options.store.candidate({
      kind: 'candidate.alert_settings_get',
    });
    if (!read.ok) return apiErrorResponse(503, 'dependency_unavailable');
    return { status: 200, body: settingsBody(read.value) };
  };

  // 本人の画面操作だけ（経路の検査は api-server が先に行う）。契約の検査も api-server が先に行うが、保存層へ渡す前にもう一度
  // 確かめる。
  const changeCandidateAlertSettings: ApiRouteHandler = async (request) => {
    const body = request.body ?? {};
    const requestId =
      typeof body['request_id'] === 'string' ? body['request_id'] : null;
    const expected = body['expected_candidate_alert_settings_revision'];
    const value = body['os_notification'];
    if (
      typeof expected !== 'string' ||
      !REVISION.test(expected) ||
      (value !== 'on' && value !== 'off')
    )
      return apiErrorResponse(422, 'invalid_input', requestId);
    const changed = await options.store.candidate({
      kind: 'candidate.alert_settings_set',
      expected_revision: expected,
      os_notification: value,
      now: options.now().toISOString(),
    });
    if (!changed.ok)
      return changed.outcome === 'rejected' &&
        changed.reasons.includes('settings_revision_conflict')
        ? apiErrorResponse(409, 'conflict', requestId)
        : apiErrorResponse(503, 'dependency_unavailable', requestId);
    options.changed?.();
    return { status: 200, body: settingsBody(changed.value) };
  };

  return {
    handlers: { getCandidateAlertSettings, changeCandidateAlertSettings },
  };
}

// --- 通知を出すかの判定と知らせ ---

export interface CandidateAlertsOptions {
  readonly store: Pick<DbWorkerClient, 'candidate'>;
  // 開いている購読へ知らせを渡し、渡せた購読の数を返す（NoticeRelay.publishCandidate）。
  readonly send: (message: StreamNoticeMessage) => number;
  // 記録しない会話の間か（保存境界の保持者）。分からなければ true を返す（安全側）。
  readonly privateConversation: () => boolean;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly log: (message: string) => void;
  // 判定をまとめて回す時機（既定は setImmediate。同じ取り込みの中の書込みを 1 回にまとめる）。試験は差し替える。
  readonly schedule?: (run: () => void) => void;
}

export interface CandidateAlerts {
  // DbWorkerClient.onCandidateWrite に渡す受け手。
  readonly observe: CandidateWriteListener;
  // 設定を変えたとき（端末へ数 0 の知らせを 1 通送る。切にしたときも、端末がトレイの件数を消せるように送る）。
  readonly settingsChanged: () => void;
  // 取り込みの 1 回（まとまり）。run の間の書込みは判定せずに溜め、終わり（例外でも）で 1 回だけ判定する。重なったまとまりは、
  // 最後のまとまりの終わりで判定する。
  batch<T>(run: () => Promise<T>): Promise<T>;
  // 溜まった判定と送信が終わるまで待つ（試験・停止）。
  idle(): Promise<void>;
}

interface Created {
  readonly notification_key: string;
  readonly initial_import: boolean;
}

export function createCandidateAlerts(
  options: CandidateAlertsOptions,
): CandidateAlerts {
  const schedule =
    options.schedule ??
    ((run: () => void) => {
      setImmediate(run);
    });
  let created: Created[] = [];
  let changed = false;
  let forced = false;
  let scheduled = false;
  let chain: Promise<void> = Promise.resolve();
  // 開いているまとまりの数。0 より大きい間は判定を始めない。
  let depth = 0;

  const kick = (): void => {
    if (scheduled || depth > 0) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      const batch = created;
      const anyChange = changed;
      const force = forced;
      created = [];
      changed = false;
      forced = false;
      chain = chain
        .then(() => flush(batch, anyChange, force))
        .catch(() => {
          options.log(
            '気づきの通知の判定に失敗しました（候補の保存には影響しません）。',
          );
        });
    });
  };

  const observe: CandidateWriteListener = (op, value) => {
    if (op.kind === 'candidate.create') {
      const result = value as CandidateOpValues['candidate.create'];
      if (result.result !== 'created') return;
      created.push({
        notification_key: op.input.notification_key,
        initial_import: op.input.initial_import,
      });
    }
    changed = true;
    kick();
  };

  const flush = async (
    batch: readonly Created[],
    anyChange: boolean,
    force: boolean,
  ): Promise<void> => {
    const read = await options.store.candidate({
      kind: 'candidate.alert_settings_get',
    });
    if (!read.ok) {
      options.log('気づきの通知の設定を読めませんでした（通知を出しません）。');
      return;
    }
    const settings = read.value;
    // 切: 通知もトレイの件数も出さないので、知らせを送らない（設定を変えた直後の 1 通を除く）。
    if (settings.os_notification !== 'on') {
      if (force) send(0);
      return;
    }
    const delivered: string[] = [];
    const skipped = new Map<string, number>();
    const skip = (reason: string): void => {
      skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
    };
    if (batch.length > 0 && options.privateConversation())
      skipped.set('private_conversation', batch.length);
    else
      for (const item of batch) {
        if (delivered.length >= CANDIDATE_ALERT_MAX) {
          skip('alert_limit');
          continue;
        }
        const records = await options.store.candidate({
          kind: 'candidate.alert_records',
          notification_key: item.notification_key,
        });
        if (!records.ok) {
          skip('records_unavailable');
          continue;
        }
        // 作った直後の候補の根拠は、いま読んだ元情報そのもの（valid）。新しい候補の判定では根拠を見ない（ADR 0117）。
        const decision = candidateAlertDecision({
          notification_key: item.notification_key,
          state: 'new',
          initial_import: item.initial_import,
          evidence: 'valid',
          trigger: 'new_candidate',
          reminder_id: null,
          existing: records.value.records,
        });
        if (!decision.deliver) {
          skip(decision.reason ?? 'not_delivered');
          continue;
        }
        const deliveryId = options.newId();
        const intent = await options.store.candidate({
          kind: 'candidate.alert_intent',
          input: {
            delivery_id: deliveryId,
            notification_key: item.notification_key,
            reminder_id: '',
            settings_revision: settings.settings_revision,
            intent_at: options.now().toISOString(),
          },
        });
        if (intent.ok) delivered.push(deliveryId);
        else
          skip(
            intent.outcome === 'unknown'
              ? 'intent_unknown'
              : (intent.reasons[0] ?? 'intent_rejected'),
          );
      }
    if (delivered.length === 0 && !anyChange && !force) return;
    const handed = send(delivered.length);
    for (const deliveryId of delivered) {
      const settled = await options.store.candidate({
        kind: 'candidate.alert_settle',
        delivery_id: deliveryId,
        status: handed > 0 ? 'delivered' : 'delivery_unknown',
      });
      if (!settled.ok) skip('settle_failed');
    }
    if (delivered.length > 0 || skipped.size > 0)
      options.log(
        `気づきの通知: 出す ${String(delivered.length)} 件（端末 ${String(handed)} 台）${[
          ...skipped,
        ]
          .map(([reason, count]) => `・${reason} ${String(count)} 件`)
          .join('')}。`,
      );
  };

  const send = (alertCount: number): number => {
    const notice: CandidateNotice = {
      schema: 'buddy.candidate-notice.v1',
      notice_id: options.newId(),
      occurred_at: options.now().toISOString(),
      alert_count: alertCount,
    };
    try {
      return options.send({ type: 'notice', notice });
    } catch {
      return 0;
    }
  };

  return {
    observe,
    settingsChanged: () => {
      forced = true;
      kick();
    },
    async batch<T>(run: () => Promise<T>): Promise<T> {
      depth += 1;
      try {
        return await run();
      } finally {
        depth -= 1;
        if (depth === 0 && (created.length > 0 || changed || forced)) kick();
      }
    },
    async idle() {
      // 予定した判定が始まるまで待ち、続いて溜まった判定の鎖が空になるまで待つ。
      for (;;) {
        const current = chain;
        await current;
        if (!scheduled && current === chain) return;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
    },
  };
}
